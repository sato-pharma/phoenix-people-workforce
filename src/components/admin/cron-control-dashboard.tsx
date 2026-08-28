"use client";

import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, CloudOff, Loader2, Pause, Play, Sparkles, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { CronJobSummary, ListCronJobsResult } from "@/lib/cron-control/service";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

const POLL_INTERVAL_MS = 30_000;
const AUTO_PREVIEW_DEBOUNCE_MS = 600;

type PreviewResult =
  | { valid: true; nextRuns: string[]; humanReadable: string; collisions: { jobName: string; atMinute: string }[] }
  | { valid: false; error: string };

// Quick-pick starting points — a user editing a schedule doesn't need to already know cron
// syntax. Presets land on :00 by default; the collision warning below the preview flags it if
// that overlaps another job (matches the real 2026-07-17 stagger incident), the preset doesn't
// need to avoid it itself.
const SCHEDULE_PRESETS: { label: string; cronExpression: string }[] = [
  { label: "Every 5 min", cronExpression: "*/5 * * * *" },
  { label: "Every 10 min", cronExpression: "*/10 * * * *" },
  { label: "Every 30 min", cronExpression: "*/30 * * * *" },
  { label: "Hourly", cronExpression: "0 * * * *" },
  { label: "Daily 6am", cronExpression: "0 6 * * *" },
  { label: "Weekly Sun 4am", cronExpression: "0 4 * * 0" },
];

export function CronControlDashboard({
  initialListing,
  canMutate,
}: {
  initialListing: ListCronJobsResult;
  canMutate: boolean;
}) {
  const [listing, setListing] = useState<ListCronJobsResult>(initialListing);
  const [pendingAction, setPendingAction] = useState<Record<string, boolean>>({});
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  async function refresh() {
    try {
      const res = await fetch("/api/admin/cron-control");
      if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
      const result = (await res.json()) as ListCronJobsResult;
      if (isMountedRef.current) setListing(result);
    } catch {
      // Silent on background poll failures — last-known state stays visible.
    }
  }

  useEffect(() => {
    isMountedRef.current = true;
    function poll() {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    function onVisibilityChange() {
      if (document.visibilityState === "visible") poll();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  async function handleMutate(jobName: string, action: "pause" | "resume" | "run") {
    setPendingAction((prev) => ({ ...prev, [jobName]: true }));
    try {
      const res = await fetch(`/api/admin/cron-control/${jobName}/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? body?.message ?? `Request failed (${res.status})`);
      toast.success(
        action === "run" ? "Triggered — check back in a few seconds for the outcome." : action === "pause" ? "Job paused." : "Job resumed.",
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setPendingAction((prev) => ({ ...prev, [jobName]: false }));
    }
  }

  function applyUpdatedJob(updated: CronJobSummary) {
    setListing((prev) => (prev.available ? { ...prev, jobs: prev.jobs.map((job) => (job.jobName === updated.jobName ? updated : job)) } : prev));
    setExpandedJob(null);
  }

  if (!listing.available) {
    return <NotConfiguredBanner error={listing.error} />;
  }

  return (
    <div className="space-y-5">
      <DriftBanner />
      <p className="text-xs font-semibold text-phx-ink-soft">
        Showing all {listing.jobs.length} live job{listing.jobs.length === 1 ? "" : "s"} from GCP Cloud Scheduler as of{" "}
        {formatDate(listing.fetchedAt)} — this list is never filtered to a static subset; any job that exists in the project&apos;s
        scheduler appears here.
      </p>
      <div className="grid gap-4">
        {listing.jobs.map((job) => (
          <JobCard
            canMutate={canMutate}
            expanded={expandedJob === job.jobName}
            job={job}
            key={job.jobName}
            onMutate={(action) => handleMutate(job.jobName, action)}
            onScheduleUpdated={applyUpdatedJob}
            onToggleExpand={() => setExpandedJob((prev) => (prev === job.jobName ? null : job.jobName))}
            pending={Boolean(pendingAction[job.jobName])}
          />
        ))}
      </div>
    </div>
  );
}

function NotConfiguredBanner({ error }: { error: string }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-[linear-gradient(135deg,#FFFBEB_0%,#FFFFFF_100%)] p-6 shadow-[0_16px_36px_rgba(245,158,11,0.10)]">
      <div className="flex items-center gap-3 text-amber-700">
        <CloudOff className="h-6 w-6" />
        <h2 className="text-lg font-bold">Cloud Scheduler access not yet configured</h2>
      </div>
      <p className="mt-2 text-sm text-amber-800/80">
        This dashboard is deployed, but the runtime service account does not yet have the Cloud Scheduler IAM role
        granted (a separate, explicit approval — see the PR description). Once granted, live job state appears here
        automatically.
      </p>
      <div className="mt-4 rounded-lg border border-amber-200 bg-white/70 p-3">
        <p className="break-all font-mono text-xs text-amber-800">{error}</p>
      </div>
    </div>
  );
}

function DriftBanner() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-phx-line bg-phx-paper px-4 py-3 text-xs text-phx-ink-soft">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <span>
        This is the live control plane — <code className="rounded bg-phx-line px-1 py-0.5 font-mono">scripts/setup-gcp-cron.sh</code> is a
        manual bootstrap script and does not track changes made here. If you edit a schedule, update the script&apos;s flags by hand so a future
        re-bootstrap doesn&apos;t silently revert it.
      </span>
    </div>
  );
}

const STATE_STYLES: Record<string, string> = {
  ENABLED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PAUSED: "bg-slate-100 text-slate-600 border-slate-200",
  UPDATE_FAILED: "bg-rose-50 text-rose-700 border-rose-200",
};

const OUTCOME_STYLES: Record<string, string> = {
  SUCCESS: "text-emerald-600",
  FAILED: "text-rose-600",
  UNKNOWN: "text-phx-ink-soft",
};

function JobCard({
  job,
  canMutate,
  pending,
  expanded,
  onToggleExpand,
  onMutate,
  onScheduleUpdated,
}: {
  job: CronJobSummary;
  canMutate: boolean;
  pending: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onMutate: (action: "pause" | "resume" | "run") => void;
  onScheduleUpdated: (job: CronJobSummary) => void;
}) {
  const isPaused = job.state === "PAUSED";

  return (
    <div className="rounded-2xl border border-phx-line bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-base font-black text-phx-ink">{job.label}</h3>
            <span className={`rounded-full border px-2.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${STATE_STYLES[job.state] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>
              {job.state}
            </span>
            {!job.isKnown ? (
              <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-sky-700">
                Not in local registry
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-phx-ink-soft">{job.description}</p>
          <p className="mt-1 font-mono text-xs text-phx-ink-faint">
            {job.route ? <>{job.route} · </> : null}
            <span className="text-phx-ink-soft">{job.schedule}</span> ({job.timeZone})
          </p>
        </div>

        {canMutate ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-phx-line bg-white px-3 py-1.5 text-phx-xs font-black text-phx-ink transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-50"
              disabled={pending}
              onClick={() => onMutate("run")}
              type="button"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Run now
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-phx-line bg-white px-3 py-1.5 text-phx-xs font-black text-phx-ink transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-50"
              disabled={pending}
              onClick={() => onMutate(isPaused ? "resume" : "pause")}
              type="button"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B0B0B] px-3 py-1.5 text-phx-xs font-black text-white transition hover:bg-[#1E293B]"
              onClick={onToggleExpand}
              type="button"
            >
              <CalendarClock className="h-3.5 w-3.5" />
              Edit schedule
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-phx-paper-2 pt-3 text-xs text-phx-ink-soft sm:grid-cols-3">
        <div>
          <div className="font-black uppercase tracking-wide text-phx-ink-faint">Last attempt</div>
          <div className={job.lastAttemptOutcome ? OUTCOME_STYLES[job.lastAttemptOutcome] : ""}>
            {job.lastAttemptTime ? formatDate(job.lastAttemptTime) : "—"} {job.lastAttemptOutcome ? `(${job.lastAttemptOutcome})` : ""}
          </div>
        </div>
        <div>
          <div className="font-black uppercase tracking-wide text-phx-ink-faint">Next scheduled</div>
          <div>{job.nextScheduleTime ? formatDate(job.nextScheduleTime) : "—"}</div>
        </div>
      </div>

      {expanded ? <SchedulePanel job={job} onCancel={onToggleExpand} onScheduleUpdated={onScheduleUpdated} /> : null}
    </div>
  );
}

function SchedulePanel({
  job,
  onCancel,
  onScheduleUpdated,
}: {
  job: CronJobSummary;
  onCancel: () => void;
  onScheduleUpdated: (job: CronJobSummary) => void;
}) {
  const [cronExpression, setCronExpression] = useState(job.schedule);
  const [timeZone, setTimeZone] = useState(job.timeZone);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewedFor, setPreviewedFor] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Guards against a slow, stale request (auto-preview fires on every keystroke) resolving
  // after a newer one and clobbering the displayed result with out-of-date data.
  const requestSeqRef = useRef(0);

  const currentFingerprint = `${cronExpression}|${timeZone}`;
  const canConfirm = preview?.valid === true && previewedFor === currentFingerprint;

  async function handlePreview(opts?: { silent?: boolean }) {
    const seq = ++requestSeqRef.current;
    const fingerprint = `${cronExpression}|${timeZone}`;
    setPreviewing(true);
    try {
      const res = await fetch("/api/admin/cron-control/preview-schedule", {
        body: JSON.stringify({ cronExpression, excludeJobName: job.jobName, timeZone }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = (await res.json()) as PreviewResult;
      if (seq !== requestSeqRef.current) return; // a newer request already resolved
      setPreview(result);
      setPreviewedFor(fingerprint);
      if (!result.valid && !opts?.silent) toast.error(result.error);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      const message = err instanceof Error ? err.message : "Preview failed.";
      setPreview({ error: message, valid: false });
      setPreviewedFor(fingerprint);
      if (!opts?.silent) toast.error(message);
    } finally {
      if (seq === requestSeqRef.current) setPreviewing(false);
    }
  }

  // Auto-preview (debounced) so validation + next-run times update as the user types or picks a
  // preset — no separate "remember to click Preview" step. Errors from THIS silent pass show
  // inline only (not a toast); an explicit Preview click or a failed Confirm still toasts.
  useEffect(() => {
    const timer = setTimeout(() => {
      void handlePreview({ silent: true });
    }, AUTO_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cronExpression, timeZone]);

  async function handleConfirm() {
    if (!canConfirm) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/cron-control/${job.jobName}/schedule`, {
        body: JSON.stringify({
          cronExpression,
          previousCronExpression: job.schedule,
          previousTimeZone: job.timeZone,
          timeZone,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; job?: CronJobSummary; error?: string } | null;
      if (!res.ok || !body?.ok || !body.job) throw new Error(body?.error ?? `Request failed (${res.status})`);
      toast.success("Schedule updated.");
      onScheduleUpdated(body.job);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update schedule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-phx-line bg-phx-paper p-4">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-phx-xs font-black uppercase tracking-wide text-phx-ink-faint">Quick pick:</span>
        {SCHEDULE_PRESETS.map((preset) => (
          <button
            className="rounded-full border border-phx-line bg-white px-2.5 py-1 text-phx-xs font-bold text-phx-ink-2 transition hover:border-orange-300 hover:text-orange-700"
            key={preset.label}
            onClick={() => setCronExpression(preset.cronExpression)}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-black text-phx-ink-soft">
            Cron expression
            <input
              className="mt-1 w-full rounded-lg border border-phx-line bg-white px-3 py-2 font-mono text-sm text-phx-ink"
              onChange={(event) => setCronExpression(event.target.value)}
              type="text"
              value={cronExpression}
            />
          </label>
          <label className="text-xs font-black text-phx-ink-soft">
            Time zone (IANA)
            <input
              className="mt-1 w-full rounded-lg border border-phx-line bg-white px-3 py-2 font-mono text-sm text-phx-ink"
              onChange={(event) => setTimeZone(event.target.value)}
              type="text"
              value={timeZone}
            />
          </label>
        </div>
        <div className="flex items-end gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-phx-line bg-white px-3 py-2 text-phx-xs font-black text-phx-ink transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-50"
            disabled={previewing || !cronExpression || !timeZone}
            onClick={() => handlePreview()}
            type="button"
          >
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Preview now
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-phx-xs text-phx-ink-faint">Auto-previews as you type — this button just forces an immediate check.</p>

      {preview ? (
        <div className="mt-3 rounded-lg border border-phx-line bg-white p-3 text-xs">
          {preview.valid ? (
            <>
              <div className="font-black text-phx-ink">Next 5 runs:</div>
              <ul className="mt-1 space-y-0.5 font-mono text-phx-ink-2">
                {preview.nextRuns.map((run) => (
                  <li key={run}>{formatDate(run)}</li>
                ))}
              </ul>
              {preview.collisions.length > 0 ? (
                <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Fires the same minute as: {preview.collisions.map((c) => c.jobName).join(", ")}. Not blocked — just worth double-checking
                    (a past incident here: stacked crons on the same minute saturated the serving instance).
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-rose-600">{preview.error}</div>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button className="rounded-lg px-3 py-1.5 text-phx-xs font-black text-phx-ink-soft hover:text-phx-ink" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B0B0B] px-3 py-1.5 text-phx-xs font-black text-white transition hover:bg-[#1E293B] disabled:opacity-40"
          disabled={!canConfirm || saving}
          onClick={handleConfirm}
          type="button"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Confirm & Save
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    });
  } catch {
    return iso;
  }
}
