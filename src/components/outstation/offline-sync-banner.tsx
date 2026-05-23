"use client";

import { CloudOff } from "lucide-react";
import { StatusCard } from "@/components/outstation/status-card";

export function OfflineSyncBanner({
  visible,
  draftStorageError,
}: {
  visible: boolean;
  draftStorageError: string | null;
}) {
  if (!visible) return null;
  if (draftStorageError) {
    return (
      <StatusCard role="status" severity="error" className="font-semibold text-red-800">
        <div className="flex items-center gap-2">
          <CloudOff className="h-4 w-4" />
          {draftStorageError}
        </div>
      </StatusCard>
    );
  }

  return (
    <StatusCard role="status" severity="warning" className="text-amber-800">
      <div className="flex items-center gap-2">
        <CloudOff className="h-4 w-4" />
        Offline mode is active. Captured requests will be saved locally and synced when the internet is available.
      </div>
    </StatusCard>
  );
}
