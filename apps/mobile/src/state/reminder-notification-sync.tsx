import { useEffect } from "react";

import { syncReminderNotifications } from "../services/reminders";
import { useReminders } from "./queries";
import { useRelay } from "./relay-context";

export function ReminderNotificationSync() {
  const { community } = useRelay();
  const reminders = useReminders();
  useEffect(() => {
    if (reminders.data) {
      void syncReminderNotifications(community, reminders.data);
    }
  }, [community, reminders.data]);
  return null;
}
