"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";

import {
  AddBlockButton,
  CheckTile,
  FormBlock,
  FormField,
  FormGrid,
  FormWizard,
  type FormWizardStep,
} from "@/components/ui/form-kit";
import {
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Structured DV-Day feedback capture form (module completion C1). This is the WRITE surface for the
// new intelligence model — the config-driven 1..N scorecard, narrative, recommendation, and optional
// development actions — replacing the legacy free-text feedback box. Posts to
// /api/probation/dv/[dvDayId]/feedback (submitDvFeedback). Server enforces the same rules; we mirror
// the key gates client-side so the manager gets immediate feedback.
//
// 🔒 THE ONE FORM DESIGN (owner, 2026-10-06). It was four stacked `rounded-lg` cards on one long
// page; it is now the Adverse Drug Reaction wizard — Scores → Recommendation → Narrative → Actions —
// assembled from `form-kit.tsx`, so the skin follows the tokens and the corners are square. The gates
// did not move: the server still enforces them and the same three are mirrored here, only now each
// one belongs to the step that asks for it, so a missing score is said on the scores step instead of
// greying out a Submit four sections further down with no reason given.

type Recommendation = "on_track" | "needs_improvement" | "serious_concern";

const RECOMMENDATIONS: Array<{ value: Recommendation; label: string; hint: string }> = [
  { value: "on_track", label: "On track", hint: "Performing at the level the probation expects." },
  { value: "needs_improvement", label: "Needs improvement", hint: "Short of it, and the gap is closable." },
  { value: "serious_concern", label: "Serious concern", hint: "Far short of it — raise it with HR." },
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
  const [step, setStep] = useState(1);
  const [stepError, setStepError] = useState<string | null>(null);
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
  // Set when the feedback saved but its development actions did not — shown on the done screen so a
  // partial save is never reported as a plain success.
  const [actionsWarning, setActionsWarning] = useState<string | null>(null);

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

  // A hand-opened scorecard (manual-dv-day.ts) carries no CRM visits. Say so rather than
  // printing "0 visits", which reads like a captured field day that found nothing.
  const isManualScorecard = visitCount === 0;

  const STEPS: FormWizardStep[] = [
    { label: "Scores", description: "The skills, one at a time", title: `Scorecard (${scale.min}–${scale.max} per skill)` },
    { label: "Recommendation", description: "Where the employee stands today", title: "Your recommendation" },
    { label: "Narrative", description: "What you saw, in words", title: "What you observed" },
    { label: "Actions", description: "What happens before the next visit", title: "Development actions" },
  ];

  /** The one gate each step owns. Returning false keeps him on it with the reason said out loud. */
  function validateStep(current: number): boolean {
    if (current === 1 && scoreErrors.length > 0) {
      setStepError(
        `Each skill needs a whole number ${scale.min}–${scale.max}. Still missing or out of range: ${scoreErrors.join(", ")}.`,
      );
      return false;
    }
    if (current === 2 && recommendation === "") {
      setStepError("Choose where this person stands today.");
      return false;
    }
    if (current === 3 && !narrativeOk) {
      setStepError("Write at least one of strengths or development areas — a score on its own is not feedback.");
      return false;
    }
    setStepError(null);
    return true;
  }

  async function submit() {
    if (!validateStep(1) || !validateStep(2) || !validateStep(3)) return;
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
        const saved = await res.json().catch(() => ({}));
        setActionsWarning(saved?.developmentActionsError ? String(saved.developmentActionsError) : null);
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
      <section className="border border-emerald-200 bg-emerald-50 p-4">
        <h2 className="text-sm font-black text-emerald-800">Feedback submitted</h2>
        <p className="mt-1 text-sm text-emerald-700">
          Your Double-Visit feedback for {employeeName} ({dvDate}) has been recorded and added to the case score.
        </p>
        {actionsWarning && (
          <p className="mt-3 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{actionsWarning}</p>
        )}
        <a
          className="mt-3 inline-block border border-emerald-700 bg-emerald-700 px-4 py-2 text-sm font-bold text-white"
          href={backHref}
        >
          Back to my feedback tasks
        </a>
      </section>
    );
  }

  const cell = cn(phxFieldClassName, "w-20 px-2 text-center");
  const area = cn(phxTextareaClassName, "w-full");

  return (
    <FormWizard
      description={`${dvDate} · ${
        isManualScorecard ? "opened manually — no field visits captured" : `${visitCount} visit${visitCount === 1 ? "" : "s"}`
      }${evaluatorRoleLabel ? ` · as ${evaluatorRoleLabel}` : ""}`}
      error={stepError ?? error}
      eyebrow="Probation"
      footnote="Only HR and the CEO read the confidential note. Everything else goes to this person's probation case."
      onNext={() => validateStep(step)}
      onStepChange={(next) => {
        setStepError(null);
        setStep(next);
      }}
      onSubmit={() => void submit()}
      step={step}
      steps={STEPS}
      submitLabel="Submit feedback"
      submitting={busy}
      title={`${isManualScorecard ? "Probation scorecard" : "Double-Visit feedback"} — ${employeeName}`}
    >
      {step === 1 && (
        <FormGrid>
          {dimensions.map((dim) => (
            <FormField key={dim} label={humanize(dim)} required>
              <input
                aria-label={humanize(dim)}
                className={cell}
                max={scale.max}
                min={scale.min}
                onChange={(e) => setScore(dim, e.target.value)}
                step={1}
                type="number"
                value={scores[dim] ?? ""}
              />
            </FormField>
          ))}
        </FormGrid>
      )}

      {step === 2 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {RECOMMENDATIONS.map((r) => (
            <CheckTile
              checked={recommendation === r.value}
              key={r.value}
              name="dv-recommendation"
              onChange={() => setRecommendation(r.value)}
              type="radio"
            >
              <span className="min-w-0">
                <span className="block text-sm font-bold text-slate-900">{r.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{r.hint}</span>
              </span>
            </CheckTile>
          ))}
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <FormField hint="One of these two is required — the other three are yours to use or leave." label="Strengths observed">
            <textarea className={area} onChange={(e) => setStrengths(e.target.value)} rows={3} value={strengths} />
          </FormField>
          <FormField label="Development areas">
            <textarea className={area} onChange={(e) => setDevelopmentAreas(e.target.value)} rows={3} value={developmentAreas} />
          </FormField>
          <FormField label="Objective observations">
            <textarea className={area} onChange={(e) => setObjectiveObservations(e.target.value)} rows={2} value={objectiveObservations} />
          </FormField>
          <FormField hint="Read by HR and the CEO only. It never appears on this person's own screens." label="Confidential note">
            <textarea className={area} onChange={(e) => setConfidentialNote(e.target.value)} rows={2} value={confidentialNote} />
          </FormField>
        </div>
      )}

      {step === 4 && (
        <div className="flex flex-col gap-3">
          {actions.length === 0 && (
            <p className="flex items-start gap-2 text-sm leading-relaxed text-slate-500">
              <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
              No development actions yet. They are optional — add one to track a concrete improvement before the next
              Double-Visit.
            </p>
          )}
          {actions.map((a, i) => (
            <FormBlock
              action={
                <button
                  className={phxButtonDangerClassName}
                  onClick={() => setActions((rows) => rows.filter((_, j) => j !== i))}
                  type="button"
                >
                  Remove
                </button>
              }
              key={i}
              label={`Action ${i + 1}`}
            >
              <div className="flex flex-col gap-4">
                <FormField label="What will change">
                  <input
                    className={cn(phxFieldClassName, "w-full")}
                    onChange={(e) => setActions((rows) => rows.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))}
                    value={a.title}
                  />
                </FormField>
                <FormField label="Detail">
                  <input
                    className={cn(phxFieldClassName, "w-full")}
                    onChange={(e) =>
                      setActions((rows) => rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)))
                    }
                    value={a.description}
                  />
                </FormField>
                <FormGrid>
                  <FormField hint="Leave it empty and the action stays with you." label="Owner">
                    <input
                      className={cn(phxFieldClassName, "w-full")}
                      onChange={(e) =>
                        setActions((rows) => rows.map((r, j) => (j === i ? { ...r, ownerHrId: e.target.value } : r)))
                      }
                      value={a.ownerHrId}
                    />
                  </FormField>
                  <FormField label="Due date">
                    <input
                      className={cn(phxFieldClassName, "w-full")}
                      onChange={(e) => setActions((rows) => rows.map((r, j) => (j === i ? { ...r, dueDate: e.target.value } : r)))}
                      type="date"
                      value={a.dueDate}
                    />
                  </FormField>
                </FormGrid>
              </div>
            </FormBlock>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <AddBlockButton onClick={() => setActions((a) => [...a, { title: "", description: "", ownerHrId: "", dueDate: "" }])}>
              Add an action
            </AddBlockButton>
            <a className={phxButtonGhostClassName} href={backHref}>
              Cancel
            </a>
          </div>
        </div>
      )}
    </FormWizard>
  );
}
