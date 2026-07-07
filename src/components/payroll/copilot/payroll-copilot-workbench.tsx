"use client";

import { Fragment, useState } from "react";
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

type IconType = typeof Users;

import { DeductionReviewTable } from "./tabs/deduction-review-table";
import { ExpensesTab } from "./tabs/expenses-tab";
import { PayrollPreviewTab } from "./tabs/payroll-preview-tab";
import { UnpaidVacationTab } from "./tabs/unpaid-vacation-tab";

/** Same accent recipe as admin-command-center.tsx's KPI cards — gradient bg, glow, icon badge, hover lift. */
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

/** One row of the canonical payroll sheet — same column shape as SalaryReportTable (src/components/payroll/dashboard/), plus Copilot-only status/flags. */
export type EmployeeRow = {
  hrId: string;
  fullName: string;
  hireDate: string | null;
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
      setMaterialized(null);
    });
  }

  async function sendMessage() {
    if (!view || !chat.trim()) return;
    await run(async () => {
      const data = await postJson(`/api/payroll/copilot/${view.run.id}/message`, { text: chat });
      setProposals((data.proposedActions as ProposedAction[]) ?? []);
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
      <div className="mx-auto max-w-6xl space-y-6">
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
                  className="border border-slate-300 bg-white px-3 py-2 text-sm"
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
                  className="w-28 border border-slate-300 bg-white px-3 py-2 text-sm"
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
            materialized={materialized}
            onChat={setChat}
            onSend={sendMessage}
            onConfirm={confirmProposals}
            onDiscard={() => setProposals(null)}
            onMaterialize={materialize}
            onCancel={cancelRun}
            onConfirmEmployee={confirmEmployee}
            onReportIssue={reportIssue}
            onHoldEmployee={holdEmployee}
            onConfirmGroup={confirmGroup}
            onReportIssueGroup={reportIssueGroup}
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
}) {
  const { view, draft, busy, chat, proposals, materialized } = props;
  const [activeTab, setActiveTab] = useState<
    "negotiation" | "fingerprint" | "crm" | "vacation" | "expenses" | "preview"
  >("negotiation");
  if (!draft) return null;

  const questionGroups = groupDuplicateQuestions(draft.employees);
  const groupedHrIds = new Set(questionGroups.flatMap((group) => group.hrIds));

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
            { key: "negotiation", label: "Negotiation", count: draft.flaggedOpenCount },
            {
              key: "fingerprint",
              label: "Fingerprint Deductions",
              count: draft.otherTabsBlocking.find((tab) => tab.label === "Fingerprint Deductions")?.count ?? 0,
            },
            {
              key: "crm",
              label: "CRM Deductions",
              count: draft.otherTabsBlocking.find((tab) => tab.label === "CRM Deductions")?.count ?? 0,
            },
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
            { key: "preview", label: "Payroll Preview", count: 0 },
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
              <span className="bg-gradient-to-r from-orange-600 to-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {tab.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === "fingerprint" ? (
        <DeductionReviewTable
          runId={view.run.id}
          endpoint="fingerprint"
          title="Fingerprint / Attendance Deductions"
          valueLabel="Days/Hours"
        />
      ) : activeTab === "crm" ? (
        <DeductionReviewTable
          runId={view.run.id}
          endpoint="crm"
          title="CRM No-Activity Deductions"
          valueLabel="No-Activity Days"
        />
      ) : activeTab === "vacation" ? (
        <UnpaidVacationTab runId={view.run.id} />
      ) : activeTab === "expenses" ? (
        <ExpensesTab runId={view.run.id} />
      ) : activeTab === "preview" ? (
        <PayrollPreviewTab
          employees={draft.employees}
          groupedHrIds={groupedHrIds}
          busy={busy}
          onConfirmEmployee={props.onConfirmEmployee}
          onReportIssue={props.onReportIssue}
          onHoldEmployee={props.onHoldEmployee}
        />
      ) : (
      <div className="space-y-6">
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
        />

        <div className="border border-slate-200 bg-white p-4">
          <label className="text-sm font-semibold text-slate-700" htmlFor="copilot-chat">
            Answer the Copilot
          </label>
          <p className="mt-1 text-xs text-slate-500">
            e.g. &quot;give B-100 a 2000 bonus, deduct 500 from B-142, loan B-155 1000 for 6 months&quot;
          </p>
          <textarea
            id="copilot-chat"
            className="mt-2 h-24 w-full border border-slate-300 px-3 py-2 text-sm"
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
              Read my answer
            </button>
          </div>

          {proposals ? (
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

/** Same KPI-card recipe as admin-command-center.tsx: gradient bg, top accent bar, glow, icon badge, hover lift. */
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
          <p className="overflow-hidden whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
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
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * One page-wide table, adapted from the same column set the post-upload
 * payroll dashboard uses (SalaryReportTable) — so this reads like the sheet
 * HR already knows, instead of the old three-way split of separate boxes.
 * A flagged employee renders as TWO rows: identity + status + actions, then
 * a second row spanning the full width with their open question(s). Clean
 * employees render as a single row.
 */
function PayrollSheetTable({
  employees,
  groupedHrIds,
  busy,
  onConfirmEmployee,
  onReportIssue,
  onHoldEmployee,
}: {
  employees: EmployeeRow[];
  groupedHrIds: Set<string>;
  busy: boolean;
  onConfirmEmployee: (hrId: string) => void;
  onReportIssue: (hrId: string, text: string) => void;
  onHoldEmployee: (hrId: string, reason: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | EmployeeStatus>("all");

  const normalizedQuery = query.trim().toLowerCase();
  const rows = employees.filter((employee) => {
    if (statusFilter !== "all" && employee.status !== statusFilter) return false;
    if (!normalizedQuery) return true;
    return (
      employee.fullName.toLowerCase().includes(normalizedQuery) ||
      employee.hrId.toLowerCase().includes(normalizedQuery)
    );
  });

  const COLUMN_COUNT = 11;

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
            className="w-48 border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400"
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
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="w-[6%] px-2 py-2">HR ID</th>
                <th className="w-[12%] px-2 py-2">Full Name</th>
                <th className="w-[8%] px-2 py-2">Hire Date</th>
                <th className="w-[8%] px-2 py-2">Line</th>
                <th className="w-[8%] px-2 py-2">Area</th>
                <th className="w-[9%] px-2 py-2">Job Title</th>
                <th className="w-[8%] px-2 py-2">Additions</th>
                <th className="w-[8%] px-2 py-2">Deductions</th>
                <th className="w-[8%] px-2 py-2">Net Salary</th>
                <th className="w-[5%] px-2 py-2">Status</th>
                <th className="w-[20%] px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((employee) => {
                const meta = STATUS_META[employee.status];
                return (
                  <Fragment key={employee.hrId}>
                    <tr className="hover:bg-slate-50">
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 font-mono text-xs text-slate-500">
                        {employee.hrId}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 font-medium text-slate-900">
                        {employee.fullName}
                        {groupedHrIds.has(employee.hrId) ? (
                          <span className="ml-2 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            Grouped
                          </span>
                        ) : null}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 text-slate-600">
                        {formatShortDate(employee.hireDate)}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 text-slate-600">
                        {employee.line || "—"}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 text-slate-600">
                        {employee.area || "—"}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 text-slate-600">
                        {employee.jobTitle || "—"}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 font-mono text-emerald-700">
                        {egp(employee.totalAdditions)}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 font-mono text-rose-700">
                        {egp(employee.totalDeductions)}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-2 py-2 font-mono font-semibold text-slate-900">
                        {egp(employee.netSalary)}
                      </td>
                      <td className="px-2 py-2">
                        <span className={`px-1.5 py-0.5 text-xs font-semibold ${meta.className}`}>{meta.label}</span>
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
                    {employee.status === "question" ? (
                      <tr className="bg-amber-50/40">
                        <td className="px-2 py-2" colSpan={COLUMN_COUNT}>
                          {employee.flags.map((flag) => (
                            <p
                              key={flag.rule}
                              className={`border-l-4 pl-2 text-sm text-slate-700 ${SEVERITY_STYLES[flag.severity]}`}
                            >
                              {flag.question}
                            </p>
                          ))}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
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
            className="h-16 w-full border border-slate-300 px-2 py-1 text-xs"
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
          className="h-16 w-full border border-slate-300 px-2 py-1 text-xs"
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
