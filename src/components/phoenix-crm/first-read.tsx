"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import type { CrmFirstRead } from "@/lib/phoenix-crm/first-read";

const CrmFirstReadContext = createContext<CrmFirstRead | null>(null);

/**
 * Carries the page's first read down to whichever tab asks for it (`useCrmGet`, src/lib/phoenix-crm/first-read.ts).
 * Held from the first render only: a refresh renders the page again, and by then the screen has its data.
 */
export function CrmFirstReadProvider({ children, firstRead }: { children: ReactNode; firstRead: CrmFirstRead | null }) {
  const [held] = useState(firstRead);
  return <CrmFirstReadContext.Provider value={held}>{children}</CrmFirstReadContext.Provider>;
}

export function useCrmFirstRead(): CrmFirstRead | null {
  return useContext(CrmFirstReadContext);
}
