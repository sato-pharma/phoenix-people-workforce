"use client";

import { useCallback, useRef, useState } from "react";

type Phase = "idle" | "starting" | "processing" | "ready" | "error";

/**
 * Full "all-modules" data backup is generated as a durable background job (not inside the
 * request) so it can never hit the Cloud Run request timeout / OOM. This control enqueues
 * the job, polls its status, and surfaces a download link when the artifact is ready.
 * Scoped per-module exports stay synchronous (they are small).
 */
export function AsyncBackupDownload({
  format,
  label,
  variant,
}: {
  format: "xlsx" | "json";
  label: string;
  variant: "primary" | "secondary";
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const base =
    variant === "primary"
      ? "inline-block px-5 py-2 text-sm font-semibold text-white bg-orange-500 hover:bg-orange-600 disabled:opacity-60"
      : "inline-block px-5 py-2 text-sm font-semibold text-slate-300 border border-slate-600 hover:border-slate-400 hover:text-white disabled:opacity-60";

  const poll = useCallback(async (id: string) => {
    setPhase("processing");
    // ~10 minutes at 5s intervals.
    for (let i = 0; i < 120; i += 1) {
      if (cancelled.current) return;
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch(`/api/admin/data-backup/status/${id}`, { cache: "no-store" });
        if (!res.ok) continue;
        const s = (await res.json()) as { status: string; filename?: string | null; error?: string | null };
        if (s.status === "completed") {
          setFilename(s.filename ?? null);
          setPhase("ready");
          return;
        }
        if (s.status === "failed") {
          setError(s.error || "Export failed.");
          setPhase("error");
          return;
        }
      } catch {
        // transient — keep polling
      }
    }
    setError("Timed out waiting for the export. Try again.");
    setPhase("error");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    cancelled.current = false;
    try {
      const res = await fetch("/api/admin/data-backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "all", format }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `Could not start the export (${res.status}).`);
      }
      const { jobId: id } = (await res.json()) as { jobId: string };
      setJobId(id);
      void poll(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the export.");
      setPhase("error");
    }
  }, [format, poll]);

  if (phase === "ready" && jobId) {
    return (
      <a className={base} href={`/api/admin/data-backup/download/${jobId}`}>
        Download {label}
        {filename ? "" : ""}
      </a>
    );
  }

  const busy = phase === "starting" || phase === "processing";
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" className={base} onClick={start} disabled={busy}>
        {phase === "idle" && `Generate ${label}`}
        {busy && "Generating in the background…"}
        {phase === "error" && `Retry ${label}`}
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </span>
  );
}
