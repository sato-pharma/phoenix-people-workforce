"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

type RefreshRun = {
  id: string;
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Shows ROI data freshness. Pass showRefreshButton=false for read-only staleness chip
 *  (portal users); default true renders the full Refresh button for admins. */
export function RoiRefreshPanel({
  generatedAt,
  showRefreshButton = true,
}: {
  generatedAt: string | null;
  showRefreshButton?: boolean;
}) {
  const [run, setRun] = useState<RefreshRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/marketing/roi-refresh");
      if (!res.ok) return;
      const data = (await res.json()) as { status: string | null } & Partial<RefreshRun>;
      if (data.status) setRun(data as RefreshRun);
    } catch {
      // status fetch errors are non-fatal — don't surface them
    }
  }, []);

  // Load current run status once on mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchStatus();
  }, [fetchStatus]);

  // Poll every 5s while a refresh is running.
  useEffect(() => {
    if (run?.status !== "running") return;
    const id = setInterval(() => void fetchStatus(), 5_000);
    return () => clearInterval(id);
  }, [run?.status, fetchStatus]);

  async function triggerRefresh() {
    setBusy(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/marketing/roi-refresh", { method: "POST" });
      const data = (await res.json()) as {
        status?: string;
        error?: string;
        run?: RefreshRun | null;
        runId?: string;
      };
      if (data.error) {
        setFetchError(data.error);
      } else if (data.status === "already_running" && data.runId) {
        setRun({ id: data.runId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null });
      } else if (data.run) {
        setRun(data.run);
      }
    } catch {
      setFetchError("Request failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const isRunning = busy || run?.status === "running";

  // Freshness label from the snapshot's generatedAt (fast path) or the last completed run.
  const successAt = run?.status === "success" && run.finishedAt
    ? run.finishedAt
    : generatedAt;

  return (
    <div className="flex items-center gap-2">
      {fetchError ? (
        <span className="flex items-center gap-1 text-xs text-red-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {fetchError}
        </span>
      ) : isRunning ? (
        <span className="text-xs text-slate-400">Refreshing fact tables…</span>
      ) : run?.status === "failed" ? (
        <span className="flex items-center gap-1 text-xs text-red-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Refresh failed{run.error ? `: ${run.error}` : ""}
        </span>
      ) : successAt ? (
        <span className="flex items-center gap-1 text-xs text-slate-400">
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
          Data as of {formatTime(successAt)}
        </span>
      ) : null}

      {showRefreshButton && (
        <Button
          disabled={isRunning}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void triggerRefresh()}
        >
          <RefreshCcw className={`mr-1 h-3.5 w-3.5 ${isRunning ? "animate-spin" : ""}`} />
          {isRunning ? "Refreshing…" : "Refresh ROI"}
        </Button>
      )}
    </div>
  );
}
