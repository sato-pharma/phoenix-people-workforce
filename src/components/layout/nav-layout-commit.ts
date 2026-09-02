"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE write path into a personal navigation layout, shared by every control
// that edits one from the bar itself.
//
// There are now four of those — the row's "+", drag-and-drop, the right-click
// menu, and the one-press pin — and before this hook existed there was one
// hand-written read-modify-write inside NavRowAddButton. Four copies of that
// sequence is the shape of defect this repo has shipped before: the union, the
// constraint and the classifier all agreed, and one local duplicate of the list
// did not, and Capture Evidence rejected 59 of the 65 customers it existed for.
//
// ── Why read-modify-write, and not "save the rows I am rendering" ───────────
// The rendered rows are the RESOLVED view: a module override has already been
// substituted for the defaults, and any page the layout never mentioned has
// already been appended. Saving that back would flatten an arrangement the
// viewer never asked to change — the module override would be written into the
// defaults, silently, for every other module.
//
// So every caller receives the STORED document and returns the next one. The
// mutation itself lives in personal-layout.ts, where it is pure and tested;
// this hook only moves it to and from the server.
//
// `router.refresh()` at the end is not optional. The rows are server-rendered
// from the stored layout, so without it the save is correct and the screen does
// not move — which is exactly the failure ("I save, and nothing happens") that
// the whole nav-layout feature was born out of.
// ─────────────────────────────────────────────────────────────────────────────

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { PersonalNavigationLayout } from "@/lib/navigation/personal-layout";

const ENDPOINT = "/api/navigation/personal-layout";

export type NavLayoutCommit = {
  /**
   * Apply `mutate` to the stored layout and save the result.
   *
   * `key` is an opaque label for the in-flight control — an href, or something like
   * "drag" — so a caller can disable just the row it pressed rather than the whole bar.
   * Resolves true on success and false on failure; the error message is exposed below
   * rather than thrown, because every caller here renders it in place.
   */
  commit: (
    key: string,
    mutate: (current: PersonalNavigationLayout | null) => PersonalNavigationLayout,
  ) => Promise<boolean>;
  /** The `key` of the write currently in flight, or null. */
  pending: string | null;
  error: string | null;
  clearError: () => void;
};

export function useNavLayoutCommit(): NavLayoutCommit {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback<NavLayoutCommit["commit"]>(
    async (key, mutate) => {
      setPending(key);
      setError(null);
      try {
        const read = await fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin" });
        if (!read.ok) throw new Error("read");
        // Nullable on purpose: the GET answers { data: null } for an account that has never
        // saved a layout, and a JSON body of literal `null` parses to null outright.
        const body = (await read.json()) as { data?: PersonalNavigationLayout | null } | null;
        const write = await fetch(ENDPOINT, {
          body: JSON.stringify({ layout: mutate(body?.data ?? null) }),
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
        if (!write.ok) throw new Error("write");
        router.refresh();
        return true;
      } catch {
        setError("That did not save. Try again.");
        return false;
      } finally {
        setPending(null);
      }
    },
    [router],
  );

  const clearError = useCallback(() => setError(null), []);

  return { commit, pending, error, clearError };
}
