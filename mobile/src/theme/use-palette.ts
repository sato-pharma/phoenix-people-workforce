import { useColorScheme } from "react-native";

import { palettes, type PhoenixPalette } from "./tokens";

/**
 * The active palette for this device's light/dark setting.
 *
 * A hook rather than a context because there is nothing to configure: the app follows the OS, the
 * same way the portal follows `prefers-color-scheme`. If a manual theme switch is ever added it
 * goes here and every screen picks it up without changing a line.
 */
export function usePalette(): PhoenixPalette {
  return useColorScheme() === "dark" ? palettes.dark : palettes.light;
}
