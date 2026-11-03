"use client";

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";

import { firstReadArrived, type CrmFirstRead } from "@/lib/phoenix-crm/first-read";

const CrmFirstReadContext = createContext<CrmFirstRead | null>(null);

/**
 * Carries the page's first read down to whichever tab asks for it (`useCrmGet`, src/lib/phoenix-crm/first-read.ts).
 * Held from the first render only: a refresh renders the page again, and by then the screen has its data.
 *
 * `.ts` and no JSX because api.ts imports it, and the test runner loads api.ts with no JSX support.
 */
export function CrmFirstReadProvider({ children, firstRead }: { children: ReactNode; firstRead: CrmFirstRead | null }) {
  const [held] = useState(firstRead);
  useEffect(() => {
    firstReadArrived(held, firstRead);
  }, [firstRead, held]);
  return createElement(CrmFirstReadContext.Provider, { value: held }, children);
}

export function useCrmFirstRead(): CrmFirstRead | null {
  return useContext(CrmFirstReadContext);
}
