"use client";

import { useState } from "react";

import { DeductionReviewTable } from "./tabs/deduction-review-table";

type Flag = {
  employeeHrId: string;
  rule: string;
  severity: "block" | "warn";
  question: string;
};

type FlaggedEmployee = {
  hrId: string;
  fullName: string;
  jobTitle: string;
  line: string;
  netSalary: number;
  flags: Flag[];
};

type SimpleEmployee = {
  hrId: string;
  fullName: string;
  netSalary: number;
  monthSalary: number;
};

type RecurringApplied = { hrId: string; kind: string; amount: number; note: string | null };

type Draft = {
  period: { month: number; year: number };
  employeeCount: number;
  greenCount: number;
  flaggedOpenCount: number;
  openBlockCount: number;
  canMaterialize: boolean;
  recurringApplied: RecurringApplied[];
  flagged: FlaggedEmployee[];
  resolved: SimpleEmployee[];
  green: SimpleEmployee[];
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

function egp(value: number): string {
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

const SEVERITY_STYLES: Record<Flag["severity"], string> = {
  block: "border-l-rose-500",
  warn: "border-l-amber-500",
};

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
        <header className="border-l-4 border-l-orange-500 bg-slate-900 px-6 py-5 text-white">
          <h1 className="text-xl font-bold tracking-tight">Payroll Copilot</h1>
          <p className="mt-1 text-sm text-slate-300">
            Assembles the monthly payroll from your modules, asks about anyone who isn&apos;t clean, and builds an
            editable draft you can lock. Restricted to CEO &amp; Super Admin.
          </p>
        </header>

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
                className="bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
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
}) {
  const { view, draft, busy, chat, proposals, materialized } = props;
  const [activeTab, setActiveTab] = useState<"negotiation" | "fingerprint">("negotiation");
  if (!draft) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Employees" value={draft.employeeCount} />
        <Stat label="Green (auto)" value={draft.greenCount} tone="text-emerald-600" />
        <Stat label="Need answers" value={draft.flaggedOpenCount} tone="text-amber-600" />
        <Stat label="Blocking" value={draft.openBlockCount} tone="text-rose-600" />
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
            { key: "negotiation", label: "Negotiation" },
            { key: "fingerprint", label: "Fingerprint Deductions" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-semibold ${
              activeTab === tab.key
                ? "border-b-2 border-orange-500 text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
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
      ) : (
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4">
          <div className="border border-slate-200 bg-white">
            <div className="border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
              Questions ({draft.flagged.length})
            </div>
            <div className="divide-y divide-slate-100">
              {draft.flagged.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-500">
                  Everyone is green — no questions. You can generate the sheet.
                </p>
              ) : (
                draft.flagged.map((employee) => (
                  <div key={employee.hrId} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900">
                        {employee.fullName} <span className="text-slate-400">({employee.hrId})</span>
                      </p>
                      {employee.flags.map((flag) => (
                        <p
                          key={flag.rule}
                          className={`mt-1 border-l-4 pl-2 text-slate-600 ${SEVERITY_STYLES[flag.severity]}`}
                        >
                          {flag.question}
                        </p>
                      ))}
                    </div>
                    <EmployeeRowActions
                      busy={props.busy}
                      onConfirm={() => props.onConfirmEmployee(employee.hrId)}
                      onReportIssue={(text) => props.onReportIssue(employee.hrId, text)}
                      onHold={(reason) => props.onHoldEmployee(employee.hrId, reason)}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

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
                    className="bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
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
        </section>

        <section className="space-y-4">
          <ListCard
            title={`Auto-filled — green (${draft.green.length})`}
            rows={draft.green}
            emptyText="No fully-clean employees yet."
            busy={busy}
            onConfirmEmployee={props.onConfirmEmployee}
            onReportIssue={props.onReportIssue}
            onHoldEmployee={props.onHoldEmployee}
          />
          <ListCard
            title={`Resolved by you (${draft.resolved.length})`}
            rows={draft.resolved}
            emptyText="No manual resolutions yet."
            busy={busy}
            onConfirmEmployee={props.onConfirmEmployee}
            onReportIssue={props.onReportIssue}
            onHoldEmployee={props.onHoldEmployee}
          />
          {draft.recurringApplied.length > 0 ? (
            <div className="border border-slate-200 bg-white">
              <div className="border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
                Recurring auto-applied ({draft.recurringApplied.length})
              </div>
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
        </section>
      </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <p className="text-sm text-slate-500">
          {draft.canMaterialize
            ? "Ready — no blocking questions remain."
            : `${draft.openBlockCount} blocking question(s) must be answered before generating the sheet.`}
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
            className="bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {view.run.status === "drafted" ? "Sheet generated" : "Generate payroll sheet"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone ?? "text-slate-900"}`}>{value}</p>
    </div>
  );
}

function ListCard({
  title,
  rows,
  emptyText,
  busy,
  onConfirmEmployee,
  onReportIssue,
  onHoldEmployee,
}: {
  title: string;
  rows: SimpleEmployee[];
  emptyText: string;
  busy: boolean;
  onConfirmEmployee: (hrId: string) => void;
  onReportIssue: (hrId: string, text: string) => void;
  onHoldEmployee: (hrId: string, reason: string) => void;
}) {
  return (
    <div className="border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm">
          {rows.map((employee) => (
            <li key={employee.hrId} className="flex items-center justify-between gap-3 px-4 py-2">
              <span className="min-w-0 truncate text-slate-700">
                {employee.fullName} <span className="text-slate-400">({employee.hrId})</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="font-medium text-slate-900">{egp(employee.monthSalary || employee.netSalary)}</span>
                <EmployeeRowActions
                  busy={busy}
                  onConfirm={() => onConfirmEmployee(employee.hrId)}
                  onReportIssue={(text) => onReportIssue(employee.hrId, text)}
                  onHold={(reason) => onHoldEmployee(employee.hrId, reason)}
                />
              </span>
            </li>
          ))}
        </ul>
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
function EmployeeRowActions({
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
          className="bg-rose-100 px-2 py-1 text-rose-700 hover:bg-rose-200 disabled:opacity-50"
        >
          ✕
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          title="Confirm as correct"
          className="bg-emerald-100 px-2 py-1 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
        >
          ✓
        </button>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => setMode("hold")}
        title="Put pay on hold"
        className="border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
      >
        Hold
      </button>
    </div>
  );
}
