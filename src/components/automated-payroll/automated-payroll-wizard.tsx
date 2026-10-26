"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { stepDefinition } from "@/lib/automated-payroll/step-definitions";
import type {
  DraftRow,
  MonthlySalaryRun,
  NonEmployeePart,
  ReconciliationTotals,
  StepKey,
  StepState,
} from "@/lib/automated-payroll/types";
import { PART1_STEP_KEYS, PART2_STEP_KEYS, stepPhase } from "@/lib/automated-payroll/types";
import type { PopulationDiff } from "@/lib/automated-payroll/population-diff";
import type { HoldReview } from "@/lib/automated-payroll/hold-review";
import {
  PAYROLL_DATA_ISSUE_LABELS,
  type PayrollDataIssue,
  type PayrollDataQualityReport,
} from "@/lib/automated-payroll/data-quality";
import type { PayrollDayCollision } from "@/lib/automated-payroll/day-collisions";
import type { ModuleDriftReport } from "@/lib/automated-payroll/module-drift";
import { columnLabel, isUnbackedCharge, stepOpenDuringPart2 } from "@/lib/automated-payroll/module-sourced-steps";
import { cairoTimeLabel, describeChargeSource } from "@/lib/automated-payroll/cell-history-labels";
import { downloadFromApiRoute } from "@/lib/navigation/browser-navigation";
import { cn } from "@/lib/utils";

import { NonEmployeesPanel } from "./non-employees-panel";
import { RecommendationStep } from "./recommendation-step";
import { SectionHeading } from "./section-shell";
import { SelectField } from "./select-field";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One excluded person as `getRunView` returns them — named, because a panel never shows a code. */
type ExcludedPerson = { hrId: string; fullName: string; reason: string | null };

/**
 * One deduction or expense decision parked while the run was busy, as `getRunView` returns it
 * (`ParkedPayrollResync`, resync-outbox.ts — server-only, so the shape is restated here).
 */
type ParkedResync = { kind: "deduction" | "expense"; people: number; queuedAt: string; attempts: number };

/** "2 deduction decisions and 1 expense decision, for 5 employees, are" — the panel's subject. */
function parkedResyncSubject(parked: ParkedResync[]): string {
  const phrase = (n: number, kind: string) => `${n} ${kind} decision${n === 1 ? "" : "s"}`;
  const deductions = parked.filter((entry) => entry.kind === "deduction").length;
  const expenses = parked.filter((entry) => entry.kind === "expense").length;
  const parts = [];
  if (deductions > 0) parts.push(phrase(deductions, "deduction"));
  if (expenses > 0) parts.push(phrase(expenses, "expense"));
  const total = parked.reduce((sum, entry) => sum + entry.people, 0);
  return `${parts.join(" and ")}, for ${people(total)}, ${parked.length === 1 ? "is" : "are"}`;
}

/**
 * Purely a visual grouping of the same PART1/PART2_STEP_KEYS — no step gains or
 * loses anything, HR just no longer scans one flat row of 10 identical pills to
 * find the one they want (owner feedback 2026-08-08: "very uncomfortable to
 * use"). Keep in sync with PART1_STEP_KEYS / PART2_STEP_KEYS by construction —
 * `renderStepPills` still walks the flat arrays for index numbers and
 * confirm/active state, these groups only decide layout.
 */
const PART1_STEP_GROUPS: { label: string; keys: readonly StepKey[] }[] = [
  { label: "Headcount changes", keys: ["p1_new_hires", "p1_resignations"] },
  {
    label: "Deductions",
    keys: [
      "p1_fingerprint",
      "p1_crm",
      "p1_resignation_crm",
      "p1_unpaid_vacation",
      "p1_no_record",
      "p1_other_deductions",
    ],
  },
  { label: "Special cases & review", keys: ["p1_special_situations", "p1_holds"] },
];

const PART2_STEP_GROUPS: { label: string; keys: readonly StepKey[] }[] = [
  { label: "Expenses & leave", keys: ["p2_expenses", "p2_vacation", "p2_crm"] },
  { label: "Pay adjustments", keys: ["p2_additions", "p2_manual_deductions", "p2_held_release"] },
  { label: "Review", keys: ["p2_holds"] },
];

type Props = {
  initialMonth: number;
  initialYear: number;
  isPublisher: boolean;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** "1 employee" / "6 employees" — the data-quality banner composes several counts. */
function people(count: number): string {
  return `${count} ${count === 1 ? "employee" : "employees"}`;
}

export function AutomatedPayrollWizard({ initialMonth, initialYear, isPublisher }: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [run, setRun] = useState<MonthlySalaryRun | null>(null);
  const [stepStates, setStepStates] = useState<StepState[]>([]);
  const [activeStep, setActiveStep] = useState<StepKey | null>(null);
  /** Whether the currently-open step has unsaved edits — gates the Sheets downloads
   * below, since a downloaded sheet reads saved draft rows only. */
  const [activeStepDirty, setActiveStepDirty] = useState(false);
  /** Which installment's Non-Employees Payroll list is open, if any. */
  const [nonEmployeesOpen, setNonEmployeesOpen] = useState<NonEmployeePart | null>(null);
  const [nonEmployeeCount, setNonEmployeeCount] = useState<Record<NonEmployeePart, number>>({
    first: 0,
    second: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recon, setRecon] = useState<ReconciliationTotals | null>(null);
  /**
   * Each prompt carries the acknowledgment TOKEN the server minted when that gate fired (audit
   * finding 53). The token is the only thing the Acknowledge button can send back: there is no
   * boolean to set, so a warning that was never displayed cannot be answered.
   */
  const [overpaidPrompt, setOverpaidPrompt] = useState<
    { runId: string; message: string; token: string | null } | null
  >(null);
  const [dataIssuePrompt, setDataIssuePrompt] = useState<
    { runId: string; part: "part1" | "part2"; message: string; token: string | null } | null
  >(null);
  const [populationPrompt, setPopulationPrompt] = useState<
    { runId: string; message: string; token: string | null } | null
  >(null);
  /**
   * The acknowledgement tokens already earned in this Part 2 attempt. Every retry sends all of them, so
   * answering one gate can never withdraw the answer to another (audit finding 46): each button used to
   * send only its own flag, and a month raising two gates looped between the two prompts.
   */
  const [part2AckTokens, setPart2AckTokens] = useState<{
    overpaid?: string | null;
    dataQuality?: string | null;
    populationDiff?: string | null;
  }>({});
  const [dataQuality, setDataQuality] = useState<PayrollDataQualityReport | null>(null);
  /** The names behind the data-quality banner — collapsed by default so the
   * headline stays a one-liner instead of a nine-name wall of red. */
  const [dataQualityOpen, setDataQualityOpen] = useState(false);
  const [dayCollisions, setDayCollisions] = useState<PayrollDayCollision[]>([]);
  const [moduleDrift, setModuleDrift] = useState<ModuleDriftReport | null>(null);
  const [moduleDriftOpen, setModuleDriftOpen] = useState(false);
  /** The employee, if any, HR is about to exclude from this run entirely — a
   * separate decision point (with a required reason) from the data-quality
   * acknowledgment above, since exclusion removes them from the sheet rather
   * than just flagging them. */
  const [excludePrompt, setExcludePrompt] = useState<{ hrId: string; fullName: string } | null>(null);
  const [excludeReason, setExcludeReason] = useState("");
  const [, setDraftRows] = useState<DraftRow[]>([]);
  /**
   * Excluded people as the SERVER names them (audit finding 54). A draft row carries only the HR
   * code; the name has to be joined server-side, so this cannot be derived from `draftRows` here.
   */
  const [excludedPeople, setExcludedPeople] = useState<ExcludedPerson[]>([]);
  /**
   * Decisions saved while the run was busy that have NOT reached its figures yet. Null when the
   * server could not read the queue — said on screen, never shown as none.
   */
  const [parkedResyncs, setParkedResyncs] = useState<ParkedResync[] | null>([]);
  const [populationDiff, setPopulationDiff] = useState<PopulationDiff | null>(null);
  /** Who this run is NOT paying, and why — see the panel below the reconciliation. */
  const [holdReview, setHoldReview] = useState<HoldReview | null>(null);

  const confirmedSet = useMemo(
    () => new Set(stepStates.filter((state) => state.status === "confirmed").map((state) => state.stepKey)),
    [stepStates],
  );
  const part1Confirmed = PART1_STEP_KEYS.filter((key) => confirmedSet.has(key)).length;
  const part2Confirmed = PART2_STEP_KEYS.filter((key) => confirmedSet.has(key)).length;
  const part1AllConfirmed = part1Confirmed === PART1_STEP_KEYS.length;
  const part2AllConfirmed = part2Confirmed === PART2_STEP_KEYS.length;

  /**
   * The data-quality banner used to describe every row as "missing payroll data"
   * that "falls back to ... a 0.00 salary". For an employee whose ONLY problem is
   * a zero derived base salary that is simply false — their net salary is on
   * record and this month's pay computes correctly from it; what breaks is the
   * day-rate every future deduction uses. Saying they are about to be
   * paid nothing is the kind of wrong-but-confident alarm people learn to click
   * through (owner-reported 2026-08-08: "those errors are not true").
   *
   * So the two populations are counted separately and the banner describes each
   * in its own words — and when NOBODY has a genuine gap the whole callout drops
   * from danger to warning, because nothing on the sheet is actually wrong yet.
   */
  const dataQualitySplit = useMemo(() => {
    const rows = dataQuality?.rows ?? [];
    const baseOnly = rows.filter(
      (row) => row.issues.length === 1 && row.issues[0] === "zero_base_after_allowances",
    ).length;
    return { baseOnly, missing: rows.length - baseOnly };
  }, [dataQuality]);

  /** Same rows, pivoted issue-first so each explanation is written once and the
   * names sit under it as a plain list. A person with two issues appears in both
   * groups, which is the correct reading — they have two separate things wrong.
   * Kept as {hrId, fullName} rather than a pre-joined string so each name can
   * carry its own "Exclude from this run" action. */
  const dataQualityGroups = useMemo(() => {
    const byIssue = new Map<PayrollDataIssue, { hrId: string; fullName: string }[]>();
    for (const row of dataQuality?.rows ?? []) {
      for (const issue of row.issues) {
        const people = byIssue.get(issue) ?? [];
        people.push({ hrId: row.hrId, fullName: row.fullName });
        byIssue.set(issue, people);
      }
    }
    return Array.from(byIssue, ([issue, people]) => ({ issue, people }));
  }, [dataQuality]);

  /**
   * Stable by design: the panel's own loader depends on this callback, so an
   * inline arrow here would give it a new identity every render and spin its
   * load effect forever.
   */
  const onNonEmployeeCount = useCallback((part: NonEmployeePart, count: number) => {
    setNonEmployeeCount((prev) => ({ ...prev, [part]: count }));
  }, []);

  const loadRun = useCallback(async (m: number, y: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs?month=${m}&year=${y}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load run.");
      setRun(data.run ?? null);
      setStepStates(data.view?.stepStates ?? []);
      setDraftRows(data.view?.draftRows ?? []);
      setExcludedPeople((data.view?.excludedPeople ?? []) as ExcludedPerson[]);
      setParkedResyncs(
        data.view && "parkedResyncs" in data.view ? (data.view.parkedResyncs as ParkedResync[] | null) : [],
      );
      setRecon(null);
      setNonEmployeeCount({ first: 0, second: 0 });
      setPopulationDiff(null);
      setHoldReview(null);
      setDataQuality(null);
      // Every acknowledgement dies with the reload that could have changed what it answered.
      // Keeping them would let a LATER, different disappearance be accepted with no prompt —
      // invisible, where the loop these acks fix was merely annoying.
      setPart2AckTokens({});
      setOverpaidPrompt(null);
      setDataIssuePrompt(null);
      setPopulationPrompt(null);

      // Load the population diff eagerly rather than behind a button: the bug
      // it guards against (someone silently vanishing from payroll) is invisible
      // by definition, so it has to be on screen without anyone thinking to ask.
      const runId = data.run?.id;
      if (runId) {
        void fetch(`/api/automated-payroll/runs/${runId}/population-diff`)
          .then((response) => response.json())
          .then((diffData) => {
            if (diffData?.success) setPopulationDiff(diffData.diff as PopulationDiff);
          })
          .catch(() => {
            /* diff is a safety net, never block the wizard on it */
          });

        // Who this run is not paying. Eager for the same reason as the diff: a
        // held row is DROPPED at publish and writes no payslip, so the reason is
        // readable only until the run is published — and the reconciliation
        // strip reports it as a bare count, which is the one shape that cannot
        // separate a settled owner ruling from an unanswered question.
        void fetch(`/api/automated-payroll/runs/${runId}/hold-review`)
          .then((response) => response.json())
          .then((reviewData) => {
            if (reviewData?.success) setHoldReview(reviewData.review as HoldReview);
          })
          .catch(() => {
            /* the review is a safety net, never block the wizard on it */
          });

        // Same reasoning for missing pay-determining data: a null hire date or a
        // null salary looks like nothing at all on screen, which is exactly how
        // two August starters ended up on the July sheet at a full month's pay.
        void fetch(`/api/automated-payroll/runs/${runId}/data-quality`)
          .then((response) => response.json())
          .then((qualityData) => {
            if (qualityData?.success) setDataQuality(qualityData.report as PayrollDataQualityReport);
          })
          .catch(() => {
            /* a safety net, never block the wizard on it */
          });

        // An absence day claimed by two detectors would be charged twice. Part 2 confirm refuses
        // it outright, so it is shown from the moment the run opens rather than sprung at the last
        // step — see day-collisions.ts.
        void fetch(`/api/automated-payroll/runs/${runId}/day-collisions`)
          .then((response) => response.json())
          .then((collisionData) => {
            if (collisionData?.success) setDayCollisions((collisionData.collisions ?? []) as PayrollDayCollision[]);
          })
          .catch(() => {
            /* a safety net, never block the wizard on it */
          });

        // And whether the Deductions module has changed its mind since a step was confirmed.
        // Confirming copies the module's figure onto the run's own row and the engine reads that
        // row from then on, so a candidate withdrawn afterwards keeps being charged with nothing
        // to show for it. See module-drift.ts.
        void fetch(`/api/automated-payroll/runs/${runId}/module-drift`)
          .then((response) => response.json())
          .then((driftData) => {
            if (driftData?.success) setModuleDrift(driftData.report as ModuleDriftReport);
          })
          .catch(() => {
            /* a safety net, never block the wizard on it */
          });
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load run.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRun(month, year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (url: string, okMessage?: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed.");
      if (okMessage) setNotice(okMessage);
      await loadRun(month, year);
      return data;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Part 2 confirm can be blocked by the overpayment gate (run-service.ts):
   * money already paid out in Part 1 that this month's total can't absorb. The
   * server refuses the first attempt and returns `requiresOverpaidAcknowledgment`
   * with the who/how-much detail, so HR consciously accepts before the sheet
   * becomes payable truth. A split mismatch is NOT acknowledgeable — it means a
   * calculation bug and always hard-blocks via the normal error path.
   */
  const confirmPart2WithOverpaidGate = async (runId: string, acknowledged: typeof part2AckTokens = {}) => {
    // Every token already earned in this attempt goes again with this one (see part2AckTokens).
    const acks = { ...part2AckTokens, ...acknowledged };
    setPart2AckTokens(acks);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/part2/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          acknowledgeOverpaidToken: acks.overpaid ?? null,
          acknowledgeDataIssuesToken: acks.dataQuality ?? null,
          acknowledgePopulationDiffToken: acks.populationDiff ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // One prompt at a time: the gate the server raised now is the only one on screen.
        setDataIssuePrompt(null);
        setOverpaidPrompt(null);
        setPopulationPrompt(null);
        // The token is minted for the warning in `data.error` and nothing else, so it travels with
        // the prompt that displays that sentence.
        const token = typeof data.acknowledgmentToken === "string" ? data.acknowledgmentToken : null;
        if (data.requiresDataQualityAcknowledgment) {
          setDataIssuePrompt({ runId, part: "part2", message: String(data.error ?? ""), token });
          return;
        }
        if (data.requiresPopulationDiffAcknowledgment) {
          setPopulationPrompt({ runId, message: String(data.error ?? ""), token });
          return;
        }
        if (data.requiresOverpaidAcknowledgment) {
          setOverpaidPrompt({ runId, message: String(data.error ?? ""), token });
          return;
        }
        setPart2AckTokens({});
        // A refusal can name a Part 1 step a deduction decision re-opened after this page loaded
        // (module-sourced-steps.ts). Reload first, so that step is unlocked here when HR goes to it.
        await loadRun(month, year);
        throw new Error(data.error ?? "Action failed.");
      }
      setPart2AckTokens({});
      setOverpaidPrompt(null);
      setDataIssuePrompt(null);
      setPopulationPrompt(null);
      setNotice("Part 2 confirmed. Finance roles notified.");
      await loadRun(month, year);
    } catch (actionError) {
      // A transport failure (dropped connection, timeout, non-JSON body) answers nothing:
      // the next attempt must ask every gate again.
      setPart2AckTokens({});
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Part 1 confirm, with the missing-payroll-data gate (owner rule 2026-08-04).
   * Confirming Part 1 freezes real money, so an employee whose hire date, salary
   * or payment mode is missing gets named BEFORE the freeze — HR accepts on the
   * record rather than discovering it on a bank file.
   */
  const confirmPart1WithDataGate = async (runId: string, acknowledgeDataIssuesToken: string | null = null) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/part1/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acknowledgeDataIssuesToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.requiresDataQualityAcknowledgment) {
          setDataIssuePrompt({
            runId,
            part: "part1",
            message: String(data.error ?? ""),
            token: typeof data.acknowledgmentToken === "string" ? data.acknowledgmentToken : null,
          });
          return;
        }
        throw new Error(data.error ?? "Action failed.");
      }
      setDataIssuePrompt(null);
      setNotice("Part 1 confirmed. Finance roles notified.");
      await loadRun(month, year);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Run-scoped exclusion: drops one flagged employee from this run entirely
   * (every step, the audit, assembly/pre-flight) — never their master record.
   * Exists for the one gate the acknowledgment flow above can't cover: a row
   * whose derived Gross Salary is <= 0 hard-blocks Part 2 for everyone, with
   * no acknowledge-and-proceed option (owner-reported 2026-08-08).
   */
  const submitExclude = async () => {
    if (!run || !excludePrompt) return;
    const reason = excludeReason.trim();
    if (!reason) {
      setError("A reason is required to exclude an employee from this run.");
      return;
    }
    const result = await post(
      `/api/automated-payroll/runs/${run.id}/exclude`,
      `${excludePrompt.fullName} excluded from this run.`,
      { hrId: excludePrompt.hrId, reason },
    );
    if (result) {
      setExcludePrompt(null);
      setExcludeReason("");
    }
  };

  /** Reverses submitExclude — the employee re-enters this run's population. */
  const submitInclude = async (hrId: string, fullName: string) => {
    if (!run) return;
    await post(`/api/automated-payroll/runs/${run.id}/include`, `${fullName} re-included in this run.`, { hrId });
  };

  const onStartClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month, year }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start run.");
      await loadRun(month, year);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start run.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * The "& continue" half of "Confirm & continue" (owner-reported 2026-08-04:
   * "when I press confirm & continue it's greyed out and nothing happens").
   *
   * The confirm itself was always working — it was verified landing in
   * automated_payroll_step_state — but the wizard only reloaded the run and left
   * HR sitting on the step they had just finished, with nothing moving. On the
   * Vacation step that reads especially like a hang, because it is the one step
   * whose confirm ALSO re-settles leave balances, so its button stays greyed
   * several times longer than any other.
   *
   * Advancing by position, not by "next unconfirmed": HR works these steps in
   * order, and skipping ahead over a step they deliberately left for later would
   * be its own surprise.
   */
  const onStepConfirmed = async (stepKey: StepKey) => {
    const keys = stepPhase(stepKey) === "part1" ? PART1_STEP_KEYS : PART2_STEP_KEYS;
    const next = keys[keys.indexOf(stepKey) + 1];
    const title = stepDefinition(stepKey).title;
    setNotice(
      next
        ? `${title} confirmed — moved on to ${stepDefinition(next).title}.`
        : `${title} confirmed. That was the last step of this part — you can confirm the part above now.`,
    );
    if (next) setActiveStep(next);
    await loadRun(month, year);
  };

  const loadRecon = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${run.id}/reconcile`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to reconcile.");
      setRecon(data.totals as ReconciliationTotals);
    } catch (reconError) {
      setError(reconError instanceof Error ? reconError.message : "Failed to reconcile.");
    } finally {
      setBusy(false);
    }
  };

  const stepLocked = (stepKey: StepKey): boolean => {
    if (!run) return true;
    // A Part 1 deduction step a decision re-opened during Part 2 stays open, so the block Part 2's
    // confirm raises about it has a button that clears it (module-sourced-steps.ts). Re-confirming it
    // here lands the figure in Part 2; "Unconfirm Part 1" would re-freeze the paid first instalment.
    if (run.phase === "part2" && stepPhase(stepKey) === "part1" && stepOpenDuringPart2(stepKey, stepStates)) {
      return false;
    }
    return run.phase !== stepPhase(stepKey);
  };

  /**
   * Horizontal pill strip instead of a vertical stacked list — frees the 260px
   * sidebar column entirely so the step-nav sits ABOVE the recommendation grid and
   * the grid gets the page's full width (owner request 2026-07-25: the grid was
   * cramped fighting a fixed-width sidebar for space). Pills wrap onto a second
   * line on narrow viewports rather than the row ever h-scrolling.
   *
   * `allKeys` (the full PART1/PART2_STEP_KEYS array) drives the number badge so
   * it stays a stable "step 3 of 10" even though `keys` here is only one visual
   * group's slice — grouping is layout only, never renumbering.
   */
  const renderStepPills = (keys: readonly StepKey[], allKeys: readonly StepKey[]) => (
    <div className="flex flex-wrap gap-2">
      {keys.map((key) => {
        const definition = stepDefinition(key);
        const isConfirmed = confirmedSet.has(key);
        const isActive = activeStep === key;
        const index = allKeys.indexOf(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              setActiveStep(key);
              setNonEmployeesOpen(null);
            }}
            className={cn(
              // shadow-sm + a hover lift on the border is what separates these
              // from flat swatches; the active pill additionally carries a solid
              // left rule so the open step is findable in one glance across a
              // strip of ten look-alikes.
              "flex items-center gap-1.5 border px-2.5 py-1.5 text-xs shadow-sm transition",
              isActive
                ? "border-orange-500 border-l-[3px] bg-orange-50 text-slate-900 shadow-[0_1px_6px_rgba(249,115,22,0.18)]"
                : isConfirmed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:border-emerald-400 hover:bg-emerald-100"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold",
                isConfirmed
                  ? "bg-emerald-600 text-white"
                  : isActive
                    ? "border border-orange-400 bg-white text-orange-700"
                    : "border border-slate-300 text-slate-500",
              )}
            >
              {isConfirmed ? <Check className="size-2.5" /> : index + 1}
            </span>
            <span className={cn("whitespace-nowrap", isActive && "font-semibold")}>{definition.title}</span>
          </button>
        );
      })}
    </div>
  );

  /**
   * The same pills, chunked under a light sub-label (PART1_STEP_GROUPS /
   * PART2_STEP_GROUPS) instead of one flat row of 10 look-alike buttons — the
   * owner's own words were "very uncomfortable to use" on this screen. Nothing
   * about confirm/active state or the number badges changes, only the layout.
   */
  const renderStepGroups = (groups: { label: string; keys: readonly StepKey[] }[], allKeys: readonly StepKey[]) => (
    <div className="flex flex-col gap-2.5">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-wrap items-center gap-2">
          <span className="w-full text-phx-2xs font-bold uppercase tracking-wide text-slate-400 sm:w-auto sm:min-w-[132px]">
            {group.label}
          </span>
          {renderStepPills(group.keys, allKeys)}
        </div>
      ))}
    </div>
  );

  /**
   * Non-Employees Payroll is NOT a StepKey — there is no population to
   * recommend against, just a free-form list HR authors directly (owner rule
   * 2026-07-25) — so it gets its own pill outside the confirm-tracked strip
   * rather than a fake entry in PART1_STEP_KEYS.
   *
   * One pill per installment (owner request 2026-08-03), each rendered inside
   * its own part's strip: a Part 2 non-employee is paid with Part 2, and burying
   * that list under the Part 1 heading is exactly how it would get missed.
   */
  const renderNonEmployeesPill = (part: NonEmployeePart) => {
    const count = nonEmployeeCount[part];
    return (
      <button
        type="button"
        onClick={() => {
          setNonEmployeesOpen(part);
          setActiveStep(null);
        }}
        className={cn(
          "flex items-center gap-1.5 border px-2.5 py-1.5 text-xs transition-colors",
          nonEmployeesOpen === part
            ? "border-orange-500 bg-orange-50 text-slate-900"
            : "border-dashed border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        <span className="whitespace-nowrap">
          Non-Employees Payroll{count > 0 ? ` (${count})` : ""}
        </span>
      </button>
    );
  };

  const phaseTone: Record<MonthlySalaryRun["phase"], "orange" | "emerald" | "neutral" | "slate"> = {
    part1: "orange",
    part2: "orange",
    ready: "emerald",
    published: "emerald",
    cancelled: "slate",
  };

  const phaseLabel = run
    ? { part1: "Part 1 in progress", part2: "Part 2 in progress", ready: "Ready to publish", published: "Published", cancelled: "Cancelled" }[run.phase]
    : "";

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-6">
      <AdminPageHero
        eyebrow="Payroll"
        title="Automated Payroll"
        description="HR-owned monthly salary sheet — Part 1 & Part 2, step by step. The system recommends every number; you confirm or edit."
        aside={
          run ? (
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <AdminInsightChip tone={phaseTone[run.phase]}>{phaseLabel}</AdminInsightChip>
              <AdminInsightChip tone={part1AllConfirmed ? "emerald" : "neutral"}>
                Part 1 · {part1Confirmed}/{PART1_STEP_KEYS.length}
              </AdminInsightChip>
              {run.phase !== "part1" ? (
                <AdminInsightChip tone={part2AllConfirmed ? "emerald" : "neutral"}>
                  Part 2 · {part2Confirmed}/{PART2_STEP_KEYS.length}
                </AdminInsightChip>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <div className={cn(adminPanelClassName, "flex flex-wrap items-end gap-3 p-4")}>
        <SelectField label="Month" value={month} onChange={setMonth}>
          {MONTHS.map((label, index) => (
            <option key={label} value={index + 1}>{label}</option>
          ))}
        </SelectField>
        <SelectField label="Year" value={year} onChange={setYear}>
          {[year - 1, year, year + 1].map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </SelectField>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void loadRun(month, year)}
          className="h-10 border-slate-300 font-bold text-slate-700 shadow-sm hover:bg-slate-100"
        >
          Load
        </Button>
        {!run || run.phase === "published" || run.phase === "cancelled" ? (
          <Button
            disabled={busy}
            onClick={() => void onStartClick()}
            className="h-10 border border-orange-600 bg-orange-600 text-white shadow-sm hover:bg-orange-700"
          >
            Start / Resume run
          </Button>
        ) : (
          <Badge variant="neutral">{phaseLabel}</Badge>
        )}
      </div>

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}

      {/* Unexplained disappearance — the loudest thing on this page by design.
          Someone was paid last month, is absent now, and has no resignation on
          file. That is the exact shape of the 2026-07-25 notice-period bug,
          which was invisible until the owner asked about one person by name. */}
      {populationDiff && populationDiff.disappeared.length > 0 ? (
        <AdminCallout tone="danger">
          <div>
            <div className="font-black">
              {populationDiff.disappeared.length === 1
                ? "1 employee disappeared from payroll with no resignation on file"
                : `${populationDiff.disappeared.length} employees disappeared from payroll with no resignation on file`}
            </div>
            <p className="mt-1 text-xs">
              They were paid last month and are missing from this run. This usually means a data problem, not a real
              departure — check each one before confirming anything.
            </p>
            <ul className="mt-2 flex flex-col gap-0.5 text-xs">
              {populationDiff.disappeared.map((person) => (
                <li key={person.hrId}>
                  <span className="font-semibold">{person.fullName}</span> ({person.hrId})
                </li>
              ))}
            </ul>
          </div>
        </AdminCallout>
      ) : null}

      {/* Decisions that have not reached this run's figures yet (risk review, 26 Oct). Before
          this, one parked after Part 2 was confirmed was dropped without a word. */}
      {run && (run.phase === "part1" || run.phase === "part2" || run.phase === "ready") && parkedResyncs === null ? (
        <AdminCallout tone="warning">
          <div className="min-w-0">
            Could not check whether a deduction or expense decision is still waiting to reach this run.
            Reload the page before confirming Part 2.
          </div>
        </AdminCallout>
      ) : null}
      {run &&
      (run.phase === "part1" || run.phase === "part2" || run.phase === "ready") &&
      parkedResyncs &&
      parkedResyncs.length > 0 ? (
        <AdminCallout tone="warning">
          <div className="min-w-0">
            <div className="font-black">{parkedResyncSubject(parkedResyncs)} waiting to reach this run</div>
            <div className="mt-1 text-xs">
              {run.phase === "ready"
                ? "They were saved after Part 2 was confirmed, so these figures do not include them. Reopen Part 2 to apply them."
                : "They were saved while this run was busy and are being applied now. Part 2 cannot be confirmed until they have reached it — reload in a minute."}
            </div>
          </div>
        </AdminCallout>
      ) : null}

      {/* Who's currently excluded from this run, with the reason and a one-click
          reversal — so an exclusion is never a one-way, un-auditable dead end. */}
      {excludedPeople.length > 0 ? (
        <AdminCallout tone="warning">
          <div className="min-w-0">
            <div className="font-black">{people(excludedPeople.length)} excluded from this run</div>
            <ul className="mt-2 flex flex-col gap-1 text-xs">
              {excludedPeople.map((person) => (
                <li key={person.hrId} className="flex items-center justify-between gap-2">
                  <span>
                    {/* The person, then the code — never the code alone (audit finding 54). This
                        panel asks HR to decide about someone, and a bare B-7 is not someone. */}
                    <span className="font-semibold">{person.fullName}</span> ({person.hrId})
                    {person.reason ? ` — ${person.reason}` : ""}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void submitInclude(person.hrId, person.fullName)}
                    className="shrink-0 font-semibold underline underline-offset-2 disabled:opacity-50"
                  >
                    Include again
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </AdminCallout>
      ) : null}

      {/* Overpayment gate — real money already paid out that this month can't
          absorb. Deliberately NOT a browser confirm(): HR needs to read who and
          how much before accepting, and the acceptance is written to the audit log. */}
      {/* Missing pay-determining data. Loud by design: a null hire date, salary
          or payment mode looks like NOTHING on screen, and each one silently
          becomes a default that pays money — that is how two August starters got
          a full July month (owner-reported 2026-08-04). */}
      {dataQuality && dataQuality.total > 0 ? (
        <AdminCallout tone={dataQualitySplit.missing > 0 ? "danger" : "warning"}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="font-black">
                {dataQualitySplit.missing > 0 && dataQualitySplit.baseOnly > 0
                  ? `${people(dataQualitySplit.missing)} missing payroll data, ${dataQualitySplit.baseOnly} with no base salary`
                  : dataQualitySplit.missing > 0
                    ? `${people(dataQualitySplit.missing)} missing payroll data that decides their pay`
                    : `${people(dataQualitySplit.baseOnly)} with no base salary on record`}
              </div>
              <button
                type="button"
                onClick={() => setDataQualityOpen((open) => !open)}
                className="shrink-0 text-xs font-semibold underline underline-offset-2"
              >
                {dataQualityOpen ? "Hide who" : "Show who"}
              </button>
            </div>
            {/* Collapsed by default and grouped BY ISSUE, not by person: the old
                shape repeated the same long sentence under all nine names, which
                is what made this unreadable (owner, 2026-08-08: "very big and
                ugly"). One explanation per issue, then a plain list of names. */}
            {dataQualityOpen ? (
              <div className="mt-2 flex flex-col gap-2 text-xs">
                {dataQualityGroups.map((group) => (
                  <div key={group.issue}>
                    <div className="font-semibold">
                      {people(group.people.length)} — {PAYROLL_DATA_ISSUE_LABELS[group.issue]}
                    </div>
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {group.people.map((person) => (
                        <li key={person.hrId} className="flex items-center justify-between gap-2 opacity-80">
                          <span>
                            {person.fullName} ({person.hrId})
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setExcludeReason("");
                              setExcludePrompt(person);
                            }}
                            className="shrink-0 font-semibold underline underline-offset-2 disabled:opacity-50"
                          >
                            Exclude from this run
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div className="opacity-80">
                  Fix them on the employee record; confirming with these open needs your acknowledgment.
                </div>
              </div>
            ) : null}
          </div>
        </AdminCallout>
      ) : null}

      {/* The Deductions module has moved since a step was confirmed.
          DANGER once a STALE charge is present, because Part 2 confirm now refuses it (owner
          decision 2026-10-06) — under the push gate a figure goes stale by the ordinary order of
          work, not only because somebody changed their mind, so the old "warning, never a gate"
          reading let a run pay a number the module had already replaced.
          A row whose figure differs from the confirm still wins and never blocks — those keep the
          warning tone they always had. It is called hand-typed ONLY when the cell history says a
          person saved it: a figure another step's confirm wrote differs just the same. Re-confirm the step to take the
          module's current figure; a Part 1 step stays confirmable while the run is in Part 2. */}
      {moduleDrift && moduleDrift.rows.length > 0 ? (
        <AdminCallout tone={moduleDrift.staleCharges > 0 ? "danger" : "warning"}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="font-black">
                {moduleDrift.staleCharges > 0
                  ? `${people(moduleDrift.staleCharges)} carrying a deduction the Deductions module no longer proposes — Part 2 cannot be confirmed until you re-confirm their step`
                  : moduleDrift.overriddenButMoved > 0
                    ? `${people(moduleDrift.overriddenButMoved)} whose module figure moved after you confirmed`
                    : `${people(moduleDrift.unbackedCharges)} carrying a deduction with no approved line behind it — check it against the other columns on the same row`}
              </div>
              <button
                type="button"
                onClick={() => setModuleDriftOpen((open) => !open)}
                className="shrink-0 text-xs font-semibold underline underline-offset-2"
              >
                {moduleDriftOpen ? "Hide who" : "Show who"}
              </button>
            </div>
            {moduleDriftOpen ? (
              <div className="mt-2 flex flex-col gap-1 text-xs">
                {moduleDrift.rows.map((row) => (
                  <div key={`${row.stepKey}:${row.hrId}:${row.field}`} className="opacity-80">
                    {/* An unbacked charge never moved — both sides of the comparison are 0.00, so
                        "confirmed at 0.00, the module now says 0.00" would read as nothing being
                        wrong while the row is the whole finding. State the charge instead. */}
                    {isUnbackedCharge(row) ? (
                      <>
                        {row.fullName}, {columnLabel(row.stepKey, row.field)} — this run charges {row.charged.toFixed(2)} and
                        the Deductions module has no approved line behind any of it,{" "}
                        {describeChargeSource(row.chargeSource, cairoTimeLabel)}
                      </>
                    ) : (
                      <>
                        {row.fullName}, {columnLabel(row.stepKey, row.field)} — confirmed at {row.proposedAtConfirm.toFixed(2)}, the module now
                        says {row.proposedNow.toFixed(2)}
                        {row.overridden
                          ? `; this run charges ${row.charged.toFixed(2)}, ${describeChargeSource(row.chargeSource, cairoTimeLabel)}`
                          : `; this run still charges ${row.charged.toFixed(2)}`}
                      </>
                    )}
                  </div>
                ))}
                <div className="opacity-80">
                  {moduleDrift.staleCharges > 0
                    ? "Open each step named above and confirm it again — it now takes the module's current figure for every line nobody changed. A figure that differs from the one confirmed still stands and is not blocking anything."
                    : moduleDrift.overriddenButMoved > 0
                      ? "Nothing here is wrong on its own. Re-open the step and re-enter a figure to take the module's new one."
                      : "Nothing here blocks Part 2 — a deduction HR typed by hand has no module line by design and is correct. Open the step and clear the figure only where the same money is already being charged in another column."}
                </div>
              </div>
            ) : null}
          </div>
        </AdminCallout>
      ) : null}

      {/* One absence day claimed by two detectors. DANGER, and stated as a block rather than a
          warning, because Part 2 confirm refuses it: the Deductions module already treats an
          overlap as something a human clears, and payroll cannot judge which of the two claims is
          the wrong one. */}
      {dayCollisions.length > 0 ? (
        <AdminCallout tone="danger">
          <div className="min-w-0 flex-1">
            <div className="font-black">
              {people(dayCollisions.length)} would be charged twice for the same day
            </div>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs">
              {dayCollisions.map((collision) => (
                <li key={`${collision.hrId}:${collision.date}`} className="opacity-80">
                  {collision.fullName} on {collision.date} — claimed by {collision.categories.join(" + ")}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs opacity-80">
              Clear the wrong claim in the Deductions module. Part 2 cannot be confirmed until this is resolved.
            </p>
          </div>
        </AdminCallout>
      ) : null}

      {/* Run-scoped exclusion — a separate, named action from the acknowledgment
          below: acknowledgment lets the row through with a flag, this removes it
          from the sheet entirely. Requires a reason so the decision is answerable
          later (written to the audit log by excludeEmployeeFromRun). */}
      {excludePrompt ? (
        <AdminCallout tone="warning">
          <div>
            <div className="font-black">
              Exclude {excludePrompt.fullName} ({excludePrompt.hrId}) from this run?
            </div>
            <p className="mt-1 text-xs">
              They will be dropped from every step, the pre-flight check, and the final sheet for this month only —
              their employee record and every other run are untouched. Reversible any time from the &quot;Excluded
              from this run&quot; list above.
            </p>
            <Input
              value={excludeReason}
              onChange={(event) => setExcludeReason(event.target.value)}
              placeholder="Reason (required) — e.g. same-day hire/termination, no base salary on record"
              className="mt-2"
            />
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={busy || !excludeReason.trim()}
                onClick={() => void submitExclude()}
                className="border border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
              >
                Exclude from this run
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setExcludePrompt(null);
                  setExcludeReason("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </AdminCallout>
      ) : null}

      {/* The acknowledgement itself — a separate decision point from the banner,
          and written to the audit log so a knowingly-confirmed gap is answerable. */}
      {dataIssuePrompt ? (
        <AdminCallout tone="warning">
          <div>
            <div className="font-black">
              Missing payroll data — your acknowledgment is required to confirm{" "}
              {dataIssuePrompt.part === "part1" ? "Part 1" : "Part 2"}
            </div>
            <p className="mt-1 text-xs">{dataIssuePrompt.message}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void (dataIssuePrompt.part === "part1"
                    ? confirmPart1WithDataGate(dataIssuePrompt.runId, dataIssuePrompt.token)
                    : confirmPart2WithOverpaidGate(dataIssuePrompt.runId, {
                        dataQuality: dataIssuePrompt.token,
                      }))
                }
                className="border border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
              >
                Acknowledge &amp; confirm {dataIssuePrompt.part === "part1" ? "Part 1" : "Part 2"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDataIssuePrompt(null);
                  setPart2AckTokens({});
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </AdminCallout>
      ) : null}

      {overpaidPrompt ? (
        <AdminCallout tone="warning">
          <div>
            <div className="font-black">Part 1 overpayment — your acknowledgment is required</div>
            <p className="mt-1 text-xs">{overpaidPrompt.message}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void confirmPart2WithOverpaidGate(overpaidPrompt.runId, { overpaid: overpaidPrompt.token })
                }
                className="border border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
              >
                Acknowledge &amp; confirm Part 2
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setOverpaidPrompt(null);
                  setPart2AckTokens({});
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </AdminCallout>
      ) : null}

      {populationPrompt ? (
        <AdminCallout tone="warning">
          <div>
            <div className="font-black">Someone paid last month is missing — your acknowledgment is required</div>
            <p className="mt-1 text-xs">{populationPrompt.message}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void confirmPart2WithOverpaidGate(populationPrompt.runId, {
                    populationDiff: populationPrompt.token,
                  })
                }
                className="border border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
              >
                Acknowledge &amp; confirm Part 2
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPopulationPrompt(null);
                  setPart2AckTokens({});
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </AdminCallout>
      ) : null}

      {!run ? (
        <div className={cn(adminPanelClassName, "p-8 text-center text-sm text-slate-500")}>
          Choose a month and start a run to begin.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Horizontal step-nav + actions — sits above the grid instead of beside it,
              so the grid below gets the full page width (was squeezed into a 1fr column
              fighting a fixed 260px sidebar for space). */}
          <div className={cn(adminSoftPanelClassName, "flex flex-col gap-3 p-4")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionHeading title="Part 1 — First installment" />
              <Button
                size="sm"
                className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                disabled={busy || !part1AllConfirmed || run.phase !== "part1"}
                onClick={() => void confirmPart1WithDataGate(run.id)}
              >
                Confirm Part 1
              </Button>
            </div>
            <div className="flex flex-col gap-2.5">
              {renderStepGroups(PART1_STEP_GROUPS, PART1_STEP_KEYS)}
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-full text-phx-2xs font-bold uppercase tracking-wide text-slate-400 sm:w-auto sm:min-w-[132px]">
                  No HR record
                </span>
                {renderNonEmployeesPill("first")}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-3">
              {run.phase === "part1" ? (
                <div className="text-xs text-slate-400">Confirm Part 1 to unlock Part 2.</div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <SectionHeading title="Part 2 — Full sheet" />
                    <div className="flex items-center gap-2">
                      {run.phase === "part2" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-red-300 text-red-700 hover:bg-red-50"
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm("Unconfirm Part 1? This clears every employee's frozen First Part so it can be recomputed from current data.")) return;
                            void post(`/api/automated-payroll/runs/${run.id}/part1/unconfirm`, "Part 1 unconfirmed. First Part values cleared for recompute.");
                          }}
                        >
                          Unconfirm Part 1
                        </Button>
                      ) : null}
                      {run.phase === "ready" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-red-300 text-red-700 hover:bg-red-50"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                "Reopen Part 2? Every step is locked while Part 2 is confirmed, because finance may already have executed this month's bank files. Reopening is the only way to change a figure, and it undoes this run's carry-forward entries until you confirm again.",
                              )
                            )
                              return;
                            void post(
                              `/api/automated-payroll/runs/${run.id}/part2/unconfirm`,
                              "Part 2 reopened. Steps are editable again; confirm Part 2 to re-lock the sheet.",
                            );
                          }}
                        >
                          Reopen Part 2
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                        disabled={busy || !part2AllConfirmed || run.phase !== "part2"}
                        onClick={() => void confirmPart2WithOverpaidGate(run.id)}
                      >
                        Confirm Part 2
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {renderStepGroups(PART2_STEP_GROUPS, PART2_STEP_KEYS)}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-full text-phx-2xs font-bold uppercase tracking-wide text-slate-400 sm:w-auto sm:min-w-[132px]">
                        No HR record
                      </span>
                      {renderNonEmployeesPill("second")}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
              <SectionHeading title="Sheets" />
              <Button
                variant="outline"
                size="sm"
                disabled={activeStepDirty}
                title={activeStepDirty ? "Save or confirm the open step first — the sheet reads saved values only." : undefined}
                onClick={() => downloadFromApiRoute(`/api/automated-payroll/runs/${run.id}/sheet?variant=part1`)}
              >
                Part 1 sheet
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={activeStepDirty}
                title={activeStepDirty ? "Save or confirm the open step first — the sheet reads saved values only." : undefined}
                onClick={() => downloadFromApiRoute(`/api/automated-payroll/runs/${run.id}/sheet?variant=full`)}
              >
                Full sheet
              </Button>
              {activeStepDirty ? (
                <span className="text-xs font-medium text-orange-600">
                  Unsaved changes on this step — save or confirm it to include them in a download.
                </span>
              ) : null}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadRecon()}>Reconcile</Button>
              {run.phase === "ready" && isPublisher ? (
                <Button
                  size="sm"
                  className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                  disabled={busy}
                  onClick={() => void post(`/api/automated-payroll/runs/${run.id}/publish`, "Published to payslips.")}
                >
                  Publish to payslips
                </Button>
              ) : null}
              {run.phase === "ready" && !isPublisher ? (
                <span className="text-xs text-slate-500">Part 2 confirmed — only a System Admin can publish.</span>
              ) : null}
              {run.phase === "published" ? (
                <Badge variant="success">Published to payslips</Badge>
              ) : null}
            </div>
          </div>

          {/* Roster movement vs last month — the calm version of the alarm above.
              Names people rather than counting them, because a joiner can mask a
              disappearance in a pure headcount comparison. */}
          {populationDiff && !populationDiff.noBaseline ? (
            <div className={cn(adminSoftPanelClassName, "flex flex-col gap-2 p-4")}>
              <div className="flex flex-wrap items-center gap-2">
                <SectionHeading title="Roster vs last month" />
                <AdminInsightChip tone="neutral">
                  {populationDiff.currentHeadcount} now · {populationDiff.previousHeadcount} last month
                </AdminInsightChip>
                {populationDiff.joined.length > 0 ? (
                  <AdminInsightChip tone="emerald">+{populationDiff.joined.length} joined</AdminInsightChip>
                ) : null}
                {populationDiff.left.length > 0 ? (
                  <AdminInsightChip tone="slate">−{populationDiff.left.length} left</AdminInsightChip>
                ) : null}
              </div>
              {populationDiff.joined.length > 0 || populationDiff.left.length > 0 ? (
                <div className="grid gap-3 text-xs sm:grid-cols-2">
                  {populationDiff.joined.length > 0 ? (
                    <div>
                      <div className="font-semibold text-emerald-700">Joined</div>
                      <ul className="mt-0.5 flex flex-col gap-0.5 text-slate-600">
                        {populationDiff.joined.map((person) => (
                          <li key={person.hrId}>
                            {person.fullName} ({person.hrId})
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {populationDiff.left.length > 0 ? (
                    <div>
                      <div className="font-semibold text-slate-700">Left</div>
                      <ul className="mt-0.5 flex flex-col gap-0.5 text-slate-600">
                        {populationDiff.left.map((person) => (
                          <li key={person.hrId}>
                            {person.fullName} ({person.hrId})
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs text-slate-500">No joiners or leavers vs last month.</div>
              )}
            </div>
          ) : null}

          {recon ? (
            <div className={cn(adminPanelClassName, "grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 lg:grid-cols-8")}>
              <Stat label="Employees" value={String(recon.headcount)} />
              <Stat label="Held" value={String(recon.held)} tone={recon.held ? "rose" : "slate"} />
              <Stat label="Σ First Part" value={money(recon.totalFirstPart)} />
              <Stat label="Σ Second Part" value={money(recon.totalSecondPart)} />
              <Stat label="Σ Month Salary" value={money(recon.totalMonthSalary)} />
              <Stat label="New hires" value={String(recon.joiners)} />
              <Stat label="Resignations" value={String(recon.leavers)} />
              <Stat
                label="Split OK"
                value={recon.splitMismatches.length === 0 ? "balanced" : `${recon.splitMismatches.length} off`}
                tone={recon.splitMismatches.length === 0 ? "emerald" : "rose"}
              />
            </div>
          ) : null}

          {/* Who this run is NOT paying, and why.
              The reconciliation strip above reports holds as a bare count, and a
              count is the one shape that cannot separate a settled owner ruling
              from an unanswered question — August 2026 read "Held: 13" while two
              of those were the continuation of a July ruling and eleven were new
              decisions with nothing recorded. A held row is dropped at publish
              and writes no payslip, so this is the last screen on which the
              reason can still be read at all. Named, never counted — the same
              rule as the roster panel above. */}
          {holdReview && holdReview.heldCount > 0 ? (
            <div className={cn(adminSoftPanelClassName, "flex flex-col gap-3 p-4")}>
              <div className="flex flex-wrap items-center gap-2">
                <SectionHeading title="Held — not paid from this run" />
                <AdminInsightChip tone="orange">{holdReview.heldCount} held</AdminInsightChip>
                {holdReview.unexplainedCount > 0 ? (
                  <AdminInsightChip tone="orange">
                    {holdReview.unexplainedCount} with no reason recorded
                  </AdminInsightChip>
                ) : (
                  <AdminInsightChip tone="emerald">every hold has a reason</AdminInsightChip>
                )}
                {holdReview.continuedCount > 0 ? (
                  <AdminInsightChip tone="neutral">
                    {holdReview.continuedCount} continued from {holdReview.priorMonthLabel}
                  </AdminInsightChip>
                ) : null}
              </div>

              <p className="text-xs text-slate-600">
                A held employee is dropped when this run is published: no payslip and no salary record
                is written for them, and nothing else records that they were paid outside the system.
                The reason below is the only durable record of why.
              </p>

              {holdReview.unexplainedCount > 0 ? (
                <p className="border-l-4 border-rose-500 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">
                  The hold step cannot be confirmed until each of these has a reason, so Part 2 and the
                  publish are blocked until then.
                </p>
              ) : null}

              {/* A stack, not a table: this has to stay readable at 375px without a
                  horizontal scroll, and a reason is free text that must wrap rather
                  than be cut off. */}
              <ul className="flex flex-col gap-2">
                {holdReview.held.map((person) => (
                  <li
                    key={person.hrId}
                    className={cn(
                      "flex flex-col gap-1 border-l-4 px-3 py-2",
                      person.reason === null ? "border-rose-500 bg-rose-50/70" : "border-slate-300 bg-slate-50",
                    )}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-slate-800">{person.fullName}</span>
                      <span className="text-[11px] text-slate-500">{person.hrId}</span>
                      {person.jobTitle ? (
                        <span className="text-[11px] text-slate-500">· {person.jobTitle}</span>
                      ) : null}
                      {person.continuity === "continued" ? (
                        <span className="text-[11px] font-black uppercase tracking-wide text-amber-700">
                          Also held in {holdReview.priorMonthLabel}
                        </span>
                      ) : (
                        <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                          New this month
                        </span>
                      )}
                    </div>

                    {person.reason ? (
                      <span className="break-words text-[12px] text-slate-700">{person.reason}</span>
                    ) : (
                      <span className="break-words text-[12px] font-semibold text-rose-800">
                        No reason recorded — nothing explains why this person is not being paid.
                      </span>
                    )}

                    {/* Last month's own words, shown even when this month has its own
                        reason: "held again, and here is what was said then" is the
                        question this run cannot answer about itself. Suppressed only
                        when the reason ALREADY is that text, carried forward, so the
                        same sentence is not printed twice. */}
                    {person.priorHold && !person.carriedForward ? (
                      <span className="break-words text-[11px] text-amber-800">
                        {holdReview.priorMonthLabel}:{" "}
                        {person.priorHold.reason ??
                          "no reason was recorded that month either — this hold has never been explained."}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={cn(adminPanelClassName, "p-4")}>
            {nonEmployeesOpen ? (
              <NonEmployeesPanel
                key={`${run.id}-${nonEmployeesOpen}`}
                runId={run.id}
                part={nonEmployeesOpen}
                locked={run.phase !== (nonEmployeesOpen === "first" ? "part1" : "part2")}
                onChange={onNonEmployeeCount}
              />
            ) : activeStep ? (
              <RecommendationStep
                key={`${run.id}-${activeStep}`}
                runId={run.id}
                stepKey={activeStep}
                confirmed={confirmedSet.has(activeStep)}
                locked={stepLocked(activeStep)}
                onConfirmed={() => void onStepConfirmed(activeStep)}
                onDirtyChange={setActiveStepDirty}
              />
            ) : (
              <div className="p-6 text-center text-sm text-slate-500">Select a step above to begin.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "rose" | "emerald" }) {
  const toneClass =
    tone === "rose" ? "text-rose-700" : tone === "emerald" ? "text-emerald-700" : "text-slate-900";
  return (
    <div className="border border-slate-200 bg-white px-3 py-2">
      <div className="text-phx-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cn("text-lg font-black", toneClass)}>{value}</div>
    </div>
  );
}
