"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

// Structured DV-Day feedback capture form (module completion C1). This is the WRITE surface for the
// new intelligence model — the config-driven 1..N scorecard, narrative, recommendation, and optional
// development actions — replacing the legacy free-text feedback box. Posts to
// /api/probation/dv/[dvDayId]/feedback (submitDvFeedback). Server enforces the same rules; we mirror
// the key gates client-side so the manager gets immediate feedback.

type Recommendation = "on_track" | "needs_improvement" | "serious_concern";

const RECOMMENDATIONS: Array<{ value: Recommendation; label: string }> = [
  { value: "on_track", label: "On track" },
  { value: "needs_improvement", label: "Needs improvement" },
  { value: "serious_concern", label: "Serious concern" },
];

type DevActionRow = { title: string; description: string; ownerHrId: string; dueDate: string };

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StructuredFeedbackForm({
  dvDayId,
  employeeName,
  dvDate,
  visitCount,
  evaluatorRoleLabel,
  dimensions,
  scale,
  backHref,
}: {
  dvDayId: string;
  employeeName: string;
  dvDate: string;
  visitCount: number;
  evaluatorRoleLabel: string | null;
  dimensions: string[];
  scale: { min: number; max: number };
  backHref: string;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<Record<string, string>>({});
  const [recommendation, setRecommendation] = useState<Recommendation | "">("");
  const [strengths, setStrengths] = useState("");
  const [developmentAreas, setDevelopmentAreas] = useState("");
  const [objectiveObservations, setObjectiveObservations] = useState("");
  const [confidentialNote, setConfidentialNote] = useState("");
  const [actions, setActions] = useState<DevActionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const setScore = (dim: string, v: string) => setScores((s) => ({ ...s, [dim]: v }));

  // Mirror the server gates: every dimension an integer in range, a recommendation, and at least one
  // narrative field (a score alone is not enough).
  const scoreErrors = useMemo(() => {
    const errs: string[] = [];
    for (const dim of dimensions) {
      const raw = scores[dim];
      if (raw === undefined || raw === "") { errs.push(humanize(dim)); continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < scale.min || n > scale.max) errs.push(humanize(dim));
    }
    return errs;
  }, [scores, dimensions, scale]);

  const narrativeOk = strengths.trim().length > 0 || developmentAreas.trim().length > 0;
  const canSubmit = scoreErrors.length === 0 && recommendation !== "" && narrativeOk && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const numericScores: Record<string, number> = {};
      for (const dim of dimensions) numericScores[dim] = Number(scores[dim]);
      const developmentActions = actions
        .filter((a) => a.title.trim().length > 0)
        .map((a) => ({
          title: a.title.trim(),
          description: a.description.trim() || null,
          ownerHrId: a.ownerHrId.trim() || null,
          dueDate: a.dueDate || null,
        }));
      const res = await fetch(`/api/probation/dv/${encodeURIComponent(dvDayId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scores: numericScores,
          recommendation,
          strengths: strengths.trim() || null,
          developmentAreas: developmentAreas.trim() || null,
          objectiveObservations: objectiveObservations.trim() || null,
          confidentialNote: confidentialNote.trim() || null,
          developmentActions,
        }),
      });
      if (res.ok) {
        setDone(true);
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to submit feedback.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <h2 className="text-sm font-semibold text-emerald-800">Feedback submitted</h2>
        <p className="mt-1 text-sm text-emerald-700">
          Your Double-Visit feedback for {employeeName} ({dvDate}) has been recorded and added to the case score.
        </p>
        <a href={backHref} className="mt-3 inline-block rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white">
          Back to my feedback tasks
        </a>
      </section>
    );
  }

  const cell = "h-9 w-16 rounded border border-slate-200 px-2 text-sm text-center";
  const area = "w-full rounded border border-slate-200 px-3 py-2 text-sm";
  // A hand-opened scorecard (manual-dv-day.ts) carries no CRM visits. Say so rather than
  // printing "0 visits", which reads like a captured field day that found nothing.
  const isManualScorecard = visitCount === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h1 className="text-base font-semibold text-slate-900">
          {isManualScorecard ? "Probation scorecard" : "Double-Visit feedback"} — {employeeName}
        </h1>
        <p className="mt-0.5 text-xs text-slate-500">
          {dvDate} ·{" "}
          {isManualScorecard ? "opened manually — no field visits captured" : `${visitCount} visit${visitCount === 1 ? "" : "s"}`}
          {evaluatorRoleLabel ? ` · as ${evaluatorRoleLabel}` : ""}
        </p>
      </div>

      {/* Scorecard */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Scorecard ({scale.min}–{scale.max} per skill)</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {dimensions.map((dim) => (
            <label key={dim} className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1.5 text-sm text-slate-700">
              <span>{humanize(dim)}</span>
              <input
                type="number" min={scale.min} max={scale.max} step={1}
                value={scores[dim] ?? ""}
                onChange={(e) => setScore(dim, e.target.value)}
                className={cell}
                aria-label={humanize(dim)}
              />
            </label>
          ))}
        </div>
        {scoreErrors.length > 0 && (
          <p className="mt-2 text-phx-xs text-amber-600">
            Each skill needs a whole number {scale.min}–{scale.max}. Missing/invalid: {scoreErrors.join(", ")}.
          </p>
        )}
      </section>

      {/* Recommendation */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Recommendation</h2>
        <div className="flex flex-wrap gap-2">
          {RECOMMENDATIONS.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setRecommendation(r.value)}
              className={`rounded border px-3 py-1.5 text-sm ${recommendation === r.value ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </section>

      {/* Narrative */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Narrative <span className="font-normal text-slate-400">(strengths or development areas required)</span></h2>
        <div className="flex flex-col gap-2">
          <textarea value={strengths} onChange={(e) => setStrengths(e.target.value)} rows={3} placeholder="Strengths observed…" className={area} />
          <textarea value={developmentAreas} onChange={(e) => setDevelopmentAreas(e.target.value)} rows={3} placeholder="Development areas…" className={area} />
          <textarea value={objectiveObservations} onChange={(e) => setObjectiveObservations(e.target.value)} rows={2} placeholder="Objective observations (optional)…" className={area} />
          <textarea value={confidentialNote} onChange={(e) => setConfidentialNote(e.target.value)} rows={2} placeholder="Confidential note (HR/CEO only, optional)…" className={area} />
        </div>
      </section>

      {/* Development actions */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Development actions <span className="font-normal text-slate-400">(optional)</span></h2>
          <button type="button" onClick={() => setActions((a) => [...a, { title: "", description: "", ownerHrId: "", dueDate: "" }])} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
            + Add action
          </button>
        </div>
        {actions.length === 0 && <p className="text-xs text-slate-400">No development actions. Add one to track a concrete improvement before the next Double-Visit.</p>}
        <div className="flex flex-col gap-2">
          {actions.map((a, i) => (
            <div key={i} className="rounded border border-slate-100 p-2">
              <div className="flex items-center gap-2">
                <input value={a.title} onChange={(e) => setActions((rows) => rows.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} placeholder="Action title" className={`${area} flex-1`} />
                <button type="button" onClick={() => setActions((rows) => rows.filter((_, j) => j !== i))} className="rounded border border-slate-200 px-2 py-1 text-xs text-rose-600">Remove</button>
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                <input value={a.description} onChange={(e) => setActions((rows) => rows.map((r, j) => j === i ? { ...r, description: e.target.value } : r))} placeholder="Detail (optional)" className={`${area} flex-1`} />
                <input value={a.ownerHrId} onChange={(e) => setActions((rows) => rows.map((r, j) => j === i ? { ...r, ownerHrId: e.target.value } : r))} placeholder="Owner HR_ID (optional)" className={`${area} w-40`} />
                <input type="date" value={a.dueDate} onChange={(e) => setActions((rows) => rows.map((r, j) => j === i ? { ...r, dueDate: e.target.value } : r))} className={`${area} w-40`} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button disabled={!canSubmit} onClick={submit} className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Submitting…" : "Submit feedback"}
        </button>
        <a href={backHref} className="text-sm text-slate-500 hover:underline">Cancel</a>
      </div>
    </div>
  );
}
