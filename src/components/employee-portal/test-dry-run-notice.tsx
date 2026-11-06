"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import { TEST_DRY_RUN_NOTICE, TEST_DRY_RUN_RESPONSE_HEADER } from "@/lib/auth/test-dry-run-words";

const LISTENING = Symbol.for("phoenix.testDryRun.notice");

/**
 * A TEST ACCOUNT'S SAVE RAN EVERY CHECK AND SAVED NOTHING — said after each one (owner, 2026-11-06,
 * "Runs fully, saves nothing"; src/lib/auth/test-dry-run.ts). The form shows its own success as it does
 * for the real person; this line says that success was a test and nothing was kept. Mounted only on a
 * test account's portal, so nobody else's fetch is ever watched.
 */
export function TestDryRunNotice() {
  useEffect(() => {
    const holder = window as unknown as Record<symbol, unknown>;
    if (holder[LISTENING]) return;
    holder[LISTENING] = true;
    const original = window.fetch;
    let lastShownAt = 0;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      try {
        if (response.ok && response.headers.get(TEST_DRY_RUN_RESPONSE_HEADER) === "1" && Date.now() - lastShownAt > 4000) {
          lastShownAt = Date.now();
          toast.info(TEST_DRY_RUN_NOTICE, { id: "test-dry-run" });
        }
      } catch {
        // A notice must never break the save it describes.
      }
      return response;
    }) as typeof fetch;
    return () => {
      window.fetch = original;
      holder[LISTENING] = false;
    };
  }, []);
  return null;
}
