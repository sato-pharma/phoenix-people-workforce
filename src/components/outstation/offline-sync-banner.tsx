"use client";

import { CloudOff } from "lucide-react";

export function OfflineSyncBanner({
  visible,
}: {
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-phx-md font-medium text-amber-800">
      <div className="flex items-center gap-2">
        <CloudOff className="h-3.5 w-3.5 shrink-0" />
        <span>
          Offline mode is active. Captured requests will be saved locally and synced when the
          internet is available.
        </span>
      </div>
    </div>
  );
}
