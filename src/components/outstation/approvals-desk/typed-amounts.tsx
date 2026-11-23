"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { TypedAmounts } from "@/lib/outstation/approvals/desk-view";

/**
 * What he typed in each row's amount box, held for the whole desk rather than inside the row — so
 * "Approve all" and "Approve N" pay what each box says, not the row's untouched Approve (code review,
 * 24 Nov 2026: a box reading 850 on a 1,200 claim was paid 1,200 by the batch). Screen state only:
 * nothing here is saved, and an entry counts only for the claim version it was typed on.
 */
type TypedAmountsStore = {
  amounts: TypedAmounts;
  setAmount: (requestId: number, revision: string, text: string) => void;
};

const TypedAmountsContext = createContext<TypedAmountsStore | null>(null);

export function TypedAmountsProvider({ children }: { children: ReactNode }) {
  const [amounts, setAmounts] = useState<TypedAmounts>(() => new Map());
  const setAmount = useCallback((requestId: number, revision: string, text: string) => {
    setAmounts((current) => new Map(current).set(requestId, { revision, text }));
  }, []);
  const store = useMemo(() => ({ amounts, setAmount }), [amounts, setAmount]);
  return <TypedAmountsContext.Provider value={store}>{children}</TypedAmountsContext.Provider>;
}

const EMPTY: TypedAmounts = new Map();

/** Every box's typed figure; empty outside the desk. */
export function useTypedAmounts(): TypedAmounts {
  return useContext(TypedAmountsContext)?.amounts ?? EMPTY;
}

/** One row's typed figure and its setter. Outside the desk it falls back to the row's own state. */
export function useTypedAmount(requestId: number): [{ revision: string; text: string } | null, (revision: string, text: string) => void] {
  const store = useContext(TypedAmountsContext);
  const [local, setLocal] = useState<{ revision: string; text: string } | null>(null);
  if (!store) return [local, (revision, text) => setLocal({ revision, text })];
  return [store.amounts.get(requestId) ?? null, (revision, text) => store.setAmount(requestId, revision, text)];
}
