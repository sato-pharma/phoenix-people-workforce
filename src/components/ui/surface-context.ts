"use client";

import { createContext, useContext } from "react";

// True when descendants render on the dark admin hero surface (the black
// command-center header). Primitives like Button and AdminInsightChip read this
// to pick legible-on-black styling. Defaults to false (light) so nothing changes
// anywhere except inside an AdminPageHero, which provides `true`.
export const DarkSurfaceContext = createContext(false);

export function useDarkSurface() {
  return useContext(DarkSurfaceContext);
}
