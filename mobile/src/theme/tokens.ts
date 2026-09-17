import type { TextStyle } from "react-native";

/**
 * Phoenix design tokens for the native app.
 *
 * Transcribed from `src/styles/tokens.css` in the web app — same hex values, light and dark, so a
 * screen here and the same screen in the portal are the same colour. When a token changes there it
 * must change here; there is no shared stylesheet a React Native app can read, and a second palette
 * invented for mobile is exactly how two products that are meant to be one start to drift.
 *
 * RADIUS IS ZERO AND MUST STAY ZERO. The square-edge rule is an owner rule, not a preference: no
 * round or semi-round corners anywhere in this system. It is written as a named token rather than
 * simply omitted so that a component reaching for `radius` gets 0 instead of inventing an 8.
 */

export type PhoenixPalette = {
  /** The page behind everything. */
  paper: string;
  paper2: string;
  /** What sits on the page — cards, rows, sheets. */
  surface: string;
  surface2: string;
  /** Body ink. Never pure black. */
  ink: string;
  ink2: string;
  inkSoft: string;
  inkFaint: string;
  /** Hairline for structure, strong rule for emphasis. */
  line: string;
  lineStrong: string;
  /** Phoenix orange. */
  accent: string;
  accentPress: string;
  accentSoft: string;
  accentLine: string;
  accentInk: string;
  /** States. */
  danger: string;
  dangerSoft: string;
  success: string;
};

const light: PhoenixPalette = {
  paper: "#f7f6f3",
  paper2: "#f1efea",
  surface: "#ffffff",
  surface2: "#fbfaf8",
  ink: "#0d1015",
  ink2: "#383d45",
  inkSoft: "#6b7078",
  inkFaint: "#9aa0a8",
  line: "#e0dcd4",
  lineStrong: "#c9c4ba",
  accent: "#f97316",
  accentPress: "#c2410c",
  accentSoft: "#fff2e8",
  accentLine: "#fbcfa8",
  accentInk: "#ffffff",
  danger: "#b42318",
  dangerSoft: "#fef3f2",
  success: "#067647",
};

const dark: PhoenixPalette = {
  paper: "#0e1014",
  paper2: "#14161b",
  surface: "#181b21",
  surface2: "#1e2229",
  ink: "#eceae6",
  ink2: "#b4b1ab",
  inkSoft: "#8a8781",
  inkFaint: "#63615c",
  line: "#2a2d34",
  lineStrong: "#3d414a",
  // The orange holds on a dark ground; the tint pair does not, so -soft and -line are rebuilt
  // rather than inverted — same reasoning, same values, as the web tokens.
  accent: "#fb8534",
  accentPress: "#ea580c",
  accentSoft: "#2a1b10",
  accentLine: "#4a2d17",
  accentInk: "#12100e",
  danger: "#f97066",
  dangerSoft: "#2a1512",
  success: "#75e0a7",
};

export const palettes = { dark, light } as const;

/** Every corner in this app. Zero, by owner rule. */
export const radius = 0;

/** 4px base step, matching the web scale. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Type scale. Sizes are points, not the web's rem — the values are chosen to read at the same
 * optical weight on a phone as the portal does on a laptop, which is not the same as matching px.
 */
// `satisfies` rather than `as const`: it still checks every value against TextStyle and keeps the
// string literals narrow, but leaves `fontVariant` a mutable array. `as const` freezes it to a
// readonly tuple, which React Native's TextStyle rejects outright.
export const type = {
  display: { fontSize: 28, fontWeight: "700", letterSpacing: -0.4 },
  title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.2 },
  heading: { fontSize: 16, fontWeight: "600" },
  body: { fontSize: 15, fontWeight: "400" },
  bodyStrong: { fontSize: 15, fontWeight: "600" },
  meta: { fontSize: 13, fontWeight: "400" },
  /** Micro label — uppercase, tracked, for section captions. */
  micro: { fontSize: 11, fontWeight: "600", letterSpacing: 0.8 },
  /** Big figures on a stat tile. Tabular so columns of numbers line up. */
  figure: { fontSize: 26, fontWeight: "700", fontVariant: ["tabular-nums"] },
} satisfies Record<string, TextStyle>;

/** Hairline weight used for the border-first layout the portal uses. */
export const hairline = 1;
