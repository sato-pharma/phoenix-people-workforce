"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

type DevPreviewCookieBridgeProps = {
  hrId: string | null;
  loginId: string | null | undefined;
  role: string;
};

export function DevPreviewCookieBridge({
  hrId,
  loginId,
  role,
}: DevPreviewCookieBridgeProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [synced, setSynced] = React.useState(false);

  React.useEffect(() => {
    if (synced) return;

    const params = new URLSearchParams({
      loginId: loginId?.trim() || "dev.preview",
      next: pathname || "/",
      role,
    });

    if (hrId?.trim()) {
      params.set("hrId", hrId.trim());
    }

    let active = true;

    void fetch(`/api/dev-auth?${params.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .catch(() => undefined)
      .finally(() => {
        if (!active) return;
        setSynced(true);
        router.refresh();
      });

    return () => {
      active = false;
    };
  }, [hrId, loginId, pathname, role, router, synced]);

  return null;
}
