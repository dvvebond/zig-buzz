import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { PairingController } from "../services/pairing-controller";
import { Button, Card, Page } from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

export function PairingScreen({
  initialValue,
  onClose,
}: {
  readonly initialValue?: string;
  readonly onClose?: () => void;
}) {
  const theme = useBuzzTheme();
  const controller = useMemo(() => new PairingController(), []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [value, setValue] = useState(initialValue ?? "");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (initialValue) {
      setValue(initialValue);
      void controller.pair(initialValue);
    }
  }, [controller, initialValue]);

  const beginScan = async () => {
    if (!permission?.granted) {
      const granted = await requestPermission();
      if (!granted.granted) return;
    }
    setScanning(true);
  };

  if (scanning) {
    return (
      <View style={styles.cameraPage}>
        <CameraView
          barcodeScannerSettings={{
            barcodeTypes: ["qr"],
          }}
          style={StyleSheet.absoluteFill}
          onBarcodeScanned={(result) => {
            setScanning(false);
            setValue(result.data);
            void controller.pair(result.data);
          }}
        />
        <View style={styles.cameraOverlay}>
          <View
            style={[styles.scanFrame, { borderColor: theme.colors.accent }]}
          />
          <Text style={[styles.scanLabel, { color: "#ffffff" }]}>
            Align the one-time pairing code
          </Text>
          <Button
            label="Cancel"
            variant="secondary"
            onPress={() => setScanning(false)}
          />
        </View>
      </View>
    );
  }

  return (
    <Page scroll contentContainerStyle={styles.page}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.hero}>
          <View
            style={[
              styles.signalMark,
              {
                backgroundColor: theme.colors.accentSoft,
                borderColor: theme.colors.accent,
              },
            ]}
          >
            <Ionicons color={theme.colors.accent} name="radio" size={34} />
          </View>
          <Text
            style={[
              styles.wordmark,
              { color: theme.colors.text, fontFamily: "Inter" },
            ]}
          >
            Buzz
          </Text>
          <Text
            style={[
              styles.kicker,
              { color: theme.colors.accent, fontFamily: "GeistMono" },
            ]}
          >
            SECURE COMMUNITY SIGNAL
          </Text>
          <Text
            style={[
              styles.heroCopy,
              { color: theme.colors.muted, fontFamily: "Inter" },
            ]}
          >
            Scan the code shown on your trusted device. Both screens verify the
            same six digits before any identity material moves.
          </Text>
        </View>

        <Card style={styles.pairingCard}>
          {state.status === "confirming" || state.status === "transferring" ? (
            <View style={styles.sas}>
              <Text
                style={[
                  styles.cardEyebrow,
                  { color: theme.colors.warning, fontFamily: "GeistMono" },
                ]}
              >
                SECURITY CHECK
              </Text>
              <Text
                selectable
                style={[
                  styles.sasCode,
                  { color: theme.colors.text, fontFamily: "GeistMono" },
                ]}
              >
                {state.sasCode.slice(0, 3)} {state.sasCode.slice(3)}
              </Text>
              <Text
                style={[
                  styles.explanation,
                  { color: theme.colors.muted, fontFamily: "Inter" },
                ]}
              >
                Compare these digits with the source device. A mismatch can
                indicate interception.
              </Text>
              {state.status === "confirming" ? (
                <View style={styles.buttonStack}>
                  <Button
                    icon="shield-checkmark-outline"
                    label="Codes match"
                    onPress={() => controller.confirmSas()}
                  />
                  <Button
                    label="They do not match"
                    variant="danger"
                    onPress={() => controller.denySas()}
                  />
                </View>
              ) : (
                <View style={styles.transfer}>
                  <Ionicons
                    color={theme.colors.accent}
                    name="lock-closed-outline"
                    size={20}
                  />
                  <Text
                    style={{
                      color: theme.colors.muted,
                      fontFamily: "Inter",
                      fontSize: 14,
                    }}
                  >
                    Receiving encrypted credentials…
                  </Text>
                </View>
              )}
            </View>
          ) : state.status === "success" ? (
            <View style={styles.sas}>
              <Ionicons
                color={theme.colors.success}
                name="checkmark-circle"
                size={52}
              />
              <Text
                style={[
                  styles.cardTitle,
                  { color: theme.colors.text, fontFamily: "Inter" },
                ]}
              >
                Community connected
              </Text>
              <Text
                style={[
                  styles.explanation,
                  { color: theme.colors.muted, fontFamily: "Inter" },
                ]}
              >
                Your key is stored in this device’s protected credential vault.
              </Text>
              {onClose ? <Button label="Done" onPress={onClose} /> : null}
            </View>
          ) : (
            <>
              <Text
                style={[
                  styles.cardTitle,
                  { color: theme.colors.text, fontFamily: "Inter" },
                ]}
              >
                Connect this device
              </Text>
              <Text
                style={[
                  styles.cardBody,
                  { color: theme.colors.muted, fontFamily: "Inter" },
                ]}
              >
                NIP-AB uses an ephemeral key, a 120-second session, NIP-44
                encryption, and a human-verifiable transcript.
              </Text>
              <Button
                icon="qr-code-outline"
                label="Scan pairing code"
                onPress={() => void beginScan()}
              />
              <View style={styles.orRow}>
                <View
                  style={[
                    styles.rule,
                    { backgroundColor: theme.colors.border },
                  ]}
                />
                <Text
                  style={{
                    color: theme.colors.faint,
                    fontFamily: "GeistMono",
                    fontSize: 10,
                  }}
                >
                  OR PASTE
                </Text>
                <View
                  style={[
                    styles.rule,
                    { backgroundColor: theme.colors.border },
                  ]}
                />
              </View>
              <View
                style={[
                  styles.inputShell,
                  {
                    backgroundColor: theme.colors.elevated,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={16_384}
                  multiline
                  placeholder="nostrpair://… or buzz://…"
                  placeholderTextColor={theme.colors.faint}
                  style={[
                    styles.input,
                    { color: theme.colors.text, fontFamily: "GeistMono" },
                  ]}
                  value={value}
                  onChangeText={setValue}
                />
                <Pressable
                  accessibilityLabel="Paste pairing code"
                  hitSlop={8}
                  onPress={() => void Clipboard.getStringAsync().then(setValue)}
                >
                  <Ionicons
                    color={theme.colors.muted}
                    name="clipboard-outline"
                    size={20}
                  />
                </Pressable>
              </View>
              <Button
                disabled={!value.trim()}
                label="Connect securely"
                loading={state.status === "connecting"}
                variant="secondary"
                onPress={() => void controller.pair(value)}
              />
              {state.status === "error" ? (
                <View
                  style={[
                    styles.error,
                    {
                      backgroundColor: `${theme.colors.danger}14`,
                      borderColor: theme.colors.danger,
                    },
                  ]}
                >
                  <Ionicons
                    color={theme.colors.danger}
                    name="alert-circle-outline"
                    size={20}
                  />
                  <Text
                    style={{
                      color: theme.colors.danger,
                      flex: 1,
                      fontFamily: "Inter",
                      fontSize: 13,
                      lineHeight: 18,
                    }}
                  >
                    {state.message}
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </Card>

        <View style={styles.trustRow}>
          {[
            ["arrow-up-circle-outline", "Outbound only"],
            ["timer-outline", "120 seconds"],
            ["key-outline", "Device vault"],
          ].map(([icon, label]) => (
            <View key={label} style={styles.trustItem}>
              <Ionicons
                color={theme.colors.faint}
                name={icon as React.ComponentProps<typeof Ionicons>["name"]}
                size={15}
              />
              <Text
                style={{
                  color: theme.colors.faint,
                  fontFamily: "GeistMono",
                  fontSize: 9,
                }}
              >
                {label}
              </Text>
            </View>
          ))}
        </View>
      </KeyboardAvoidingView>
    </Page>
  );
}

const styles = StyleSheet.create({
  buttonStack: { gap: 10, width: "100%" },
  cameraOverlay: {
    alignItems: "center",
    backgroundColor: "#00000066",
    flex: 1,
    gap: 24,
    justifyContent: "center",
    padding: 24,
  },
  cameraPage: { backgroundColor: "#000", flex: 1 },
  cardBody: { fontSize: 14, lineHeight: 21, marginBottom: 4 },
  cardEyebrow: { fontSize: 10, fontWeight: "700", letterSpacing: 1.4 },
  cardTitle: { fontSize: 20, fontWeight: "700" },
  error: {
    alignItems: "flex-start",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 9,
    padding: 12,
  },
  explanation: {
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 320,
    textAlign: "center",
  },
  hero: { alignItems: "center", marginBottom: 28, paddingHorizontal: 12 },
  heroCopy: {
    fontSize: 15,
    lineHeight: 22,
    marginTop: 18,
    maxWidth: 360,
    textAlign: "center",
  },
  input: { flex: 1, fontSize: 11, lineHeight: 16, maxHeight: 72 },
  inputShell: {
    alignItems: "center",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    minHeight: 54,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  kicker: { fontSize: 9, fontWeight: "700", letterSpacing: 2.1, marginTop: 3 },
  orRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  page: { paddingHorizontal: 18, paddingTop: 48 },
  pairingCard: {
    gap: 16,
    marginHorizontal: "auto",
    maxWidth: 440,
    width: "100%",
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  sas: { alignItems: "center", gap: 16, paddingVertical: 8 },
  sasCode: { fontSize: 42, fontWeight: "700", letterSpacing: 5 },
  scanFrame: {
    borderRadius: 28,
    borderWidth: 3,
    height: 260,
    width: 260,
  },
  scanLabel: { fontFamily: "Inter", fontSize: 16, fontWeight: "600" },
  signalMark: {
    alignItems: "center",
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    height: 64,
    justifyContent: "center",
    marginBottom: 12,
    transform: [{ rotate: "-4deg" }],
    width: 64,
  },
  transfer: { alignItems: "center", flexDirection: "row", gap: 8 },
  trustItem: { alignItems: "center", flexDirection: "row", gap: 5 },
  trustRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    justifyContent: "center",
    paddingVertical: 24,
  },
  wordmark: { fontSize: 38, fontWeight: "800", letterSpacing: -1.6 },
});
