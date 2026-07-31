import "react-native-gesture-handler";

import { useFonts } from "expo-font";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  navigationRef,
  RootNavigation,
} from "./src/navigation/root-navigation";
import { useAppStore } from "./src/state/app-store";
import { ChannelSectionSyncRuntime } from "./src/state/channel-section-sync";
import { RelayProvider } from "./src/state/relay-context";
import { ReminderNotificationSync } from "./src/state/reminder-notification-sync";
import { ObserverRuntime } from "./src/state/observer-state";
import { useBuzzTheme } from "./src/ui/theme";

void SplashScreen.preventAutoHideAsync();
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    GeistMono: require("./assets/fonts/GeistMono-Variable.ttf"),
    Inter: require("./assets/fonts/InterVariable.ttf"),
  });
  const initialize = useAppStore((state) => state.initialize);
  const ready = useAppStore((state) => state.ready);
  const active = useAppStore((state) => state.active);
  const error = useAppStore((state) => state.error);
  const clearError = useAppStore((state) => state.clearError);
  const theme = useBuzzTheme();

  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    if ((fontsLoaded || fontError) && ready) {
      void SplashScreen.hideAsync();
    }
  }, [fontError, fontsLoaded, ready]);
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const channelId =
        typeof data?.channelId === "string" ? data.channelId : undefined;
      const eventId =
        typeof data?.eventId === "string" ? data.eventId : undefined;
      if (active && channelId && navigationRef.isReady()) {
        navigationRef.navigate("Channel", {
          channelId,
          ...(eventId ? { focusEventId: eventId } : {}),
        });
      }
    };
    const subscription =
      Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open);
    return () => subscription.remove();
  }, [active]);

  if ((!fontsLoaded && !fontError) || !ready) return null;
  const navigation = (
    <RootNavigation
      key={active?.id ?? "unauthenticated"}
      authenticated={Boolean(active)}
    />
  );
  return (
    <SafeAreaProvider>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      {active ? (
        <RelayProvider community={active}>
          <ChannelSectionSyncRuntime />
          <ObserverRuntime />
          <ReminderNotificationSync />
          {navigation}
        </RelayProvider>
      ) : (
        navigation
      )}
      {error ? (
        <View
          accessibilityLiveRegion="polite"
          style={[
            styles.error,
            {
              backgroundColor: theme.colors.danger,
            },
          ]}
        >
          <Text
            numberOfLines={2}
            style={{
              color: "#ffffff",
              flex: 1,
              fontFamily: "Inter",
              fontSize: 12,
            }}
          >
            {error}
          </Text>
          <Text
            accessibilityRole="button"
            style={{
              color: "#ffffff",
              fontFamily: "GeistMono",
              fontSize: 10,
              fontWeight: "700",
            }}
            onPress={clearError}
          >
            DISMISS
          </Text>
        </View>
      ) : null}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  error: {
    alignItems: "center",
    borderRadius: 12,
    bottom: 84,
    elevation: 20,
    flexDirection: "row",
    gap: 12,
    left: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    position: "absolute",
    right: 14,
  },
});
