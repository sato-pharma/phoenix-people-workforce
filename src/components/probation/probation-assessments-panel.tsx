"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// SFE + HR assessment capture (module completion C3/C4). The report already DISPLAYS assessments; this
// is the WRITE surface. SFE section is for the SFE Manager / probation admin; HR section for the
// probation admin only, and only when hrAssessmentEnabled. Posts to
// /api/probation/cases/[caseId]/assessments/{sfe,hr}. System evidence is shown read-only next to the
// human score. Structural prop types are declared locally so this client file pulls no server code.

type SfeMetric = { key: string; label: string; value: number | null; unit: string; available: boolean; note?: string };
type SfeEvidence = {
  window: { from: string | null; to: string; days: number };
  totalVisits: number; activeVisitDays: number; distinctCustomers: number;
  checkinCount: number; daysWithCheckin: number; metrics: SfeMetric[]; generatedAt: string;
} | null;
type Assessment = { score: number | null; comments: string | null; confidentialNote: string | null; status: string } | null;

function AssessmentSection({
  kind, caseId, scale, existing, canSeeConfidential, disabledReason,
}: {
  kind: "sfe" | "hr";
  caseId: string;
  scale: { min: number; max: number };
  existing: Assessment;
  canSeeConfidential: boolean;
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [score, setScore] = useState<string>(existing?.score != null ? String(existing.score) : "");
  const [comments, setComments] = useState(existing?.comments ?? "");
  const [confidentialNote, setConfidentialNote] = useState(canSeeConfidential ? (existing?.confidentialNote ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(existing?.status === "submitted" ? "existing" : null);

  const scoreNum = score === "" ? null : Number(score);
  const scoreValid = score === "" || (Number.isInteger(scoreNum) && (scoreNum as number) >= scale.min && (scoreNum as number) <= scale.max);
  const area = "w-full rounded border border-slate-200 px-3 py-2 text-sm";

  async function submit() {
    if (busy || !scoreValid) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        score: scoreNum,
        comments: comments.trim() || null,
        overrides: {},
      };
      if (canSeeConfidential) body.confidentialNote = confidentialNote.trim() || null;
      const res = await fetch(`/api/probation/cases/${encodeURIComponent(caseId)}/assessments/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSavedAt("just now");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save the assessment.");
      }
    } finally {
      setBusy(false);
    }
  }

  const title = kind === "sfe" ? "SFE assessment" : "HR assessment";

  if (disabledReason) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 p-3">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        <p className="mt-1 text-xs text-slate-500">{disabledReason}</p>
      </div>
    );
  }

  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {savedAt && <span className="rounded bg-emerald-50 px-2 py-0.5 text-phx-xs font-medium text-emerald-700">Submitted</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">Score ({scale.min}–{scale.max})
          <input type="number" min={scale.min} max={scale.max} step={1} value={score} onChange={(e) => setScore(e.target.value)} className="mt-1 block h-9 w-24 rounded border border-slate-200 px-2 text-sm" />
        </label>
        {!scoreValid && <span className="text-phx-xs text-amber-600">Whole number {scale.min}–{scale.max}, or blank.</span>}
      </div>
      <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={2} placeholder="Comments (optional)…" className={`${area} mt-2`} />
      {canSeeConfidential && (
        <textarea value={confidentialNote} onChange={(e) => setConfidentialNote(e.target.value)} rows={2} placeholder="Confidential note (HR/CEO only, optional)…" className={`${area} mt-2`} />
      )}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      <button disabled={busy || !scoreValid} onClick={submit} className="mt-2 rounded bg-slate-800 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "Saving…" : savedAt ? "Update assessment" : "Submit assessment"}
      </button>
    </div>
  );
}

export function ProbationAssessmentsPanel({
  caseId, scale, sfeEvidence, sfeExisting, hrExisting, hrAssessmentEnabled,
  canSubmitSfe, canSubmitHr, canSeeConfidential,
}: {
  caseId: string;
  scale: { min: number; max: number };
  sfeEvidence: SfeEvidence;
  sfeExisting: Assessment;
  hrExisting: Assessment;
  hrAssessmentEnabled: boolean;
  canSubmitSfe: boolean;
  canSubmitHr: boolean;
  canSeeConfidential: boolean;
}) {
  if (!canSubmitSfe && !canSubmitHr) return null;

  return (
    <section className="rounded-lg border border-slate-300 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Assessments</h2>
      <p className="mt-0.5 text-xs text-slate-500">Human scores layered over system evidence. Each feeds the weighted case score.</p>

      {canSubmitSfe && sfeEvidence && (
        <div className="mt-3 rounded border border-slate-100 bg-slate-50 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">SFE system evidence (read-only)</h3>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {sfeEvidence.metrics.map((m) => (
              <div key={m.key} className="text-xs text-slate-600">
                <span className="text-slate-400">{m.label}: </span>
                {m.available && m.value != null ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "—"}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {canSubmitSfe && (
          <AssessmentSection kind="sfe" caseId={caseId} scale={scale} existing={sfeExisting} canSeeConfidential={canSeeConfidential} disabledReason={null} />
        )}
        {canSubmitHr && (
          <AssessmentSection
            kind="hr" caseId={caseId} scale={scale} existing={hrExisting} canSeeConfidential={canSeeConfidential}
            disabledReason={hrAssessmentEnabled ? null : "The HR assessment is currently disabled by an administrator. Enable it in Probation Settings to submit."}
          />
        )}
      </div>
    </section>
  );
}
