"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

type Props = {
  hrId: string | null;
  role: string;
};

export function SentryUserIdentity({ hrId, role }: Props) {
  useEffect(() => {
    if (hrId) {
      Sentry.setUser({ id: hrId, role });
    } else {
      Sentry.setUser(null);
    }
    return () => {
      Sentry.setUser(null);
    };
  }, [hrId, role]);

  return null;
}
