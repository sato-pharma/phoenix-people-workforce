"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

// Tags the current Sentry scope (browser-side) with the resolved HR_ID only — never
// email/name. Mirrors the server-side tagging in src/lib/auth/server.ts's
// resolveAccessContext/resolveAccessContextFromPage, so both server and client errors
// carry the same minimal, non-PII user identifier and unlock "Users Affected" counts.
export function SentryUserTag({ hrId }: { hrId: string | null }) {
  useEffect(() => {
    Sentry.setUser(hrId ? { id: hrId } : null);
  }, [hrId]);

  return null;
}
