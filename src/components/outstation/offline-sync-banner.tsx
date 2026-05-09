"use client";

import { CloudOff } from "lucide-react";

export function OfflineSyncBanner({
  visible,
}: {
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
      <div className="flex items-center gap-2">
        <CloudOff className="h-4 w-4" />
        Offline mode is active. Captured requests will be saved locally and synced when the internet is available.
      </div>
    </div>
  );
}
