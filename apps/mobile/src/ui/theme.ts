import { useColorScheme } from "react-native";

import { useAppStore } from "../state/app-store";

export type BuzzTheme = {
  readonly dark: boolean;
  readonly colors: {
    readonly background: string;
    readonly surface: string;
    readonly elevated: string;
    readonly text: string;
    readonly muted: string;
    readonly faint: string;
    readonly border: string;
    readonly accent: string;
    readonly accentSoft: string;
    readonly danger: string;
    readonly success: string;
    readonly warning: string;
  };
  readonly spacing: {
    readonly xs: 4;
    readonly sm: 8;
    readonly md: 12;
    readonly lg: 16;
    readonly xl: 24;
    readonly xxl: 32;
  };
  readonly radii: {
    readonly sm: 8;
    readonly md: 14;
    readonly lg: 22;
    readonly pill: 999;
  };
};

export function useBuzzTheme(): BuzzTheme {
  const system = useColorScheme();
  const mode = useAppStore((state) => state.themeMode);
  const accent = useAppStore((state) => state.accent);
  const dark = mode === "dark" || (mode === "system" && system === "dark");
  return {
    colors: dark
      ? {
          accent,
          accentSoft: withAlpha(accent, "22"),
          background: "#0d1012",
          border: "#293034",
          danger: "#ff6b6b",
          elevated: "#1c2226",
          faint: "#657076",
          muted: "#a3aaad",
          success: "#44c997",
          surface: "#14191c",
          text: "#f4f1e9",
          warning: "#f5a524",
        }
      : {
          accent,
          accentSoft: withAlpha(accent, "1f"),
          background: "#f3efe7",
          border: "#d8d0c3",
          danger: "#c43e3e",
          elevated: "#fffdf8",
          faint: "#9b958b",
          muted: "#67645f",
          success: "#14855d",
          surface: "#faf7f0",
          text: "#17191a",
          warning: "#b96700",
        },
    dark,
    radii: { lg: 22, md: 14, pill: 999, sm: 8 },
    spacing: { lg: 16, md: 12, sm: 8, xl: 24, xs: 4, xxl: 32 },
  };
}

function withAlpha(hex: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex;
}
