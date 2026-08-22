"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Info, RotateCcw, Shuffle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PortalEmptyState,
  PortalMetricCard,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  AreaConsolidationCandidate,
  AreaConsolidationPreview,
  AreaConsolidationTablePreview,
} from "@/lib/territory-management/area-consolidation";

// ─────────────────────────────────────────────────────────────────────────────
// The button the owner asked for.
//
// "I want me to be able to, in the system itself, I check if confirmed, I press the button, and it
// goes. I don't want you to do any of this critical sensitive work."
//
// So this screen is built around CHECKING, not around acting. The action is one button at the end
// of a list of names. Three things follow from that and must not be "tidied away" later:
//
//   1. Rows are NAMED, not counted. "3 employees" cannot be checked by a human; "Nosiba Salah,
//      Aisha Ehab, Hanan Safwat" can.
//   2. The confirmation restates the move in full, including the two numbers that matter — how many
//      rows move, and how many are deliberately left alone.
//   3. Revert is offered on the same screen, not buried in an admin log.
// ─────────────────────────────────────────────────────────────────────────────

type CandidateResponse = { candidates?: AreaConsolidationCandidate[]; message?: string };
type PreviewResponse = { preview?: AreaConsolidationPreview; message?: string };

function TableBreakdown({ entry }: { entry: AreaConsolidationTablePreview }) {
  if (entry.count === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold text-slate-900">
          {entry.label}
        </p>
        <Badge variant={entry.role === "historical" ? "neutral" : "warning"}>
          {entry.count} {entry.count === 1 ? "row" : "rows"}
        </Badge>
      </div>

      {entry.untouchedReason ? (
        <p className="mt-1.5 text-[12px] font-medium leading-5 text-slate-600">{entry.untouchedReason}</p>
      ) : null}

      {entry.rows.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {entry.rows.map((row) => (
            <li
              key={`${entry.table}-${row.primaryKey}`}
              className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-slate-700"
            >
              {row.label}
            </li>
          ))}
        </ul>
      ) : null}

      {entry.truncated ? (
        <p className="mt-1.5 text-[12px] font-semibold text-amber-700">
          Showing the first {entry.rows.length} of {entry.count}. Every one of the {entry.count} moves.
        </p>
      ) : null}
    </div>
  );
}

export function AreaConsolidationWorkspace() {
  const [candidates, setCandidates] = useState<AreaConsolidationCandidate[] | null>(null);
  const [preview, setPreview] = useState<AreaConsolidationPreview | null>(null);
  const [selectedAreaId, setSelectedAreaId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"apply" | "revert" | null>(null);
  const [notes, setNotes] = useState("");

  // Deliberately sets nothing before its first `await`. The mount effect below calls this, and
  // `react-hooks/set-state-in-effect` is an ERROR in this repo — a synchronous setState anywhere on
  // an effect's call path fails the build. `loading` already starts true, so the mount spinner is
  // covered; the post-mutation refreshes call this too and are covered by `busy` instead, which is
  // better anyway — reverting a consolidation no longer blanks the whole screen to a spinner.
  const loadCandidates = useCallback(async () => {
    try {
      const response = await fetch("/api/territory-management/area-consolidation", {
        cache: "no-store",
      });
      const payload = (await response.json()) as CandidateResponse;
      if (!response.ok) throw new Error(payload.message ?? "Could not load areas.");
      setCandidates(payload.candidates ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load areas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A mount fetch is the one thing this rule cannot express: the compiler traces THROUGH the async
    // function and flags every setState it can reach, even the ones after the await. Same disable
    // and same shape as finance-download-panel.tsx and a dozen other panels in this repo.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCandidates();
  }, [loadCandidates]);

  const openPreview = useCallback(async (areaId: number) => {
    setSelectedAreaId(areaId);
    setPreview(null);
    setConfirming(null);
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/territory-management/area-consolidation/${areaId}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as PreviewResponse;
      if (!response.ok) throw new Error(payload.message ?? "Could not build the preview.");
      setPreview(payload.preview ?? null);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not build the preview.");
    } finally {
      setBusy(false);
    }
  }, []);

  const applyConsolidation = useCallback(async () => {
    if (!preview?.target) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/territory-management/area-consolidation/${preview.source.id}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetAreaId: preview.target.id, notes: notes.trim() || null }),
        },
      );
      const payload = (await response.json()) as { message?: string; totalMoved?: number };
      if (!response.ok) throw new Error(payload.message ?? "Could not consolidate that area.");
      setNotice(
        `Moved ${payload.totalMoved ?? 0} rows from ${preview.source.name} to ${preview.target.name}. This is fully revertible.`,
      );
      setConfirming(null);
      setNotes("");
      await loadCandidates();
      await openPreview(preview.source.id);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Could not consolidate that area.");
    } finally {
      setBusy(false);
    }
  }, [preview, notes, loadCandidates, openPreview]);

  const revertConsolidation = useCallback(async () => {
    if (!preview?.liveConsolidationId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/territory-management/area-consolidation/reverts/${preview.liveConsolidationId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: notes.trim() || null }),
        },
      );
      const payload = (await response.json()) as { message?: string; restored?: number };
      if (!response.ok) throw new Error(payload.message ?? "Could not revert that consolidation.");
      setNotice(`Restored ${payload.restored ?? 0} rows to ${preview.source.name}.`);
      setConfirming(null);
      setNotes("");
      await loadCandidates();
      await openPreview(preview.source.id);
    } catch (revertError) {
      setError(revertError instanceof Error ? revertError.message : "Could not revert that consolidation.");
    } finally {
      setBusy(false);
    }
  }, [preview, notes, loadCandidates, openPreview]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  const untouchedTotal = (preview?.untouched ?? []).reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <p className="text-[13px] font-semibold leading-5 text-rose-800">{error}</p>
        </div>
      ) : null}

      {notice ? (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <p className="text-[13px] font-semibold leading-5 text-emerald-800">{notice}</p>
        </div>
      ) : null}

      <PortalSection
        description="Areas from the old coding scheme that still have rows attached. Nothing here moves until you press the button."
        title="Legacy areas"
      >
        {(candidates ?? []).length === 0 ? (
          <PortalEmptyState
            message="Every active area resolves to a current Direct Order area, and nothing is stranded."
            title="Nothing to consolidate"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(candidates ?? []).map((candidate) => (
              <button
                className={`rounded-lg border p-3 text-left transition ${
                  selectedAreaId === candidate.source.id
                    ? "border-sky-400 bg-sky-50"
                    : "border-slate-200 bg-white hover:border-sky-300"
                }`}
                key={candidate.source.id}
                onClick={() => void openPreview(candidate.source.id)}
                type="button"
              >
                <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-bold text-slate-900">
                  {candidate.source.name}
                </p>
                <p className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-slate-600">
                  {candidate.target
                    ? `Ruled to move into ${candidate.target.name}`
                    : "No ruling yet — nothing can move"}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant={candidate.rowsToMove > 0 ? "warning" : "neutral"}>
                    {candidate.rowsToMove} {candidate.rowsToMove === 1 ? "row" : "rows"}
                  </Badge>
                  {candidate.liveConsolidationId ? <Badge variant="success">Consolidated</Badge> : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </PortalSection>

      {busy && !preview ? (
        <div className="flex items-center justify-center py-10">
          <LoadingSpinner />
        </div>
      ) : null}

      {preview ? (
        <>
          <PortalSection
            description="Read this list. Every name below changes area when you press the button."
            title={
              preview.target
                ? `${preview.source.name} → ${preview.target.name}`
                : `${preview.source.name} — no ruling yet`
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <PortalMetricCard label="Rows that move" value={String(preview.totalToMove)} />
              <PortalMetricCard label="Left untouched" value={String(untouchedTotal)} />
              <PortalMetricCard
                label="Moving into"
                value={preview.target ? preview.target.code : "—"}
              />
              <PortalMetricCard
                label="State"
                value={preview.liveConsolidationId ? "Consolidated" : "Not consolidated"}
              />
            </div>

            {!preview.target ? (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-[13px] font-medium leading-5 text-amber-900">
                  {preview.source.name} has no ruling, so there is nothing to move it into. Tell me
                  which current area it means and it becomes available here — the system will never
                  guess a territory on its own.
                </p>
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              {preview.willMove.map((entry) => (
                <TableBreakdown entry={entry} key={entry.table} />
              ))}
            </div>
          </PortalSection>

          {untouchedTotal > 0 ? (
            <PortalSection
              description="These record where something WAS. They are deliberately not rewritten."
              title="Left untouched"
            >
              <div className="space-y-2">
                {preview.untouched.map((entry) => (
                  <TableBreakdown entry={entry} key={entry.table} />
                ))}
              </div>
            </PortalSection>
          ) : null}

          <PortalSection description="Nothing is deleted, and every move can be undone." title="Action">
            {confirming === "apply" && preview.target ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <p className="text-[13px] font-bold leading-6 text-amber-900">
                  Are you sure you want to move {preview.totalToMove}{" "}
                  {preview.totalToMove === 1 ? "row" : "rows"} from {preview.source.name} to{" "}
                  {preview.target.name}?
                </p>
                <p className="mt-1 text-[12px] font-medium leading-5 text-amber-800">
                  This changes territory for real people and real customers. {untouchedTotal}{" "}
                  historical {untouchedTotal === 1 ? "row is" : "rows are"} left as they are. You can
                  revert this afterwards.
                </p>
                <input
                  className={`${portalInputClassName} mt-3`}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Note (optional) — why you are doing this"
                  value={notes}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded-lg bg-amber-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void applyConsolidation()}
                    type="button"
                  >
                    Yes, move them
                  </button>
                  <button
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50"
                    onClick={() => setConfirming(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : confirming === "revert" ? (
              <div className="rounded-lg border border-sky-300 bg-sky-50 p-4">
                <p className="text-[13px] font-bold leading-6 text-sky-900">
                  Put every moved row back on {preview.source.name}?
                </p>
                <input
                  className={`${portalInputClassName} mt-3`}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Reason (optional)"
                  value={notes}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded-lg bg-sky-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-sky-700 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void revertConsolidation()}
                    type="button"
                  >
                    Yes, revert it
                  </button>
                  <button
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50"
                    onClick={() => setConfirming(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                  disabled={busy || !preview.target || preview.totalToMove === 0 || Boolean(preview.liveConsolidationId)}
                  onClick={() => setConfirming("apply")}
                  type="button"
                >
                  <Shuffle className="h-4 w-4" />
                  Move them to {preview.target ? preview.target.name : "…"}
                  <ArrowRight className="h-4 w-4" />
                </button>

                {preview.liveConsolidationId ? (
                  <button
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => setConfirming("revert")}
                    type="button"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Revert
                  </button>
                ) : null}
              </div>
            )}
          </PortalSection>
        </>
      ) : null}
    </div>
  );
}
