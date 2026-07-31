import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { KIND_EVENT_REMINDER } from "@buzz/core";

import {
  assertReminderTarget,
  encryptReminderContent,
  randomReminderId,
  type Reminder,
  type ReminderContent,
  type ReminderTarget,
} from "../domain/reminders";
import type { Community } from "../domain/models";
import type { MobileRelay } from "./mobile-relay";

const NOTIFICATION_KEY_PREFIX = "buzz.mobile.reminder-notifications.v1";
const MAX_SCHEDULED = 64;

export async function createReminder(input: {
  readonly relay: MobileRelay;
  readonly community: Community;
  readonly secretKey: Uint8Array;
  readonly target: ReminderTarget;
  readonly notBefore: number;
  readonly note?: string;
}): Promise<Reminder> {
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(input.notBefore) ||
    input.notBefore < now ||
    input.notBefore > now + 365 * 86_400
  ) {
    throw new RangeError(
      "reminder time is outside the supported one-year window",
    );
  }
  const target = assertReminderTarget(input.target);
  const id = randomReminderId();
  const content: ReminderContent = {
    status: "pending",
    target,
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 8_192) } : {}),
  };
  const event = await input.relay.publish({
    content: encryptReminderContent(
      content,
      input.secretKey,
      input.community.pubkey,
    ),
    kind: KIND_EVENT_REMINDER,
    tags: [
      ["d", id],
      ["not_before", String(input.notBefore)],
    ],
  });
  const reminder: Reminder = {
    content,
    createdAt: event.created_at,
    eventId: event.id,
    id,
    notBefore: input.notBefore,
  };
  await scheduleOne(input.community, reminder, true).catch(() => undefined);
  return reminder;
}

export async function replaceReminder(input: {
  readonly relay: MobileRelay;
  readonly community: Community;
  readonly secretKey: Uint8Array;
  readonly reminder: Reminder;
  readonly status: "pending" | "done" | "cancelled";
  readonly notBefore?: number;
}): Promise<Reminder> {
  if (
    input.status === "pending" &&
    (!Number.isSafeInteger(input.notBefore) ||
      (input.notBefore ?? 0) < Math.floor(Date.now() / 1_000))
  ) {
    throw new RangeError("snooze time must be in the future");
  }
  const content: ReminderContent = {
    ...input.reminder.content,
    status: input.status,
  };
  const tags: string[][] = [["d", input.reminder.id]];
  if (input.status === "pending") {
    tags.push(["not_before", String(input.notBefore)]);
  } else {
    tags.push(["expiration", String(jitteredExpiration())]);
  }
  const event = await input.relay.publish(
    {
      content: encryptReminderContent(
        content,
        input.secretKey,
        input.community.pubkey,
      ),
      kind: KIND_EVENT_REMINDER,
      tags,
    },
    Math.max(Math.floor(Date.now() / 1_000), input.reminder.createdAt + 1),
  );
  const replacement: Reminder = {
    content,
    createdAt: event.created_at,
    eventId: event.id,
    id: input.reminder.id,
    ...(input.status === "pending" && input.notBefore !== undefined
      ? { notBefore: input.notBefore }
      : {}),
  };
  await scheduleOne(input.community, replacement, false).catch(() => undefined);
  return replacement;
}

export async function syncReminderNotifications(
  community: Community,
  reminders: readonly Reminder[],
): Promise<void> {
  if (Platform.OS === "web") return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  const active = reminders
    .filter(
      (reminder) =>
        reminder.content.status === "pending" &&
        reminder.notBefore !== undefined,
    )
    .slice(0, MAX_SCHEDULED);
  const state = await readNotificationState(community);
  const activeIds = new Set(active.map((reminder) => reminder.id));
  for (const [reminderId, notificationId] of Object.entries(state)) {
    if (!activeIds.has(reminderId)) {
      await Notifications.cancelScheduledNotificationAsync(
        notificationId,
      ).catch(() => undefined);
      delete state[reminderId];
    }
  }
  for (const reminder of active) {
    if (!state[reminder.id]) {
      state[reminder.id] = await scheduleNotification(reminder);
    }
  }
  await writeNotificationState(community, state);
}

function notificationKey(community: Community): string {
  return `${NOTIFICATION_KEY_PREFIX}:${community.id}:${community.pubkey}`;
}

async function scheduleOne(
  community: Community,
  reminder: Reminder,
  requestPermission: boolean,
): Promise<void> {
  if (Platform.OS === "web") return;
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && requestPermission) {
    permission = await Notifications.requestPermissionsAsync();
  }
  const state = await readNotificationState(community);
  const prior = state[reminder.id];
  if (prior) {
    await Notifications.cancelScheduledNotificationAsync(prior).catch(
      () => undefined,
    );
    delete state[reminder.id];
  }
  if (
    permission.granted &&
    reminder.content.status === "pending" &&
    reminder.notBefore !== undefined
  ) {
    state[reminder.id] = await scheduleNotification(reminder);
  }
  await writeNotificationState(community, state);
}

async function scheduleNotification(reminder: Reminder): Promise<string> {
  const target = reminder.content.target;
  return await Notifications.scheduleNotificationAsync({
    content: {
      body:
        reminder.content.note ||
        target?.preview ||
        "A saved Buzz reminder is due.",
      data: {
        channelId: target?.channelId ?? "",
        eventId: target?.eventId ?? "",
        reminderId: reminder.id,
      },
      sound: "default",
      title: "Buzz reminder",
    },
    trigger: {
      date: new Date(
        Math.max(
          Date.now() + 1_000,
          (reminder.notBefore ?? Math.floor(Date.now() / 1_000) + 1) * 1_000,
        ),
      ),
      type: Notifications.SchedulableTriggerInputTypes.DATE,
    },
  });
}

async function readNotificationState(
  community: Community,
): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(notificationKey(community));
  if (!raw || raw.length > 64 * 1024) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, id] of Object.entries(value).slice(0, MAX_SCHEDULED)) {
      if (
        /^[0-9a-f]{32}$/.test(key) &&
        typeof id === "string" &&
        id.length <= 256
      ) {
        result[key] = id;
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function writeNotificationState(
  community: Community,
  value: Record<string, string>,
): Promise<void> {
  await AsyncStorage.setItem(notificationKey(community), JSON.stringify(value));
}

function jitteredExpiration(): number {
  return (
    Math.floor(Date.now() / 1_000) +
    (30 + Math.floor(Math.random() * 60)) * 86_400
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
