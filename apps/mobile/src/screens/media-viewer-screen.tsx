import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useVideoPlayer, VideoView } from "expo-video";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { RootStackParams } from "../navigation/types";

type Props = NativeStackScreenProps<RootStackParams, "MediaViewer">;

export function MediaViewerScreen({ navigation, route }: Props) {
  return (
    <SafeAreaView style={styles.page}>
      <Pressable
        accessibilityLabel="Close media viewer"
        hitSlop={8}
        style={styles.close}
        onPress={() => navigation.goBack()}
      >
        <Ionicons color="#ffffff" name="close" size={25} />
      </Pressable>
      {route.params.kind === "video" ? (
        <VideoMedia
          url={route.params.url}
          {...(route.params.posterUrl
            ? { posterUrl: route.params.posterUrl }
            : {})}
        />
      ) : (
        <Image
          accessibilityLabel={route.params.alt ?? "Message image"}
          contentFit="contain"
          source={{ uri: route.params.url }}
          style={styles.media}
          transition={180}
        />
      )}
      {route.params.alt ? (
        <View style={styles.caption}>
          <Text selectable style={styles.captionText}>
            {route.params.alt}
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function VideoMedia({
  url,
  posterUrl,
}: {
  readonly url: string;
  readonly posterUrl?: string;
}) {
  const player = useVideoPlayer(
    {
      uri: url,
      ...(posterUrl ? { metadata: { artwork: posterUrl } } : {}),
    },
    (instance) => {
      instance.play();
    },
  );
  return (
    <VideoView
      allowsPictureInPicture
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      nativeControls
      player={player}
      style={styles.media}
    />
  );
}

const styles = StyleSheet.create({
  caption: {
    backgroundColor: "rgba(0,0,0,0.58)",
    bottom: 16,
    left: 16,
    padding: 10,
    position: "absolute",
    right: 16,
  },
  captionText: {
    color: "#ffffff",
    fontFamily: "Inter",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  close: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.58)",
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    position: "absolute",
    right: 14,
    top: 14,
    width: 42,
    zIndex: 2,
  },
  media: { flex: 1, width: "100%" },
  page: { backgroundColor: "#000000", flex: 1 },
});
