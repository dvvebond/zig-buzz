import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useEffect, useRef } from "react";
import { Linking, Platform, StyleSheet } from "react-native";

import { parseDeepLink } from "../domain/deep-links";
import { AgentActivityScreen } from "../screens/agent-activity-screen";
import { ChannelSectionsScreen } from "../screens/channel-sections-screen";
import { MediaViewerScreen } from "../screens/media-viewer-screen";
import { ChannelScreen, ThreadScreen } from "../screens/channel-screen";
import { ChannelsScreen } from "../screens/channels-screen";
import {
  ActivityScreen,
  PulseScreen,
  SearchScreen,
} from "../screens/feed-screens";
import {
  CanvasScreen,
  CreateChannelScreen,
  MembersScreen,
  ProfileScreen,
} from "../screens/manage-screens";
import { PairingScreen } from "../screens/pairing-screen";
import {
  ComposeNoteScreen,
  InviteScreen,
  SettingsScreen,
} from "../screens/settings-screen";
import { useBuzzTheme } from "../ui/theme";
import type { MainTabParams, RootStackParams } from "./types";

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
export const navigationRef = createNavigationContainerRef<RootStackParams>();

export function RootNavigation({
  authenticated,
}: {
  readonly authenticated: boolean;
}) {
  const theme = useBuzzTheme();
  const pendingUrl = useRef<string | undefined>(undefined);
  const dispatchRef = useRef<(url: string) => void>(() => undefined);
  useEffect(() => {
    const dispatch = (url: string) => {
      if (!navigationRef.isReady()) {
        pendingUrl.current = url;
        return;
      }
      const link = parseDeepLink(url);
      if (!link) return;
      if (link.type === "pairing") {
        navigationRef.navigate("Pairing", { initialValue: link.uri });
      } else if (link.type === "invite") {
        navigationRef.navigate("Invite", {
          code: link.code,
          relayUrl: link.relayUrl,
          ...(link.policyReceipt === undefined
            ? {}
            : { policyReceipt: link.policyReceipt }),
        });
      } else if (authenticated) {
        if (link.threadRootId) {
          navigationRef.navigate("Thread", {
            channelId: link.channelId,
            rootId: link.threadRootId,
          });
        } else {
          navigationRef.navigate("Channel", {
            channelId: link.channelId,
            focusEventId: link.messageId,
          });
        }
      }
    };
    dispatchRef.current = dispatch;
    void Linking.getInitialURL().then((url) => {
      if (url) dispatch(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) =>
      dispatch(url),
    );
    return () => subscription.remove();
  }, [authenticated]);

  const baseTheme = theme.dark ? DarkTheme : DefaultTheme;
  return (
    <NavigationContainer
      ref={navigationRef}
      theme={{
        ...baseTheme,
        colors: {
          ...baseTheme.colors,
          background: theme.colors.background,
          border: theme.colors.border,
          card: theme.colors.surface,
          notification: theme.colors.danger,
          primary: theme.colors.accent,
          text: theme.colors.text,
        },
      }}
      onReady={() => {
        const url = pendingUrl.current;
        pendingUrl.current = undefined;
        if (url) dispatchRef.current(url);
      }}
    >
      <Stack.Navigator
        initialRouteName={authenticated ? "Tabs" : "Pairing"}
        screenOptions={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: theme.colors.background },
          headerShown: false,
        }}
      >
        {authenticated ? (
          <>
            <Stack.Screen component={MainTabs} name="Tabs" />
            <Stack.Screen component={ChannelScreen} name="Channel" />
            <Stack.Screen component={ThreadScreen} name="Thread" />
            <Stack.Screen
              component={CreateChannelScreen}
              name="CreateChannel"
              options={{ presentation: "modal" }}
            />
            <Stack.Screen component={MembersScreen} name="Members" />
            <Stack.Screen component={CanvasScreen} name="Canvas" />
            <Stack.Screen component={SettingsScreen} name="Settings" />
            <Stack.Screen
              component={ChannelSectionsScreen}
              name="ChannelSections"
            />
            <Stack.Screen component={ProfileScreen} name="Profile" />
            <Stack.Screen
              component={AgentActivityScreen}
              name="AgentActivity"
            />
            <Stack.Screen
              component={MediaViewerScreen}
              name="MediaViewer"
              options={{ animation: "fade", presentation: "fullScreenModal" }}
            />
            <Stack.Screen
              component={ComposeNoteScreen}
              name="ComposeNote"
              options={{ presentation: "modal" }}
            />
          </>
        ) : null}
        <Stack.Screen
          name="Pairing"
          options={{ animation: "fade", presentation: "fullScreenModal" }}
        >
          {({ navigation, route }) => (
            <PairingScreen
              {...(route.params?.initialValue === undefined
                ? {}
                : { initialValue: route.params.initialValue })}
              {...(authenticated ? { onClose: () => navigation.goBack() } : {})}
            />
          )}
        </Stack.Screen>
        <Stack.Screen
          component={InviteScreen}
          name="Invite"
          options={{ presentation: "modal" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function MainTabs() {
  const theme = useBuzzTheme();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarBackground: () => (
          <BlurView
            intensity={Platform.OS === "ios" ? 65 : 0}
            style={StyleSheet.absoluteFill}
            tint={theme.dark ? "dark" : "light"}
          />
        ),
        tabBarIcon: ({ color, focused, size }) => (
          <Ionicons
            color={color}
            name={tabIcon(route.name, focused)}
            size={size}
          />
        ),
        tabBarInactiveTintColor: theme.colors.faint,
        tabBarLabelStyle: {
          fontFamily: "GeistMono",
          fontSize: 9,
          fontWeight: "600",
          marginTop: -2,
        },
        tabBarStyle: {
          backgroundColor:
            Platform.OS === "ios" ? "transparent" : theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: 27,
          borderTopWidth: StyleSheet.hairlineWidth,
          bottom: 14,
          elevation: 12,
          height: 58,
          left: 28,
          overflow: "hidden",
          paddingBottom: 5,
          paddingTop: 5,
          position: "absolute",
          right: 28,
          shadowColor: "#000",
          shadowOffset: { height: 8, width: 0 },
          shadowOpacity: theme.dark ? 0.42 : 0.14,
          shadowRadius: 18,
        },
      })}
    >
      <Tabs.Screen component={ChannelsScreen} name="Channels" />
      <Tabs.Screen component={ActivityScreen} name="Activity" />
      <Tabs.Screen component={PulseScreen} name="Pulse" />
      <Tabs.Screen component={SearchScreen} name="Search" />
    </Tabs.Navigator>
  );
}

function tabIcon(
  route: keyof MainTabParams,
  focused: boolean,
): React.ComponentProps<typeof Ionicons>["name"] {
  if (route === "Channels") {
    return focused ? "chatbubbles" : "chatbubbles-outline";
  }
  if (route === "Activity") {
    return focused ? "notifications" : "notifications-outline";
  }
  if (route === "Pulse") return focused ? "pulse" : "pulse-outline";
  return focused ? "search" : "search-outline";
}
