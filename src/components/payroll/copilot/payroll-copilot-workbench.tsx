"use client";

import { phxButtonApproveDenseClassName } from "@/components/ui/form-tokens";
import { Fragment, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Pause,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";

import { PremiumHero } from "@/components/ui/premium-hero";
import { formatWorkingDays } from "@/lib/payroll/salary-sheet-fields";

type IconType = typeof Users;

import { ExpensesTab } from "./tabs/expenses-tab";
import { HolidayBridgingTab } from "./tabs/holiday-bridging-tab";
import { UnpaidVacationTab } from "./tabs/unpaid-vacation-tab";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * KPI-card accent recipe: gradient bg, glow, icon badge, hover lift.
 *
 * This named admin-command-center.tsx until that file was retired on 2026-08-30 with the generic
 * /admin page, leaving the comment pointing at nothing. hr/hr-command-center.tsx is the live sibling
 * carrying the same recipe — match it there, not here, if the look is ever changed.
 */
const ACCENT_STYLES = {
  blue: {
    bar: "from-sky-500 via-sky-400 to-sky-300",
    glow: "bg-sky-400/25",
    icon: "bg-gradient-to-br from-sky-100 to-sky-50 text-sky-700 ring-sky-200/70",
    from: "from-white to-slate-50/60",
    border: "border-slate-200",
    text: "text-sky-700",
  },
  emerald: {
    bar: "from-emerald-500 via-emerald-400 to-emerald-300",
    glow: "bg-emerald-400/25",
    icon: "bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-700 ring-emerald-200/70",
    from: "from-emerald-50 to-white",
    border: "border-emerald-200",
    text: "text-emerald-700",
  },
  amber: {
    bar: "from-amber-500 via-amber-400 to-amber-300",
    glow: "bg-amber-400/25",
    icon: "bg-gradient-to-br from-amber-100 to-amber-50 text-amber-700 ring-amber-200/70",
    from: "from-amber-50 to-white",
    border: "border-amber-200",
    text: "text-amber-700",
  },
  rose: {
    bar: "from-rose-500 via-rose-400 to-rose-300",
    glow: "bg-rose-400/25",
    icon: "bg-gradient-to-br from-rose-100 to-rose-50 text-rose-700 ring-rose-200/70",
    from: "from-rose-50 to-white",
    border: "border-rose-200",
    text: "text-rose-700",
  },
} as const;

/** Dark section header with the orange gradient accent bar — same recipe every premium admin page uses. */
function SectionHeaderBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
      <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
      {children}
    </div>
  );
}

export type Flag = {
  employeeHrId: string;
  rule: string;
  severity: "block" | "warn";
  question: string;
};

export type EmployeeStatus = "green" | "answered" | "question" | "hold";

export type RecommendationConfidence = "high" | "review" | "needs_input";

/** The Copilot's one-click recommendation for a flagged row (mirrors recommend.ts).
 * `action` is the full ProposedAction the server proposed — posted back verbatim
 * to /actions when the CEO accepts, so every field (workedDays, reason, …) survives. */
export type Recommendation = {
  action: ({ kind: string; hrId: string } & Record<string, unknown>) | null;
  actionLabel: string;
  why: string;
  confidence: RecommendationConfidence;
};

/** One row of the canonical payroll sheet — same column shape as SalaryReportTable (src/components/payroll/dashboard/), plus Copilot-only status/flags. */
export type EmployeeRow = {
  hrId: string;
  fullName: string;
  hireDate: string | null;
  /** Calendar days in the period — the proration denominator. */
  calendarDays: number;
  /** Days on payroll. Explains a row whose full salary exceeds its Month Salary. */
  workingDays: number;
  line: string;
  area: string;
  jobTitle: string;
  baseSalary: number;
  expenses: number;
  incentive: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  otherAdditions: number;
  totalAdditions: number;
  crm: number;
  fingerPrint: number;
  unpaidVacations: number;
  medicalInsurance: number;
  loans: number;
  otherDeductions: number;
  totalDeductions: number;
  netSalary: number;
  firstPart: number;
  secondPart: number;
  monthSalary: number;
  paymentGroup: string;
  status: EmployeeStatus;
  flags: Flag[];
  recommendation: Recommendation | null;
};

type RecurringApplied = { hrId: string; kind: string; amount: number; note: string | null };

type OtherTabBlocking = { label: string; count: number };

type Draft = {
  period: { month: number; year: number };
  employeeCount: number;
  greenCount: number;
  flaggedOpenCount: number;
  openBlockCount: number;
  canMaterialize: boolean;
  otherTabsBlocking: OtherTabBlocking[];
  recurringApplied: RecurringApplied[];
  employees: EmployeeRow[];
};

type Run = {
  id: string;
  month: number;
  year: number;
  status: string;
  salaryBatchId: string | null;
  periodLabel: string | null;
};

type RunView = { run: Run; draft: Draft; resumed?: boolean };

type ProposedAction = {
  kind: string;
  hrId: string;
  amount?: number;
  monthlyAmount?: number;
  installments?: number;
  workedDays?: number;
  field?: string;
  value?: number;
  reason?: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

async function postJson(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

function describeAction(action: ProposedAction): string {
  switch (action.kind) {
    case "bonus":
      return `Bonus ${egp(action.amount ?? 0)} to ${action.hrId}`;
    case "penalty":
      return `Deduct ${egp(action.amount ?? 0)} from ${action.hrId}`;
    case "advance":
      return `Advance ${egp(action.amount ?? 0)} to ${action.hrId} (recovered as a deduction)`;
    case "loan":
      return `Loan for ${action.hrId}: ${egp(action.monthlyAmount ?? 0)}/month × ${action.installments ?? 0}`;
    case "prorate":
      return `Prorate ${action.hrId} to ${action.workedDays ?? 0} worked day(s)`;
    case "override":
      return `Set ${action.field} = ${egp(action.value ?? 0)} for ${action.hrId}`;
    case "include":
      return `Include ${action.hrId} as-is`;
    case "defer":
      return `Defer ${action.hrId} to next month`;
    case "confirm":
      return `Confirm ${action.hrId} as correct`;
    case "hold":
      return `Hold ${action.hrId}'s pay this run — "${action.reason ?? ""}"`;
    default:
      return `${action.kind} ${action.hrId}`;
  }
}

export const SEVERITY_STYLES: Record<Flag["severity"], string> = {
  block: "border-l-rose-500",
  warn: "border-l-amber-500",
};

type QuestionGroup = {
  key: string;
  rule: string;
  question: string;
  severity: Flag["severity"];
  hrIds: string[];
  names: string[];
};

/** Employees sharing the EXACT same (rule, question) — offered a single bulk-resolve action instead of N separate ones. */
function groupDuplicateQuestions(employees: EmployeeRow[]): QuestionGroup[] {
  const map = new Map<string, QuestionGroup>();
  for (const employee of employees) {
    if (employee.status !== "question") continue;
    for (const flag of employee.flags) {
      const key = `${flag.rule}::${flag.question}`;
      const existing = map.get(key);
      if (existing) {
        existing.hrIds.push(employee.hrId);
        existing.names.push(employee.fullName);
      } else {
        map.set(key, {
          key,
          rule: flag.rule,
          question: flag.question,
          severity: flag.severity,
          hrIds: [employee.hrId],
          names: [employee.fullName],
        });
      }
    }
  }
  return Array.from(map.values()).filter((group) => group.hrIds.length >= 2);
}

export function PayrollCopilotWorkbench() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [view, setView] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState("");
  const [proposals, setProposals] = useState<ProposedAction[] | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [materialized, setMaterialized] = useState<{ batchHref: string; importedRecords: number } | null>(null);

  const draft = view?.draft ?? null;

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    await run(async () => {
      const data = (await postJson("/api/payroll/copilot/start", { month, year })) as unknown as RunView;
      setView(data);
      setProposals(null);
      setAnswer(null);
      setMaterialized(null);
    });
  }

  async function sendMessage() {
    if (!view || !chat.trim()) return;
    await run(async () => {
      const data = await postJson(`/api/payroll/copilot/${view.run.id}/message`, { text: chat });
      setProposals((data.proposedActions as ProposedAction[]) ?? []);
      setAnswer(typeof data.answer === "string" ? data.answer : null);
    });
  }

  /** Row toggle — green side: confirm this employee as correct, no chat round-trip needed. */
  async function confirmEmployee(hrId: string) {
    await run(async () => {
      if (!view) return;
      const data = (await postJson(`/api/payroll/copilot/${view.run.id}/actions`, {
        actions: [{ kind: "confirm", hrId }],
      })) as unknown as RunView;
      setView(data);
    });
  }

  /** Row toggle — red side: describe what's wrong, routed through the same chat parser scoped to this employee. */
  async function reportIssue(hrId: string, text: string) {
    if (!text.trim()) return;
    await run(async () => {
      if (!view) return;
      const scoped = `${hrId}: ${text}`;
      const data = await postJson(`/api/payroll/copilot/${view.run.id}/message`, { text: scoped });
      setChat(scoped);
      setProposals((data.proposedActions as ProposedAction[]) ?? []);
      setAnswer(typeof data.answer === "string" ? data.answer : null);
    });
  }

  /** Accept the Copilot's recommendation for one employee — applies its proposed action verbatim. */
  async function acceptRecommendation(action: Record<string, unknown>) {
    await run(async () => {
      if (!view) return;
      const data = (await postJson(`/api/payroll/copilot/${view.run.id}/actions`, {
        actions: [action],
      })) as unknown as RunView;
      setView(data);
    });
  }

  /** Accept EVERY high-confidence recommendation in one call — the headline "one click" for a clean run. */
  async function acceptAllRecommendations() {
    if (!view || !draft) return;
    const actions = draft.employees
      .filter((e) => e.recommendation?.confidence === "high" && e.recommendation.action)
      .map((e) => e.recommendation!.action as Record<string, unknown>);
    if (actions.length === 0) return;
    await run(async () => {
      const data = (await postJson(`/api/payroll/copilot/${view.run.id}/actions`, {
        actions,
      })) as unknown as RunView;
      setView(data);
    });
  }

  /** Bulk-confirm — every employee sharing an identical open question, confirmed as correct in one call. */
  async function confirmGroup(hrIds: string[]) {
    await run(async () => {
      if (!view) return;
      const data = (await postJson(`/api/payroll/copilot/${view.run.id}/actions`, {
        actions: hrIds.map((hrId) => ({ kind: "confirm", hrId })),
      })) as unknown as RunView;
      setView(data);
    });
  }

  /** Bulk report-issue — one answer applied to every employee sharing an identical open question, via the same chat parser. */
  async function reportIssueGroup(hrIds: string[], text: string) {
    if (!text.trim()) return;
    await run(async () => {
      if (!view) return;
      const scoped = `${hrIds.join(", ")}: ${text}`;
      const data = await postJson(`/api/payroll/copilot/${view.run.id}/message`, { text: scoped });
      setChat(scoped);
      setProposals((data.proposedActions as ProposedAction[]) ?? []);
      setAnswer(typeof data.answer === "string" ? data.answer : null);
    });
  }

  /** Separate Hold action — zeroes this employee's pay this run; the comment is required and shown on their payslip. */
  async function holdEmployee(hrId: string, reason: string) {
    if (!reason.trim()) return;
    await run(async () => {
      if (!view) return;
      const data = (await postJson(`/api/payroll/copilot/${view.run.id}/actions`, {
        actions: [{ kind: "hold", hrId, reason }],
      })) as unknown as RunView;
      setView(data);
    });
  }

  async function confirmProposals() {
    if (!view || !proposals) return;
    await run(async () => {
      const data = (await postJson(`/api/payroll/copilot/${view.run.id}/actions`, {
        actions: proposals,
      })) as unknown as RunView;
      setView(data);
      setProposals(null);
      setAnswer(null);
      setChat("");
    });
  }

  async function materialize() {
    if (!view) return;
    await run(async () => {
      const data = await postJson(`/api/payroll/copilot/${view.run.id}/materialize`);
      setMaterialized({
        batchHref: String(data.batchHref ?? ""),
        importedRecords: Number(data.importedRecords ?? 0),
      });
      const refreshed = await fetch(`/api/payroll/copilot/${view.run.id}`, { credentials: "same-origin" });
      if (refreshed.ok) setView((await refreshed.json()) as RunView);
    });
  }

  async function cancelRun() {
    if (!view) return;
    await run(async () => {
      await postJson(`/api/payroll/copilot/${view.run.id}/cancel`);
      setView(null);
      setProposals(null);
      setMaterialized(null);
    });
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="w-full space-y-6">
        <PremiumHero
          kicker="AI-Assisted Payroll"
          title="Payroll Copilot"
          subtitle="Assembles the monthly payroll from your modules, asks about anyone who isn't clean, and builds an editable draft you can lock. Restricted to CEO & Super Admin."
        />

        {error ? (
          <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
        ) : null}

        {view?.resumed ? (
          <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Resumed your in-progress run for this month — nothing was lost.
          </div>
        ) : null}

        {!view ? (
          <section className="border border-slate-200 bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Start a payroll run</h2>
            <div className="mt-4 flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600">Month</span>
                <select
                  className={phxSelectClassName}
                  value={month}
                  onChange={(event) => setMonth(Number(event.target.value))}
                >
                  {MONTHS.map((name, index) => (
                    <option key={name} value={index + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600">Year</span>
                <input
                  className={cn(phxFieldClassName, "w-28")}
                  type="number"
                  value={year}
                  onChange={(event) => setYear(Number(event.target.value))}
                />
              </label>
              <button
                type="button"
                onClick={startRun}
                disabled={busy}
                className="bg-gradient-to-r from-orange-600 to-orange-500 px-5 py-2 text-sm font-semibold text-white hover:from-orange-700 hover:to-orange-600 disabled:opacity-50"
              >
                {busy ? "Assembling…" : `Start ${MONTHS[month - 1]} payroll`}
              </button>
            </div>
          </section>
        ) : (
          <RunWorkspace
            view={view}
            draft={draft}
            busy={busy}
            chat={chat}
            proposals={proposals}
            answer={answer}
            materialized={materialized}
            onChat={setChat}
            onSend={sendMessage}
            onConfirm={confirmProposals}
            onDiscard={() => {
              setProposals(null);
              setAnswer(null);
            }}
            onMaterialize={materialize}
            onCancel={cancelRun}
            onConfirmEmployee={confirmEmployee}
            onReportIssue={reportIssue}
            onHoldEmployee={holdEmployee}
            onConfirmGroup={confirmGroup}
            onReportIssueGroup={reportIssueGroup}
            onAcceptRecommendation={acceptRecommendation}
            onAcceptAllRecommendations={acceptAllRecommendations}
          />
        )}
      </div>
    </div>
  );
}

function RunWorkspace(props: {
  view: RunView;
  draft: Draft | null;
  busy: boolean;
  chat: string;
  proposals: ProposedAction[] | null;
  answer: string | null;
  materialized: { batchHref: string; importedRecords: number } | null;
  onChat: (value: string) => void;
  onSend: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
  onMaterialize: () => void;
  onCancel: () => void;
  onConfirmEmployee: (hrId: string) => void;
  onReportIssue: (hrId: string, text: string) => void;
  onHoldEmployee: (hrId: string, reason: string) => void;
  onConfirmGroup: (hrIds: string[]) => void;
  onReportIssueGroup: (hrIds: string[], text: string) => void;
  onAcceptRecommendation: (action: Record<string, unknown>) => void;
  onAcceptAllRecommendations: () => void;
}) {
  const { view, draft, busy, chat, proposals, answer, materialized } = props;
  const [activeTab, setActiveTab] = useState<
    "sheet" | "vacation" | "expenses" | "holiday-bridging"
  >("sheet");
  if (!draft) return null;

  const questionGroups = groupDuplicateQuestions(draft.employees);
  const groupedHrIds = new Set(questionGroups.flatMap((group) => group.hrIds));
  const highRecommendationCount = draft.employees.filter(
    (e) => e.recommendation?.confidence === "high" && e.recommendation.action,
  ).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat accent="blue" icon={Users} label="Employees" value={draft.employeeCount} />
        <Stat accent="emerald" icon={CheckCircle2} label="Green (auto)" value={draft.greenCount} />
        <Stat accent="amber" icon={AlertTriangle} label="Need answers" value={draft.flaggedOpenCount} />
        <Stat accent="rose" icon={ShieldAlert} label="Blocking" value={draft.openBlockCount} />
      </div>

      {materialized ? (
        <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Draft created with {materialized.importedRecords} records.{" "}
          <a className="font-semibold underline" href={materialized.batchHref}>
            Open the payroll batch
          </a>{" "}
          to review, edit, and lock.
        </div>
      ) : null}

      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            { key: "sheet", label: "Payroll Sheet", count: draft.flaggedOpenCount },
            {
              key: "vacation",
              label: "Unpaid Vacation",
              count: draft.otherTabsBlocking.find((tab) => tab.label === "Unpaid Vacation")?.count ?? 0,
            },
            {
              key: "expenses",
              label: "Expenses",
              count: draft.otherTabsBlocking.find((tab) => tab.label === "Expenses")?.count ?? 0,
            },
            { key: "holiday-bridging", label: "Holiday Bridging", count: 0 },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-semibold ${
              activeTab === tab.key
                ? "border-b-2 border-orange-500 text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
            {tab.count > 0 ? (
              <span className="bg-gradient-to-r from-orange-600 to-orange-500 px-1.5 py-0.5 text-phx-2xs font-bold text-white">
                {tab.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === "vacation" ? (
        <UnpaidVacationTab runId={view.run.id} />
      ) : activeTab === "expenses" ? (
        <ExpensesTab runId={view.run.id} />
      ) : activeTab === "holiday-bridging" ? (
        <HolidayBridgingTab runId={view.run.id} />
      ) : (
      <div className="space-y-6">
        {highRecommendationCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border border-emerald-300 bg-emerald-50 px-4 py-3">
            <p className="text-sm text-emerald-900">
              <span className="font-semibold">{highRecommendationCount}</span> flagged employee(s) have a
              safe, ready-to-apply recommendation (partial-month settlements, org-only changes, pending-governance
              items). Review below, or accept them all at once.
            </p>
            <button
              type="button"
              onClick={props.onAcceptAllRecommendations}
              disabled={busy || view.run.status === "drafted"}
              className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:from-emerald-700 hover:to-emerald-600 disabled:opacity-50"
            >
              <CheckCircle2 aria-hidden className="h-4 w-4" />
              Accept all {highRecommendationCount} recommendations
            </button>
          </div>
        ) : null}

        {questionGroups.length > 0 ? (
          <div className="border border-slate-200 bg-white">
            <SectionHeaderBar>Same question, {questionGroups.length} group(s) — bulk resolve</SectionHeaderBar>
            <div className="divide-y divide-slate-100">
              {questionGroups.map((group) => (
                <GroupedQuestionRow
                  key={group.key}
                  group={group}
                  busy={props.busy}
                  onConfirmAll={() => props.onConfirmGroup(group.hrIds)}
                  onReportIssueAll={(text) => props.onReportIssueGroup(group.hrIds, text)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <PayrollSheetTable
          employees={draft.employees}
          groupedHrIds={groupedHrIds}
          busy={busy}
          onConfirmEmployee={props.onConfirmEmployee}
          onReportIssue={props.onReportIssue}
          onHoldEmployee={props.onHoldEmployee}
          onAcceptRecommendation={props.onAcceptRecommendation}
        />

        <div className="border border-slate-200 bg-white p-4">
          <label className="text-sm font-semibold text-slate-700" htmlFor="copilot-chat">
            Ask or instruct the Copilot
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Ask a question — &quot;why is B-100 flagged?&quot;, &quot;who dropped in pay?&quot; — or give an
            instruction — &quot;give B-100 a 2000 bonus, deduct 500 from B-142, loan B-155 1000 for 6 months&quot;.
          </p>
          <textarea
            id="copilot-chat"
            className={cn(phxTextareaClassName, "mt-2 min-h-24")}
            value={chat}
            onChange={(event) => props.onChat(event.target.value)}
            disabled={view.run.status === "drafted"}
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={props.onSend}
              disabled={busy || !chat.trim() || view.run.status === "drafted"}
              className="bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "Thinking…" : "Send"}
            </button>
          </div>

          {/* A prose answer to a question (shown when the message wasn't a command). */}
          {answer && (!proposals || proposals.length === 0) ? (
            <div className="mt-4 border border-sky-200 bg-sky-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">Copilot</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{answer}</p>
            </div>
          ) : proposals && proposals.length === 0 && !answer ? (
            <div className="mt-4 border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
              I couldn&apos;t read that as an instruction. Try naming the employee and amount explicitly, or ask a
              question about the run.
            </div>
          ) : null}

          {proposals && proposals.length > 0 ? (
            <div className="mt-4 border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Proposed changes ({proposals.length}) — confirm to apply
              </p>
              {proposals.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">
                  I couldn&apos;t turn that into a change. Try naming the employee and amount explicitly.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm text-slate-700">
                  {proposals.map((action, index) => (
                    <li key={index} className="border-l-2 border-l-orange-400 pl-2">
                      {describeAction(action)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={props.onConfirm}
                  disabled={busy || proposals.length === 0}
                  className="bg-gradient-to-r from-orange-600 to-orange-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-700 hover:to-orange-600 disabled:opacity-50"
                >
                  Confirm &amp; apply
                </button>
                <button
                  type="button"
                  onClick={props.onDiscard}
                  disabled={busy}
                  className="border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Discard
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {draft.recurringApplied.length > 0 ? (
          <div className="border border-slate-200 bg-white">
            <SectionHeaderBar>Recurring auto-applied ({draft.recurringApplied.length})</SectionHeaderBar>
            <ul className="divide-y divide-slate-100 text-sm">
              {draft.recurringApplied.map((item, index) => (
                <li key={`${item.hrId}-${index}`} className="flex justify-between px-4 py-2">
                  <span className="text-slate-700">
                    {item.hrId} · {item.kind}
                  </span>
                  <span className="font-medium text-slate-900">{egp(item.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <p className="text-sm text-slate-500">
          {draft.canMaterialize ? (
            "Ready — no blocking questions remain."
          ) : (
            <>
              {draft.openBlockCount > 0
                ? `${draft.openBlockCount} blocking question(s) must be answered. `
                : null}
              {draft.otherTabsBlocking.length > 0
                ? `Still has open items: ${draft.otherTabsBlocking
                    .map((tab) => `${tab.label} (${tab.count})`)
                    .join(", ")}. `
                : null}
              Resolve these before generating the sheet.
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            disabled={busy}
            className="border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            Cancel run
          </button>
          <button
            type="button"
            onClick={props.onMaterialize}
            disabled={busy || !draft.canMaterialize || view.run.status === "drafted"}
            className="bg-gradient-to-r from-orange-600 to-orange-500 px-5 py-2 text-sm font-semibold text-white hover:from-orange-700 hover:to-orange-600 disabled:opacity-50"
          >
            {view.run.status === "drafted" ? "Sheet generated" : "Generate payroll sheet"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** KPI-card recipe: gradient bg, top accent bar, glow, icon badge, hover lift. Live sibling: hr/hr-command-center.tsx. */
function Stat({
  accent,
  icon: Icon,
  label,
  value,
}: {
  accent: keyof typeof ACCENT_STYLES;
  icon: IconType;
  label: string;
  value: number;
}) {
  const style = ACCENT_STYLES[accent];
  return (
    <div
      className={`group relative overflow-hidden border bg-gradient-to-br px-4 py-4 shadow-[0_6px_20px_rgba(15,23,42,0.08)] transition duration-200 hover:-translate-y-1 hover:shadow-[0_14px_34px_rgba(15,23,42,0.12)] ${style.border} ${style.from}`}
    >
      <div aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${style.bar}`} />
      <div aria-hidden="true" className={`pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl ${style.glow}`} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="overflow-hidden whitespace-nowrap text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <p className={`mt-2 text-2xl font-black tracking-[-0.02em] ${style.text}`}>{value}</p>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center shadow-sm ring-1 ${style.icon}`}>
          <Icon aria-hidden className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

const STATUS_META: Record<EmployeeStatus, { label: string; className: string }> = {
  green: { label: "Green", className: "bg-emerald-100 text-emerald-700" },
  answered: { label: "Answered", className: "bg-sky-100 text-sky-700" },
  question: { label: "Question", className: "bg-amber-100 text-amber-700" },
  hold: { label: "On Hold", className: "bg-rose-100 text-rose-700" },
};

const CONFIDENCE_ACCENT: Record<RecommendationConfidence, string> = {
  high: "border-l-emerald-500",
  review: "border-l-amber-500",
  needs_input: "border-l-rose-500",
};
const CONFIDENCE_LABEL: Record<RecommendationConfidence, string> = {
  high: "Recommended",
  review: "Review",
  needs_input: "Needs your input",
};

const STATUS_FILTERS: Array<{ key: "all" | EmployeeStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "question", label: "Questions" },
  { key: "hold", label: "On Hold" },
  { key: "answered", label: "Answered" },
  { key: "green", label: "Green" },
];

export function formatShortDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatStableEnGb(date, { day: "2-digit", month: "short", year: "numeric" });
}

type SheetColumn = {
  key: string;
  label: string;
  width: number;
  frozen?: boolean;
  numeric?: boolean;
  render: (employee: EmployeeRow) => React.ReactNode;
};

/**
 * The full canonical payroll-sheet column set — every column the owner's
 * real manual sheet has (Base Salary through Payment Group), not a
 * lumped-sum summary. HR ID / Full Name / Hire Date are frozen (sticky-left)
 * so identity stays visible while scrolling through the money columns.
 */
const SHEET_COLUMNS: SheetColumn[] = [
  { key: "hrId", label: "HR ID", width: 100, frozen: true, render: (e) => (
    <span className="font-mono text-xs text-slate-500">{e.hrId}</span>
  ) },
  { key: "fullName", label: "Full Name", width: 300, frozen: true, render: (e) => (
    <span className="font-medium text-slate-900">{e.fullName}</span>
  ) },
  { key: "hireDate", label: "Hire Date", width: 115, frozen: true, render: (e) => formatShortDate(e.hireDate) },
  { key: "jobTitle", label: "Job Title", width: 190, render: (e) => e.jobTitle || "—" },
  { key: "line", label: "Line", width: 110, render: (e) => e.line || "—" },
  { key: "area", label: "Area", width: 160, render: (e) => e.area || "—" },
  // Sits immediately before Base Salary, the same place it holds in
  // payrollSheetHeaders, because it is what explains a full salary on a partial
  // month. Never summed: a company-wide total of day counts means nothing.
  { key: "workingDays", label: "Working Days", width: 110, numeric: true, render: (e) => (
    <span className={e.workingDays > 0 && e.workingDays < e.calendarDays ? "font-semibold text-amber-700" : undefined}>
      {formatWorkingDays(e) || "—"}
    </span>
  ) },
  { key: "baseSalary", label: "Base Salary", width: 120, numeric: true, render: (e) => egp(e.baseSalary) },
  { key: "netSalary", label: "Net Salary", width: 120, numeric: true, render: (e) => egp(e.netSalary) },
  { key: "expenses", label: "Expenses", width: 110, numeric: true, render: (e) => egp(e.expenses) },
  { key: "incentive", label: "Incentive", width: 110, numeric: true, render: (e) => egp(e.incentive) },
  { key: "extraCostOfLiving", label: "Extra COL", width: 110, numeric: true, render: (e) => egp(e.extraCostOfLiving) },
  { key: "fuelAllowance", label: "Fuel Allowance", width: 120, numeric: true, render: (e) => egp(e.fuelAllowance) },
  { key: "otherAdditions", label: "Other Additions", width: 130, numeric: true, render: (e) => egp(e.otherAdditions) },
  { key: "totalAdditions", label: "Total Additions", width: 130, numeric: true, render: (e) => (
    <span className="font-semibold text-emerald-700">{egp(e.totalAdditions)}</span>
  ) },
  { key: "crm", label: "CRM", width: 100, numeric: true, render: (e) => egp(e.crm) },
  { key: "fingerPrint", label: "Finger Print", width: 110, numeric: true, render: (e) => egp(e.fingerPrint) },
  { key: "unpaidVacations", label: "Unpaid Vacations", width: 130, numeric: true, render: (e) => egp(e.unpaidVacations) },
  { key: "medicalInsurance", label: "Medical Insurance", width: 130, numeric: true, render: (e) => egp(e.medicalInsurance) },
  { key: "loans", label: "Loans", width: 100, numeric: true, render: (e) => egp(e.loans) },
  { key: "otherDeductions", label: "Other Deductions", width: 130, numeric: true, render: (e) => egp(e.otherDeductions) },
  { key: "totalDeductions", label: "Total Deductions", width: 130, numeric: true, render: (e) => (
    <span className="font-semibold text-rose-700">{egp(e.totalDeductions)}</span>
  ) },
  { key: "monthSalary", label: "Month Salary", width: 120, numeric: true, render: (e) => egp(e.monthSalary) },
  { key: "firstPart", label: "First Part", width: 110, numeric: true, render: (e) => egp(e.firstPart) },
  { key: "secondPart", label: "Second Part", width: 110, numeric: true, render: (e) => egp(e.secondPart) },
  { key: "paymentGroup", label: "Payment Group", width: 130, render: (e) => e.paymentGroup },
];

/** Left offset (px) for each frozen column, computed from the running width of frozen columns before it. */
function frozenOffset(columnKey: string): number {
  let offset = 0;
  for (const column of SHEET_COLUMNS) {
    if (!column.frozen) break;
    if (column.key === columnKey) return offset;
    offset += column.width;
  }
  return offset;
}

const SHEET_TABLE_WIDTH =
  SHEET_COLUMNS.reduce((sum, column) => sum + column.width, 0) + 280 /* Status */ + 240; /* Actions */

/**
 * One page-wide table showing the FULL canonical payroll-sheet columns (same
 * set the owner's real manual sheet has) — not a lumped Additions/Deductions
 * summary. HR ID/Full Name/Hire Date are frozen so identity stays visible
 * while scrolling through the money columns. A flagged employee renders as
 * TWO rows: identity + all columns + actions, then a second row spanning the
 * full width with their open question(s). Clean employees render as a single row.
 */
function PayrollSheetTable({
  employees,
  groupedHrIds,
  busy,
  onConfirmEmployee,
  onReportIssue,
  onHoldEmployee,
  onAcceptRecommendation,
}: {
  employees: EmployeeRow[];
  groupedHrIds: Set<string>;
  busy: boolean;
  onConfirmEmployee: (hrId: string) => void;
  onReportIssue: (hrId: string, text: string) => void;
  onHoldEmployee: (hrId: string, reason: string) => void;
  onAcceptRecommendation: (action: Record<string, unknown>) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | EmployeeStatus>("all");

  // A second, thin horizontal scrollbar just under the header bar — the table
  // can run 100+ rows deep, so the browser's native scrollbar (at the very
  // bottom of the table) is unreachable without scrolling all the way down
  // first. The two scroll positions are kept in sync in both directions; the
  // syncing ref guards against the two onScroll handlers re-triggering each other.
  const topScrollRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef<"top" | "body" | null>(null);

  function syncFromTop() {
    if (syncingRef.current === "body") return;
    syncingRef.current = "top";
    if (bodyScrollRef.current && topScrollRef.current) {
      bodyScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
    syncingRef.current = null;
  }

  function syncFromBody() {
    if (syncingRef.current === "top") return;
    syncingRef.current = "body";
    if (bodyScrollRef.current && topScrollRef.current) {
      topScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
    }
    syncingRef.current = null;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const rows = employees.filter((employee) => {
    if (statusFilter !== "all" && employee.status !== statusFilter) return false;
    if (!normalizedQuery) return true;
    return (
      employee.fullName.toLowerCase().includes(normalizedQuery) ||
      employee.hrId.toLowerCase().includes(normalizedQuery)
    );
  });


  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-900 px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-white">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          Payroll sheet ({employees.length})
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name or HR ID…"
            className={cn(phxFieldClassName, "w-48")}
          />
          <div className="flex overflow-hidden border border-slate-600 text-xs font-semibold">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setStatusFilter(filter.key)}
                className={`px-2 py-1 ${
                  statusFilter === filter.key
                    ? "bg-gradient-to-r from-orange-600 to-orange-500 text-white"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          {employees.length === 0 ? "No employees in this draft." : "No employees match this search/filter."}
        </p>
      ) : (
        <>
          <div
            ref={topScrollRef}
            onScroll={syncFromTop}
            className="overflow-x-auto overflow-y-hidden border-b border-slate-200"
            style={{ height: 14 }}
          >
            <div style={{ width: SHEET_TABLE_WIDTH, height: 1 }} />
          </div>
          <div ref={bodyScrollRef} onScroll={syncFromBody} className="overflow-x-auto">
          <table className="table-fixed text-left text-sm" style={{ width: SHEET_TABLE_WIDTH, minWidth: "100%" }}>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                {SHEET_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    className={`px-2 py-2 ${column.frozen ? "sticky z-20 bg-white" : ""} ${column.numeric ? "text-right" : ""}`}
                    style={{ width: column.width, ...(column.frozen ? { left: frozenOffset(column.key) } : {}) }}
                  >
                    {column.label}
                  </th>
                ))}
                <th className="px-2 py-2" style={{ width: 280 }}>Status</th>
                <th className="px-2 py-2" style={{ width: 240 }}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((employee) => {
                const meta = STATUS_META[employee.status];
                const rec = employee.recommendation;
                return (
                  <Fragment key={employee.hrId}>
                    <tr className="group hover:bg-slate-50">
                      {SHEET_COLUMNS.map((column) => (
                        <td
                          key={column.key}
                          className={`overflow-hidden whitespace-nowrap px-2 py-2 text-slate-600 ${
                            column.frozen ? "sticky z-10 bg-white group-hover:bg-slate-50" : ""
                          } ${column.numeric ? "text-right font-mono" : ""}`}
                          style={column.frozen ? { left: frozenOffset(column.key) } : undefined}
                        >
                          {column.render(employee)}
                          {column.key === "fullName" && groupedHrIds.has(employee.hrId) ? (
                            <span className="ml-2 bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-semibold uppercase tracking-wide text-slate-500">
                              Grouped
                            </span>
                          ) : null}
                        </td>
                      ))}
                      <td className="whitespace-normal break-words px-2 py-2 align-top">
                        <span className={`px-1.5 py-0.5 text-xs font-semibold ${meta.className}`}>{meta.label}</span>
                        {employee.status === "question" ? (
                          rec ? (
                            <div className="mt-1.5 space-y-1.5">
                              <p
                                className={`border-l-4 pl-2 text-xs text-slate-700 ${
                                  CONFIDENCE_ACCENT[rec.confidence]
                                }`}
                              >
                                <span className="font-semibold">{CONFIDENCE_LABEL[rec.confidence]}:</span>{" "}
                                {rec.why}
                              </p>
                              {rec.action ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => onAcceptRecommendation(rec.action as Record<string, unknown>)}
                                  className={cn(phxButtonApproveDenseClassName, "flex items-center gap-1 border px-3 py-1.5 text-xs font-semibold disabled:opacity-50")}
                                >
                                  <Check aria-hidden className="h-3.5 w-3.5" />
                                  {rec.actionLabel}
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <div className="mt-1.5 space-y-1">
                              {employee.flags.map((flag) => (
                                <p
                                  key={flag.rule}
                                  className={`border-l-4 pl-2 text-xs text-slate-700 ${SEVERITY_STYLES[flag.severity]}`}
                                >
                                  {flag.question}
                                </p>
                              ))}
                            </div>
                          )
                        ) : null}
                      </td>
                      <td className="px-2 py-2">
                        <EmployeeRowActions
                          busy={busy}
                          onConfirm={() => onConfirmEmployee(employee.hrId)}
                          onReportIssue={(text) => onReportIssue(employee.hrId, text)}
                          onHold={(reason) => onHoldEmployee(employee.hrId, reason)}
                        />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One row per group of employees sharing the exact same open question — lets
 * the CEO resolve all of them in one action instead of repeating the same
 * answer N times. "Confirm all" applies the confirm action to every hrId in
 * one call; "Answer for all" routes one reply through the same chat parser
 * used for a single employee, just addressed to every name in the group.
 * No bulk Hold here — a hold's comment is inherently per-employee (shown on
 * that one person's payslip), so it stays a single-row action only.
 */
function GroupedQuestionRow({
  group,
  busy,
  onConfirmAll,
  onReportIssueAll,
}: {
  group: QuestionGroup;
  busy: boolean;
  onConfirmAll: () => void;
  onReportIssueAll: (text: string) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");

  return (
    <div className="px-4 py-3 text-sm">
      <p className={`border-l-4 pl-2 font-medium text-slate-800 ${SEVERITY_STYLES[group.severity]}`}>
        {group.question}
      </p>
      <p className="mt-1 pl-2 text-xs text-slate-500">
        {group.hrIds.length} people: {group.names.join(", ")}
      </p>
      {answering ? (
        <div className="mt-2 flex flex-col gap-2 border border-slate-300 bg-slate-50 p-2">
          <textarea
            className={cn(phxTextareaClassName, "min-h-16")}
            placeholder="One answer, applied to everyone in this group"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoFocus
          />
          <div className="flex gap-1">
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => {
                onReportIssueAll(text);
                setAnswering(false);
                setText("");
              }}
              className="bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Send to all {group.hrIds.length}
            </button>
            <button
              type="button"
              onClick={() => setAnswering(false)}
              className="border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirmAll}
            className="bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
          >
            Confirm all {group.hrIds.length} as correct
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setAnswering(true)}
            className="border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Answer for all
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Per-employee toggle beside their name: green (right) confirms as-is; red
 * (left) opens an inline box to describe the issue, routed through the same
 * chat parser scoped to this employee. A separate Hold action puts their pay
 * on temporary hold this run with a required comment shown on their payslip.
 */
export function EmployeeRowActions({
  busy,
  onConfirm,
  onReportIssue,
  onHold,
}: {
  busy: boolean;
  onConfirm: () => void;
  onReportIssue: (text: string) => void;
  onHold: (reason: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "issue" | "hold">("idle");
  const [text, setText] = useState("");

  function reset() {
    setMode("idle");
    setText("");
  }

  if (mode === "issue" || mode === "hold") {
    const isHold = mode === "hold";
    return (
      <div
        className={`flex w-56 flex-col gap-2 border p-2 text-xs ${
          isHold ? "border-slate-300 bg-slate-50" : "border-amber-300 bg-amber-50"
        }`}
      >
        <p className="font-semibold text-slate-700">
          {isHold ? "Hold pay — comment shown on payslip" : "What's wrong?"}
        </p>
        <textarea
          className={cn(phxTextareaClassName, "min-h-16")}
          placeholder={isHold ? "Reason for the hold (required)" : "Describe the issue"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          autoFocus
        />
        <div className="flex gap-1">
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => {
              if (isHold) onHold(text);
              else onReportIssue(text);
              reset();
            }}
            className={`px-2 py-1 font-semibold text-white disabled:opacity-50 ${
              isHold ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-900 hover:bg-slate-800"
            }`}
          >
            {isHold ? "Confirm hold" : "Send"}
          </button>
          <button
            type="button"
            onClick={reset}
            className="border border-slate-300 px-2 py-1 font-semibold text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="flex overflow-hidden border border-slate-300 text-xs font-semibold">
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode("issue")}
          title="Report an issue"
          className="flex items-center gap-1 bg-rose-100 px-2 py-1 text-rose-700 hover:bg-rose-200 disabled:opacity-50"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
          Issue
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          title="Confirm as correct"
          className="flex items-center gap-1 bg-emerald-100 px-2 py-1 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
        >
          <Check aria-hidden className="h-3.5 w-3.5" />
          Confirm
        </button>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => setMode("hold")}
        title="Put pay on hold"
        className="flex items-center gap-1 border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
      >
        <Pause aria-hidden className="h-3.5 w-3.5" />
        Hold
      </button>
    </div>
  );
}
