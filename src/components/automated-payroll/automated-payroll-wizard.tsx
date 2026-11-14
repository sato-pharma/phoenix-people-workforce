"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-kit";
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
  PAYROLL_DATA_ISSUE_AFFECTS_PAY,
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

import { DownloadHistoryPanel } from "./download-history-panel";
import { formatPayrollDay, formatPayrollMoney, peopleCount } from "./format";
import { HeldEnteredPanel } from "./held-entered-panel";
import { LateExpensesPanel } from "./late-expenses-panel";
import { NonEmployeesPanel } from "./non-employees-panel";
import { RecommendationStep } from "./recommendation-step";
import { SectionHeading } from "./section-shell";
import { SelectField } from "./select-field";

/**
 * A reopen refused because finance already downloaded a bank file starts with these words, and the
 * shortest reason that lets it through — both mirror bank-file-downloads.ts (a server module the page
 * cannot import), and tests/automated-payroll-bank-file-download-guard.test.ts pins them equal.
 */
const DOWNLOAD_REFUSAL_OPENING = "finance has already downloaded";
const OVERRIDE_MIN_REASON = 10;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The first year this module has a run for. The Year list starts here, so it never shifts under the hand. */
const FIRST_PAYROLL_YEAR = 2026;

/**
 * A response's JSON. A body that is not JSON — a gateway's error page, a sign-in redirect, a dropped
 * connection — is said in words: the raw parse error ("Unexpected token <") tells HR nothing, and on a
 * confirm it leaves them guessing whether the money moved.
 */
async function readJson(res: Response): ReturnType<Response["json"]> {
  try {
    return await res.json();
  } catch {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "Your session has ended. Sign in again, then reload this page."
        : `The server did not answer properly (${res.status}). Reload the page to see where the run stands before trying again.`,
    );
  }
}

/**
 * The five checks the page runs on its own when a run opens, as HR would name them. One that could
 * not be read is listed by these words — it was not checked, which is not the same as clear.
 */
const RUN_CHECK_LABELS = {
  populationDiff: "who left the payroll since last month",
  holdReview: "who is held and why",
  dataQuality: "missing payroll data",
  dayCollisions: "days charged twice",
  moduleDrift: "deductions changed since a step was confirmed",
} as const;
type RunCheckKey = keyof typeof RUN_CHECK_LABELS;

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
  { label: "Pay adjustments", keys: ["p1_held_release", "p1_pay_deferral"] },
  { label: "Special cases & review", keys: ["p1_special_situations", "p1_holds"] },
];

const PART2_STEP_GROUPS: { label: string; keys: readonly StepKey[] }[] = [
  { label: "Expenses & leave", keys: ["p2_expenses", "p2_vacation", "p2_crm"] },
  { label: "Pay adjustments", keys: ["p2_additions", "p2_manual_deductions", "p2_held_release", "p2_pay_deferral"] },
  { label: "Review", keys: ["p2_holds"] },
];

type Props = {
  initialMonth: number;
  initialYear: number;
  isPublisher: boolean;
};

// The module's one way of writing money and head counts (format.ts): this file used to carry its own,
// which wrote 1,250 here beside 1,250.00 on the step below.
const money = formatPayrollMoney;
const people = peopleCount;

export function AutomatedPayrollWizard({ initialMonth, initialYear, isPublisher }: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [run, setRun] = useState<MonthlySalaryRun | null>(null);
  const [stepStates, setStepStates] = useState<StepState[]>([]);
  const [activeStep, setActiveStep] = useState<StepKey | null>(null);
  /** Whether the currently-open step has unsaved edits — gates the Sheets downloads
   * below, since a downloaded sheet reads saved draft rows only. */
  const [activeStepDirty, setActiveStepDirty] = useState(false);
  // Bumped when a held amount is entered or removed above Held Salary Release, so the step reloads
  // and the person shows there with the amount outstanding (it is part of the step's key).
  const [heldEnteredVersion, setHeldEnteredVersion] = useState(0);
  /** Which installment's Non-Employees Payroll list is open, if any. */
  const [nonEmployeesOpen, setNonEmployeesOpen] = useState<NonEmployeePart | null>(null);
  const [nonEmployeeCount, setNonEmployeeCount] = useState<Record<NonEmployeePart, number>>({
    first: 0,
    second: 0,
  });
  const [busy, setBusy] = useState(false);
  /**
   * The one in-page "are you sure" for the three moves that cannot be taken back quietly: publish,
   * unconfirm Part 1 and reopen Part 2. A browser confirm() is a grey box HR clicks through; publish
   * had none at all, and it writes every payslip and tells the whole company.
   */
  const [pendingAction, setPendingAction] = useState<{
    title: string;
    body: string;
    label: string;
    url: string;
    ok: string;
    /** Reopen Part 1 / Part 2: refused after a bank-file download unless a reason is given (REC-035). */
    overridable?: boolean;
  } | null>(null);
  /**
   * The reopen the server refused because finance already downloaded a bank file (bank-file-downloads.ts),
   * waiting for the reason that lets it through. The server keeps the reason on the reopen's audit row.
   */
  const [downloadOverride, setDownloadOverride] = useState<{
    title: string;
    label: string;
    url: string;
    ok: string;
    message: string;
  } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  // The confirm sits with the page's messages, far above the Part 2 buttons that open it. Measured on
  // production: pressing "Unconfirm Part 1" opened it out of sight, so the click looked dead. Bring it
  // into view, and hand the keyboard to it.
  useEffect(() => {
    if (!pendingAction) return;
    const dialog = document.getElementById("payroll-pending-action");
    dialog?.scrollIntoView({ block: "center", behavior: "smooth" });
    dialog?.focus({ preventScroll: true });
  }, [pendingAction]);
  useEffect(() => {
    if (!downloadOverride) return;
    const dialog = document.getElementById("payroll-download-override");
    dialog?.scrollIntoView({ block: "center", behavior: "smooth" });
    dialog?.focus({ preventScroll: true });
  }, [downloadOverride]);
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
  // A third population, same reasoning (owner, 2026-11-09): a person whose only gap is the social
  // insurance wage is a FILING gap — PAYROLL_DATA_ISSUE_AFFECTS_PAY says it moves nobody's money —
  // so they are never counted under "missing payroll data that decides their pay".
  const dataQualitySplit = useMemo(() => {
    let missing = 0;
    let baseOnly = 0;
    let filingOnly = 0;
    for (const row of dataQuality?.rows ?? []) {
      const payIssues = row.issues.filter((issue) => PAYROLL_DATA_ISSUE_AFFECTS_PAY[issue]);
      if (payIssues.length === 0) filingOnly += 1;
      else if (payIssues.every((issue) => issue === "zero_base_after_allowances")) baseOnly += 1;
      else missing += 1;
    }
    return { missing, baseOnly, filingOnly };
  }, [dataQuality]);
  const dataQualityHeadline = [
    dataQualitySplit.missing > 0 ? `${people(dataQualitySplit.missing)} missing payroll data that decides their pay` : null,
    dataQualitySplit.baseOnly > 0 ? `${people(dataQualitySplit.baseOnly)} with no base salary on record` : null,
    dataQualitySplit.filingOnly > 0
      ? `${people(dataQualitySplit.filingOnly)} with no social insurance wage (pay not affected)`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

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

  /**
   * Every load is numbered and only the newest one may write to the screen. Without it, a slow answer
   * for the month HR just left lands after the month they moved to — and its checks (who vanished,
   * who is held, days charged twice) appear under the wrong month's name.
   */
  const loadSeq = useRef(0);
  /** The period whose run is on screen, as "2026-11". A load for any other period starts from blank. */
  const loadedPeriod = useRef<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  /** The checks that could not be read for this run — named on screen, never shown as all clear. */
  const [unreadChecks, setUnreadChecks] = useState<RunCheckKey[]>([]);
  /**
   * A move that would drop unsaved edits on the open step — another step, the other list, another
   * month — waits here for HR to choose. Before this, the click simply threw the edits away.
   */
  const [pendingNav, setPendingNav] = useState<{ message: string; go: () => void } | null>(null);

  const loadRun = useCallback(async (m: number, y: number) => {
    const seq = ++loadSeq.current;
    const periodKey = `${y}-${m}`;
    if (loadedPeriod.current !== periodKey) {
      // Another month: nothing from the one on screen may stay up while this one loads.
      loadedPeriod.current = null;
      setRun(null);
      setStepStates([]);
      setExcludedPeople([]);
      setParkedResyncs([]);
      setRecon(null);
      setPopulationDiff(null);
      setHoldReview(null);
      setDayCollisions([]);
      setModuleDrift(null);
      setUnreadChecks([]);
      setLoadState("loading");
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs?month=${m}&year=${y}`);
      const data = await readJson(res);
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? "Failed to load run.");
      loadedPeriod.current = periodKey;
      setLoadState("loaded");
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
      // These two were never reset, so a month with no collision kept showing the last month's.
      setDayCollisions([]);
      setModuleDrift(null);
      setUnreadChecks([]);
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
        // Each check is a safety net and never blocks the wizard — but one that could not be read is
        // NOT an all clear. It used to fail with no word, which on screen looks exactly like "nobody
        // vanished, nobody is held, no day is charged twice". Now it is named in its own callout.
        const runCheck = (key: RunCheckKey, path: string, apply: (body: Awaited<ReturnType<typeof readJson>>) => void) => {
          const markUnread = () => {
            if (seq === loadSeq.current) setUnreadChecks((current) => (current.includes(key) ? current : [...current, key]));
          };
          void fetch(`/api/automated-payroll/runs/${runId}/${path}`)
            .then(readJson)
            .then((body) => {
              if (seq !== loadSeq.current) return;
              if (body?.success) apply(body);
              else markUnread();
            })
            .catch(markUnread);
        };

        runCheck("populationDiff", "population-diff", (body) => setPopulationDiff(body.diff as PopulationDiff));

        // Who this run is not paying. Eager for the same reason as the diff: a
        // held row is DROPPED at publish and writes no payslip, so the reason is
        // readable only until the run is published — and the reconciliation
        // strip reports it as a bare count, which is the one shape that cannot
        // separate a settled owner ruling from an unanswered question.
        runCheck("holdReview", "hold-review", (body) => setHoldReview(body.review as HoldReview));

        // Same reasoning for missing pay-determining data: a null hire date or a
        // null salary looks like nothing at all on screen, which is exactly how
        // two August starters ended up on the July sheet at a full month's pay.
        runCheck("dataQuality", "data-quality", (body) => setDataQuality(body.report as PayrollDataQualityReport));

        // An absence day claimed by two detectors would be charged twice. Part 2 confirm refuses
        // it outright, so it is shown from the moment the run opens rather than sprung at the last
        // step — see day-collisions.ts.
        runCheck("dayCollisions", "day-collisions", (body) =>
          setDayCollisions((body.collisions ?? []) as PayrollDayCollision[]),
        );

        // And whether the Deductions module has changed its mind since a step was confirmed.
        // Confirming copies the module's figure onto the run's own row and the engine reads that
        // row from then on, so a candidate withdrawn afterwards keeps being charged with nothing
        // to show for it. See module-drift.ts.
        runCheck("moduleDrift", "module-drift", (body) => setModuleDrift(body.report as ModuleDriftReport));
      }
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      if (loadedPeriod.current !== periodKey) setLoadState("failed");
      setError(loadError instanceof Error ? loadError.message : "Failed to load run.");
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, []);

  /**
   * Run `go` now, or — when the open step has unsaved edits it would drop — hold it until HR says to
   * leave without saving. `what` finishes the sentence "Moving to … drops them".
   */
  const guardedNav = (what: string, go: () => void) => {
    if (!activeStepDirty) {
      setPendingNav(null);
      go();
      return;
    }
    const open = activeStep
      ? stepDefinition(activeStep).title
      : nonEmployeesOpen
        ? "The Non-Employees Payroll list"
        : "This step";
    setPendingNav({ message: `${open} has changes that are not saved. Moving to ${what} drops them.`, go });
  };

  /** Month and Year load as soon as they change: the screen never shows one month under another's name. */
  const choosePeriod = (m: number, y: number) => {
    guardedNav(`${MONTHS[m - 1]} ${y}`, () => {
      setMonth(m);
      setYear(y);
      setNotice(null);
      void loadRun(m, y);
    });
  };

  const openStep = (key: StepKey) => {
    if (key === activeStep && !nonEmployeesOpen) return;
    guardedNav(stepDefinition(key).title, () => {
      setActiveStep(key);
      setNonEmployeesOpen(null);
    });
  };

  const openNonEmployees = (part: NonEmployeePart) => {
    if (nonEmployeesOpen === part) return;
    guardedNav(`the ${part === "first" ? "Part 1" : "Part 2"} Non-Employees Payroll list`, () => {
      setNonEmployeesOpen(part);
      setActiveStep(null);
    });
  };

  const yearOptions = useMemo(() => {
    const last = Math.max(initialYear + 1, year);
    const years: number[] = [];
    for (let value = Math.min(FIRST_PAYROLL_YEAR, year); value <= last; value += 1) years.push(value);
    return years;
  }, [initialYear, year]);
  const periodLabel = `${MONTHS[month - 1]} ${year}`;

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
      const data = await readJson(res);
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
   * Reopen Part 1 or Part 2. A refusal because finance already downloaded a bank file opens the override
   * prompt instead of a plain error; sending it again with a reason (`override`) lets the reopen through.
   */
  const postReopen = async (
    action: { title: string; label: string; url: string; ok: string },
    override?: { reason: string },
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(action.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(override ? { overrideDownloaded: true, reason: override.reason } : {}),
      });
      const data = await readJson(res);
      if (!res.ok) {
        const message = String(data.error ?? "Action failed.");
        if (res.status === 409 && message.startsWith(DOWNLOAD_REFUSAL_OPENING)) {
          setDownloadOverride({ ...action, message });
          if (!override) setOverrideReason("");
          return null;
        }
        throw new Error(message);
      }
      setDownloadOverride(null);
      setOverrideReason("");
      setNotice(action.ok);
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
      const data = await readJson(res);
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
      const data = await readJson(res);
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
      const data = await readJson(res);
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
      const data = await readJson(res);
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
            aria-current={isActive ? "step" : undefined}
            onClick={() => openStep(key)}
            className={cn(
              // Flat: the border colour and the active pill's solid left rule make the open step
              // findable in one glance across a strip of ten look-alikes, without a shadow or glow.
              "flex items-center gap-1.5 border px-2.5 py-1.5 text-xs transition-colors",
              isActive
                ? "border-orange-500 border-l-[3px] bg-orange-50 text-slate-900"
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
              {isConfirmed ? <Check aria-hidden className="size-2.5" /> : index + 1}
            </span>
            <span className={cn("whitespace-nowrap", isActive && "font-semibold")}>{definition.title}</span>
            {/* The tick is a picture; a screen reader hears the word. */}
            {isConfirmed ? <span className="sr-only">, confirmed</span> : null}
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
        aria-current={nonEmployeesOpen === part ? "step" : undefined}
        onClick={() => openNonEmployees(part)}
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

  /**
   * The one line that says what to do next. Ten look-alike pills per part give no starting point;
   * HR had to work out from the ticks which step was left and which button came after.
   */
  const nextPart1 = PART1_STEP_KEYS.find((key) => !confirmedSet.has(key)) ?? null;
  const nextPart2 = PART2_STEP_KEYS.find((key) => !confirmedSet.has(key)) ?? null;
  const guide: { text: string; step: StepKey | null } | null = !run
    ? null
    : run.phase === "part1"
      ? nextPart1
        ? {
            text: `${part1Confirmed} of ${PART1_STEP_KEYS.length} Part 1 steps confirmed. Next: ${stepDefinition(nextPart1).title}.`,
            step: nextPart1,
          }
        : { text: "Every Part 1 step is confirmed. Confirm Part 1 to freeze the first instalment; finance is told it is ready.", step: null }
      : run.phase === "part2"
        ? nextPart2
          ? {
              text: `${part2Confirmed} of ${PART2_STEP_KEYS.length} Part 2 steps confirmed. Next: ${stepDefinition(nextPart2).title}.`,
              step: nextPart2,
            }
          : { text: "Every Part 2 step is confirmed. Confirm Part 2 to lock the full sheet; finance is told it is ready.", step: null }
        : run.phase === "ready"
          ? {
              text: isPublisher
                ? "Part 2 is confirmed and the sheet is locked. What is left is to publish this month to payslips."
                : "Part 2 is confirmed and the sheet is locked. Only a System Admin can publish it to payslips.",
              step: null,
            }
          : run.phase === "published"
            ? { text: `${MONTHS[run.month - 1]} ${run.year} is published to payslips. This month is finished.`, step: null }
            : { text: "This run was cancelled. Start a new run to work on this month again.", step: null };

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
        <SelectField label="Month" value={month} onChange={(value) => choosePeriod(value, year)}>
          {MONTHS.map((label, index) => (
            <option key={label} value={index + 1}>{label}</option>
          ))}
        </SelectField>
        <SelectField label="Year" value={year} onChange={(value) => choosePeriod(month, value)}>
          {yearOptions.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </SelectField>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void loadRun(month, year)}
          className="h-10 border-slate-300 font-bold text-slate-700 hover:bg-slate-100"
        >
          Reload
        </Button>
        {/* Start is offered only where it can do something: a month with no run, or one whose run was
            cancelled. On a published month the server always refuses it (a second run would shadow
            the paid one), so the button used to lead straight to an error. */}
        {(!run && loadState === "loaded") || run?.phase === "cancelled" ? (
          <Button
            disabled={busy}
            onClick={() => void onStartClick()}
            className="h-10 border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
          >
            {run?.phase === "cancelled" ? `Start a new ${periodLabel} run` : `Start the ${periodLabel} run`}
          </Button>
        ) : run ? (
          <Badge variant={run.phase === "published" || run.phase === "ready" ? "success" : "neutral"}>{phaseLabel}</Badge>
        ) : null}
      </div>

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}
      {pendingNav ? (
        <div role="alertdialog" aria-labelledby="payroll-pending-nav" className="border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div id="payroll-pending-nav" className="font-black">{pendingNav.message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-amber-400 bg-white text-amber-900 hover:bg-amber-100"
              onClick={() => setPendingNav(null)}
            >
              Stay and save first
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-amber-900 hover:bg-amber-100"
              onClick={() => {
                const nav = pendingNav;
                setPendingNav(null);
                // The step's own unmount reports it clean; nothing here pretends the edits were saved.
                nav.go();
              }}
            >
              Leave without saving
            </Button>
          </div>
        </div>
      ) : null}
      {run && unreadChecks.length > 0 ? (
        <AdminCallout tone="warning">
          <div className="min-w-0 flex-1">
            <div className="font-black">
              {unreadChecks.length === 1 ? "One safety check could not be read" : `${unreadChecks.length} safety checks could not be read`}
            </div>
            <p className="mt-1 text-xs">
              Not checked is not the same as clear: {unreadChecks.map((key) => RUN_CHECK_LABELS[key]).join("; ")}.
              Check again before confirming a part.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadRun(month, year)}
              className="mt-2 text-xs font-semibold underline underline-offset-2 disabled:opacity-50"
            >
              Check again
            </button>
          </div>
        </AdminCallout>
      ) : null}
      {pendingAction ? (
        <div id="payroll-pending-action" tabIndex={-1} role="alertdialog" aria-labelledby="payroll-pending-title" className="outline-none border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div id="payroll-pending-title" className="font-black">{pendingAction.title}</div>
          <p className="mt-1 break-words">{pendingAction.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
              disabled={busy}
              onClick={() => {
                const action = pendingAction;
                setPendingAction(null);
                if (action.overridable) void postReopen(action);
                else void post(action.url, action.ok);
              }}
            >
              {pendingAction.label}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {downloadOverride ? (
        <div id="payroll-download-override" tabIndex={-1} role="alertdialog" aria-labelledby="payroll-download-override-title" className="outline-none border border-red-300 border-l-4 border-l-red-600 bg-red-50 px-4 py-3 text-sm text-red-950">
          <div id="payroll-download-override-title" className="font-black">Finance already has this run&apos;s bank files</div>
          <p className="mt-1 break-words">{downloadOverride.message}</p>
          <FormField
            className="mt-3"
            label="Why reopen anyway"
            required
            htmlFor="payroll-download-override-reason"
            hint={`At least ${OVERRIDE_MIN_REASON} characters. Kept on the run's record with your name.`}
          >
            <Input
              id="payroll-download-override-reason"
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder="e.g. the bank rejected the file and finance will send a new one"
            />
          </FormField>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              className="border border-red-700 bg-red-700 text-white hover:bg-red-800"
              disabled={busy || overrideReason.trim().length < OVERRIDE_MIN_REASON}
              onClick={() => void postReopen(downloadOverride, { reason: overrideReason.trim() })}
            >
              {downloadOverride.label} anyway
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDownloadOverride(null);
                setOverrideReason("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

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
              <div className="font-black">{dataQualityHeadline}</div>
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
                        {row.fullName}, {columnLabel(row.stepKey, row.field)} — this run charges {money(row.charged)} and
                        the Deductions module has no approved line behind any of it,{" "}
                        {describeChargeSource(row.chargeSource, cairoTimeLabel)}
                      </>
                    ) : (
                      <>
                        {row.fullName}, {columnLabel(row.stepKey, row.field)} — confirmed at {money(row.proposedAtConfirm)}, the module now
                        says {money(row.proposedNow)}
                        {row.overridden
                          ? `; this run charges ${money(row.charged)}, ${describeChargeSource(row.chargeSource, cairoTimeLabel)}`
                          : `; this run still charges ${money(row.charged)}`}
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
                  {collision.fullName} on {formatPayrollDay(collision.date)} — claimed by {collision.categories.join(" + ")}
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
        <div className={cn(adminPanelClassName, "flex flex-col items-center gap-3 p-8 text-center text-sm text-slate-500")}>
          {loadState === "loading" ? (
            <span>Loading {periodLabel}…</span>
          ) : loadState === "failed" ? (
            <>
              <span className="font-semibold text-slate-700">{periodLabel} could not be loaded.</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadRun(month, year)}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <span className="font-semibold text-slate-700">No payroll run for {periodLabel} yet.</span>
              <span>Start it with the button above. The system then recommends every figure, step by step.</span>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {guide ? (
            <div className="flex flex-col gap-2 border border-slate-200 border-l-4 border-l-orange-500 bg-white px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <span className="mr-2 text-[11px] font-black uppercase tracking-wide text-orange-600">Next step</span>
                <span className="text-slate-800">{guide.text}</span>
              </div>
              {guide.step && guide.step !== activeStep ? (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => openStep(guide.step as StepKey)}>
                  Open {stepDefinition(guide.step).title}
                </Button>
              ) : null}
            </div>
          ) : null}
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
                          onClick={() =>
                            setPendingAction({
                              title: "Unconfirm Part 1?",
                              body: "This clears every employee's frozen First Part so it can be recomputed from current data. If finance has already paid the Part 1 bank files, the recomputed figures will no longer match what was paid.",
                              label: "Unconfirm Part 1",
                              url: `/api/automated-payroll/runs/${run.id}/part1/unconfirm`,
                              ok: "Part 1 unconfirmed. First Part values cleared for recompute.",
                              overridable: true,
                            })
                          }
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
                          onClick={() =>
                            setPendingAction({
                              title: "Reopen Part 2?",
                              body: "Every step is locked while Part 2 is confirmed, because finance may already have executed this month's bank files. Reopening is the only way to change a figure, and it undoes this run's carry-forward entries until you confirm again.",
                              label: "Reopen Part 2",
                              url: `/api/automated-payroll/runs/${run.id}/part2/unconfirm`,
                              ok: "Part 2 reopened. Steps are editable again; confirm Part 2 to re-lock the sheet.",
                              overridable: true,
                            })
                          }
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
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadRecon()}>Check the totals</Button>
              {run.phase === "ready" && isPublisher ? (
                <Button
                  size="sm"
                  className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                  disabled={busy}
                  onClick={() =>
                    setPendingAction({
                      title: "Publish this month to payslips?",
                      body: "Every paid employee gets this month's payslip and is told it is ready, the held people are recorded as owed, and the month becomes final. It cannot be unpublished from this screen.",
                      label: "Publish to payslips",
                      url: `/api/automated-payroll/runs/${run.id}/publish`,
                      ok: "Published to payslips.",
                    })
                  }
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
              <Stat label="First instalment" value={money(recon.totalFirstPart)} />
              <Stat label="Second instalment" value={money(recon.totalSecondPart)} />
              <Stat label="Month salary" value={money(recon.totalMonthSalary)} />
              <Stat label="New hires" value={String(recon.joiners)} />
              <Stat label="Resignations" value={String(recon.leavers)} />
              <Stat
                label="Instalments add up"
                value={recon.splitMismatches.length === 0 ? "Yes" : `${people(recon.splitMismatches.length)} do not`}
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
                onDirtyChange={setActiveStepDirty}
              />
            ) : activeStep ? (
              <div className="flex flex-col gap-4">
                {activeStep === "p1_held_release" || activeStep === "p2_held_release" ? (
                  <HeldEnteredPanel
                    key={`${run.id}-held-entered-${heldEnteredVersion}`}
                    runId={run.id}
                    locked={stepLocked(activeStep)}
                    stepDirty={activeStepDirty}
                    onChanged={() => setHeldEnteredVersion((version) => version + 1)}
                  />
                ) : null}
                {activeStep === "p2_expenses" ? (
                  <LateExpensesPanel
                    key={`${run.id}-late-expenses-${heldEnteredVersion}`}
                    month={run.month}
                    year={run.year}
                    stepDirty={activeStepDirty}
                    onChanged={() => setHeldEnteredVersion((version) => version + 1)}
                  />
                ) : null}
                <RecommendationStep
                  key={`${run.id}-${activeStep}-${heldEnteredVersion}`}
                  runId={run.id}
                  stepKey={activeStep}
                  confirmed={confirmedSet.has(activeStep)}
                  locked={stepLocked(activeStep)}
                  onConfirmed={() => void onStepConfirmed(activeStep)}
                  onDirtyChange={setActiveStepDirty}
                  onHeldEntered={() => setHeldEnteredVersion((version) => version + 1)}
                />
              </div>
            ) : (
              <div className="p-6 text-center text-sm text-slate-500">Select a step above to begin.</div>
            )}
          </div>

          <DownloadHistoryPanel key={run.id} runId={run.id} />
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
