"use client";

import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CollapsibleSection, PanelSection } from "@/components/outstation/approval-detail-primitives";
import type {
  FraudCheckResult,
  FraudVerdict,
} from "@/lib/outstation/expense-fraud-checks";

/**
 * Claim validation, for the reviewer.
 *
 * Owner request (2026-08-08): show whether independent CRM evidence corroborates that the person
 * was where the claim says. Visible to Super Admin and the CEO only — the page gate handles that;
 * this component simply renders whatever the API returns.
 *
 * Three states, and the visual difference between them carries the whole meaning:
 *
 *   clean        — emerald. Corroborated.
 *   review       — rose. Something is worth a look.
 *   unverifiable — DELIBERATELY COLOURLESS. Slate, dashed, no icon of judgement.
 *
 * That third state is the one that matters most. Roughly half of all claims have no corroborating
 * CRM activity at all — managers do not check in, their reps do, and a rep with no check-ins that
 * day leaves nothing to compare against. If "could not verify" rendered in warning colours, the
 * panel would read as an accusation against half the company, every day, and reviewers would
 * learn to ignore all of it. Absence of evidence must look like absence, not like guilt.
 */

type ValidationResponse =
  | {
      available: true;
      checks: FraudCheckResult[];
      employeeName: string;
      headline: FraudVerdict;
      summary: string;
      tripDay: string;
    }
  | { available: false; reason: string };

const VERDICT_STYLE: Record<FraudVerdict, { card: string; chip: string; label: string }> = {
  clean: {
    card: "border-emerald-200 bg-emerald-50/50",
    chip: "bg-emerald-100 text-emerald-800",
    label: "Verified",
  },
  review: {
    card: "border-rose-200 bg-rose-50/60",
    chip: "bg-rose-100 text-rose-800",
    label: "Needs a look",
  },
  unverifiable: {
    card: "border-dashed border-slate-300 bg-slate-50",
    chip: "bg-slate-200 text-slate-600",
    label: "Could not verify",
  },
};

/**
 * Problems first (owner's review, 2026-11-07): a flag, then what could not be verified, then what
 * passed. Stable within each group, so the checks keep the engine's own order inside it.
 */
const VERDICT_ORDER: Record<FraudVerdict, number> = { review: 0, unverifiable: 1, clean: 2 };

export function orderClaimChecks<T extends { verdict: FraudVerdict }>(checks: T[]): T[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((left, right) => VERDICT_ORDER[left.check.verdict] - VERDICT_ORDER[right.check.verdict] || left.index - right.index)
    .map(({ check }) => check);
}

function VerdictIcon({ verdict }: { verdict: FraudVerdict }) {
  if (verdict === "clean") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (verdict === "review") return <AlertTriangle className="h-4 w-4 text-rose-600" />;
  return <HelpCircle className="h-4 w-4 text-slate-400" />;
}

/** What the caller is told once the checks land: a verdict, or why there is none. */
export type ClaimValidationOutcome = FraudVerdict | "unavailable" | "error";

export function ExpenseClaimValidationPanel({
  bare = false,
  collapsible = false,
  onOutcome,
  requestId,
}: {
  /** The checks alone, with no header of their own — the caller writes the section around them
   * (Expense Approvals, 2026-11-07, where nothing folds). */
  bare?: boolean;
  /** A folding section with the verdict in its header, opened on its own only when something needs
   * a look (2026-11-06). The held-request drawer keeps it open. */
  collapsible?: boolean;
  /** The verdict, once read — so the caller can word it at the top of its page. */
  onOutcome?: (outcome: ClaimValidationOutcome) => void;
  requestId: number;
}) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: ValidationResponse }
  >({ kind: "loading" });
  const onOutcomeRef = useRef(onOutcome);
  useEffect(() => {
    onOutcomeRef.current = onOutcome;
  });

  const load = useCallback(async () => {
    // Yield a microtask before the first setState, the same idiom the other self-fetching panels
    // in this module use — a setState reachable synchronously from an effect body is a lint error
    // here, not merely a style preference.
    await Promise.resolve();
    try {
      const response = await fetch(`/api/admin/outstation/expenses/${requestId}/validation`, {
        headers: { accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
      const data = payload as ValidationResponse;
      setState({ data, kind: "ready" });
      onOutcomeRef.current?.(data.available ? data.headline : "unavailable");
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "The validation could not be loaded.",
      });
      onOutcomeRef.current?.("error");
    }
  }, [requestId]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      if (cancelled) return;
      await load();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const headline = state.kind === "ready" && state.data.available ? state.data.headline : null;
  const body = (
    <>
      {state.kind === "loading" ? (
        <p className="flex items-center gap-2 text-phx-md text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking this claim against the day&apos;s CRM activity…
        </p>
      ) : null}

      {state.kind === "error" ? (
        <p className="flex items-start gap-2 text-phx-md leading-relaxed text-slate-500">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {state.message}
        </p>
      ) : null}

      {state.kind === "ready" && !state.data.available ? (
        <p className="flex items-start gap-2 text-phx-md leading-relaxed text-slate-500">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {state.data.reason}
        </p>
      ) : null}

      {state.kind === "ready" && state.data.available ? (
        <div className="space-y-3">
          {/* On the trip page (`bare`) the section header already says this sentence — never twice. */}
          {bare ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-1 text-phx-2xs font-black uppercase tracking-wider ${VERDICT_STYLE[state.data.headline].chip}`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {VERDICT_STYLE[state.data.headline].label}
            </span>
            <p className="text-phx-md leading-relaxed text-slate-700">{state.data.summary}</p>
          </div>
          )}

          {/* Stacked cards, never a table. This panel renders inside a column that collapses on
              mobile, and a table here would force horizontal scrolling on a phone. */}
          <div className="space-y-2">
            {orderClaimChecks(state.data.checks).map((check) =>
              // A passed check on the trip page is ONE line — title, chip, its facts; the sentence
              // behind it is the line's tooltip. Nothing is folded: it is all still on the page.
              bare && check.verdict === "clean" ? (
                <div
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 border px-3 py-1.5 ${VERDICT_STYLE.clean.card}`}
                  data-claim-check-line
                  key={check.id}
                  title={check.detail}
                >
                  <VerdictIcon verdict={check.verdict} />
                  <p className="text-phx-md font-bold text-slate-900">{check.title}</p>
                  <span className={`px-1.5 py-0.5 text-phx-3xs font-bold uppercase tracking-wider ${VERDICT_STYLE.clean.chip}`}>
                    {VERDICT_STYLE.clean.label}
                  </span>
                  {check.facts.map((fact) => (
                    <span className="flex items-baseline gap-1.5" key={`${check.id}-${fact.label}`}>
                      <span className="text-phx-2xs font-bold uppercase tracking-wider text-slate-500">{fact.label}</span>
                      <span className="text-xs font-semibold text-slate-800">{fact.value}</span>
                    </span>
                  ))}
                </div>
              ) : (
              <div
                className={`border p-3 ${VERDICT_STYLE[check.verdict].card}`}
                key={check.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <VerdictIcon verdict={check.verdict} />
                  <p className="text-phx-md font-bold text-slate-900">{check.title}</p>
                  <span
                    className={`px-1.5 py-0.5 text-phx-3xs font-bold uppercase tracking-wider ${VERDICT_STYLE[check.verdict].chip}`}
                  >
                    {VERDICT_STYLE[check.verdict].label}
                  </span>
                </div>

                <p className="mt-1.5 text-phx-md leading-relaxed text-slate-600">{check.detail}</p>

                {check.facts.length > 0 ? (
                  <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {check.facts.map((fact) => (
                      <div className="flex items-baseline gap-1.5" key={`${check.id}-${fact.label}`}>
                        <dt className="text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
                          {fact.label}
                        </dt>
                        <dd className="text-xs font-semibold text-slate-800">{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
              ),
            )}
          </div>

          <p className="text-xs text-slate-500">
            Advisory only — these checks never block payment.
          </p>
        </div>
      ) : null}
    </>
  );

  if (bare) return body;
  if (!collapsible) return <PanelSection title="Claim validation">{body}</PanelSection>;
  return (
    <CollapsibleSection
      defaultOpen={headline === "review"}
      summary={
        state.kind === "loading"
          ? "Checking…"
          : headline
            ? VERDICT_STYLE[headline].label
            : "Could not verify"
      }
      title="Claim checks"
      tone={headline === "review" ? "danger" : headline === "clean" ? "success" : "neutral"}
    >
      {body}
    </CollapsibleSection>
  );
}
