"use client";

import { createContext, type ReactNode } from "react";

/**
 * The list an opened CV sits in, in the order it is drawn — what Previous and Next walk (owner,
 * 2026-11-10: "god mode enhancements" on My Candidates).
 *
 * Each list on the page wraps its own cards: the CVs sent to him, one shelf folder, one area folder,
 * his open positions. Next never jumps from one list into another, because the next card in a
 * different section is somewhere he did not choose to read — and a closed folder's cards are not on
 * the screen at all. Its own module so the folder sections can provide it without importing the page.
 */
export const ManagerCvListContext = createContext<readonly string[] | null>(null);

export function ManagerCvList({ children, ids }: { children: ReactNode; ids: readonly string[] }) {
  return <ManagerCvListContext.Provider value={ids}>{children}</ManagerCvListContext.Provider>;
}
