"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, Loader2, Search, UserPlus } from "lucide-react";

import {
  CRM_ACCOUNT_SETUP_CV_CTA_LABEL,
  crmAccountSetupCvHref,
  crmAccountSetupDetails,
  hasCvOnFile,
  NOT_RECORDED,
  type CrmAccountSetupSubject,
} from "@/lib/crm/account-setup-messages";
import type { CrmAccountSetupTaskRow } from "@/lib/crm/account-setup";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * New Hire CRM Setup — the screen the "an employee was added" notice sends you to.
 *
 * It renders as CARDS at every width rather than as a table, and that is a design decision, not a
 * mobile fallback. Each row here carries nine facts about a person plus two inputs and two buttons;
 * as columns that is a board no screen can hold, and the house rule is explicit that fitting by
 * horizontal scroll is the bug rather than the fix (AGENTS.md §4). Cards let the facts WRAP, which
 * is the permitted answer, and the small resolved table below stays inside four fixed columns.
 */

function formatOpenedAt(value: string): string {
  if (!value) return NOT_RECORDED;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return NOT_RECORDED;
  // An INSTANT we stamped (opened_at, timestamptz), so it renders in Africa/Cairo — the owner's
  // standing rule. This is the opposite case from the hiring date beside it, which is a calendar
  // day and must stay UTC; see account-setup-messages.ts.
  return stableEnGbFormatter({
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

function DetailGrid({ subject }: { subject: CrmAccountSetupSubject }) {
  // The same nine facts, in the same order, as the email and the in-app notification — they come
  // from one builder so the screen can never show something the notice did not.
  const details = crmAccountSetupDetails(subject);
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {details.map((detail) => (
        <div className="min-w-0" key={detail.label}>
          <dt className="text-[11px] font-black uppercase tracking-wider text-slate-400">{detail.label}</dt>
          {/* break-words, never truncate: the ellipsis ban is absolute here, and a wrapped
              mobile number is readable while a clipped one is a support call. */}
          <dd className="break-words text-sm font-medium text-slate-800">{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The CV, when there is one — the same download the notice's second button opens.
 *
 * A plain anchor, not a fetch: the route answers with a Content-Disposition, so the browser saves
 * the file and this component never has to hold several megabytes in memory to hand them straight
 * back. `download` is not set on purpose — the server names the file, including when the name is
 * Arabic, and letting the attribute override it would flatten that.
 *
 * Renders NOTHING when no CV is on file. The DetailGrid above already says "CV — Not attached", so
 * an empty, disabled button here would say it twice and offer an action that cannot be taken.
 */
function CvDownload({ subject }: { subject: CrmAccountSetupSubject }) {
  if (!hasCvOnFile(subject)) return null;
  return (
    <a
      className="mt-4 inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
      href={crmAccountSetupCvHref(subject.hrId)}
      rel="noreferrer"
    >
      <Download aria-hidden="true" className="h-3.5 w-3.5" />
      {/* The filename is shown, never truncated — it wraps. The owner's ellipsis ban is absolute,
          and the name is how the reader knows which document this is before opening it. */}
      <span className="break-all text-left">{`${CRM_ACCOUNT_SETUP_CV_CTA_LABEL} — ${String(subject.cvFileName).trim()}`}</span>
    </a>
  );
}

function PendingCard({
  onResolved,
  task,
  spotlighted,
}: {
  onResolved: (hrId: string, message: string) => void;
  spotlighted: boolean;
  task: CrmAccountSetupTaskRow;
}) {
  const [crmUsername, setCrmUsername] = useState(task.crmUsername ?? "");
  const [crmCode, setCrmCode] = useState(task.crmId ?? "");
  const [note, setNote] = useState("");
  const [showDismiss, setShowDismiss] = useState(false);
  const [saving, setSaving] = useState<"save" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "save" | "dismiss") {
    setSaving(action);
    setError(null);
    try {
      const response = await fetch("/api/admin/crm/account-setup", {
        body: JSON.stringify({
          action,
          crmCode: crmCode.trim(),
          crmUsername: crmUsername.trim(),
          hrId: task.subject.hrId,
          note: note.trim(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; success?: boolean };
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "Failed to save.");
        return;
      }
      onResolved(
        task.subject.hrId,
        action === "save"
          ? `CRM account recorded for ${task.subject.displayName}.`
          : `${task.subject.displayName} marked as needing no CRM account.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <article
      className={
        spotlighted
          ? "border-2 border-orange-500 bg-white p-4 sm:p-5"
          : "border border-slate-200 bg-white p-4 sm:p-5"
      }
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-base font-black tracking-[-0.01em] text-slate-950">
            {task.subject.displayName}
          </h3>
          <p className="mt-0.5 break-words text-xs font-medium text-slate-500">
            {task.subject.jobTitle ? `${task.subject.jobTitle} · ` : ""}
            {`added ${formatOpenedAt(task.openedAt)}`}
            {task.source === "employee_import" ? " · from an employee import" : ""}
          </p>
        </div>
        {task.employeeFound ? null : (
          <span className="border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700">
            Employee record not found
          </span>
        )}
      </header>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <DetailGrid subject={task.subject} />
        <CvDownload subject={task.subject} />
      </div>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">CRM username</span>
            <input
              className={phxFieldClassName}
              onChange={(event) => setCrmUsername(event.target.value)}
              placeholder="The login name in iReports360"
              type="text"
              value={crmUsername}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">CRM code</span>
            <input
              className={phxFieldClassName}
              onChange={(event) => setCrmCode(event.target.value)}
              placeholder="The agent id in iReports360"
              type="text"
              value={crmCode}
            />
          </label>
        </div>

        <p className="mt-2 text-xs leading-5 text-slate-500">
          Both are stored on this employee&apos;s own record, as CRM Username and CRM ID. Until at least
          one is filled, this person&apos;s visits and check-ins cannot be matched to them.
        </p>

        {showDismiss && (
          <label className="mt-3 flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">
              Why this person needs no CRM account
            </span>
            <input
              className={phxFieldClassName}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Head office finance role — never visits customers"
              type="text"
              value={note}
            />
          </label>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="inline-flex h-9 items-center gap-2 border border-orange-600 bg-orange-600 px-3 text-xs font-bold text-white transition hover:bg-orange-700 disabled:opacity-50"
            disabled={saving !== null}
            onClick={() => (showDismiss ? submit("dismiss") : submit("save"))}
            type="button"
          >
            {saving !== null && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
            {showDismiss ? "Confirm — no CRM account needed" : "Save CRM account"}
          </button>
          <button
            className="inline-flex h-9 items-center border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-slate-400 disabled:opacity-50"
            disabled={saving !== null}
            onClick={() => {
              setShowDismiss((current) => !current);
              setError(null);
            }}
            type="button"
          >
            {showDismiss ? "Back to entering the account" : "No CRM account needed"}
          </button>
        </div>

        {error && <p className="mt-2 break-words text-xs font-medium text-rose-600">{error}</p>}
      </div>
    </article>
  );
}

export function CrmAccountSetupPanel({
  pending,
  recentlyResolved,
  schemaMissing,
  spotlightHrId,
}: {
  pending: CrmAccountSetupTaskRow[];
  recentlyResolved: CrmAccountSetupTaskRow[];
  schemaMissing: boolean;
  spotlightHrId: string | null;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(pending);
  const [toast, setToast] = useState<string | null>(null);

  const spotlightKey = (spotlightHrId ?? "").trim().toLowerCase();

  function handleResolved(hrId: string, message: string) {
    setRows((current) => current.filter((task) => task.subject.hrId !== hrId));
    setToast(message);
    // The resolved list and any other view of this person are server-rendered, so refresh rather
    // than leaving the page showing a queue the database no longer agrees with.
    router.refresh();
  }

  const term = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matching = term
      ? rows.filter((task) =>
        [task.subject.displayName, task.subject.hrId, task.subject.lineName, task.subject.areaName, task.subject.jobTitle]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(term)),
      )
      : rows;
    if (!spotlightKey) return matching;
    // The person named in the notification comes first, whatever the sort — the reader arrived
    // here from a message about ONE person and should not have to find them.
    return [...matching].sort((left, right) => {
      const leftHit = left.subject.hrId.toLowerCase() === spotlightKey ? 0 : 1;
      const rightHit = right.subject.hrId.toLowerCase() === spotlightKey ? 0 : 1;
      return leftHit - rightHit;
    });
  }, [rows, spotlightKey, term]);

  const spotlightAlreadyDone = spotlightKey
    ? recentlyResolved.find((task) => task.subject.hrId.toLowerCase() === spotlightKey)
    : undefined;

  if (schemaMissing) {
    return (
      <div className="border border-amber-200 bg-amber-50 px-4 py-6 text-sm font-medium text-amber-900">
        The new-hire CRM setup queue is not provisioned in this environment yet. It appears once the
        <span className="font-bold"> crm_account_setup_tasks </span> migration has been applied here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
        <p className="min-w-0 text-sm font-medium text-slate-600">
          {rows.length === 0 ? (
            "Every field employee added to the master has been given a CRM account or ruled not to need one."
          ) : (
            <>
              <span className="font-bold text-slate-900">{rows.length}</span>
              {rows.length === 1 ? " new field employee is" : " new field employees are"} waiting for an
              iReports360 account. Enter the <span className="font-semibold text-slate-900">CRM username</span> and{" "}
              <span className="font-semibold text-slate-900">CRM code</span>, or record that no account is
              needed.
            </>
          )}
        </p>
        <div className="relative w-full sm:w-64">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-8")}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, HR ID, line or area"
            type="text"
            value={search}
          />
        </div>
      </div>

      {toast && (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800">
          <span className="min-w-0 break-words">{toast}</span>
          <button className="text-emerald-700 hover:text-emerald-900" onClick={() => setToast(null)} type="button">
            Dismiss
          </button>
        </div>
      )}

      {spotlightAlreadyDone && (
        <div className="flex items-start gap-2 border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span className="min-w-0 break-words">
            {spotlightAlreadyDone.subject.displayName} was already dealt with
            {spotlightAlreadyDone.resolvedByHrId ? ` by ${spotlightAlreadyDone.resolvedByHrId}` : ""}
            {spotlightAlreadyDone.status === "not_applicable" ? " — recorded as needing no CRM account." : "."}
          </span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 border border-slate-200 bg-white px-4 py-10 text-center">
          <UserPlus aria-hidden="true" className="h-5 w-5 text-slate-400" />
          <p className="text-sm text-slate-500">
            {rows.length === 0
              ? "Nothing is waiting for a CRM account. Head-office hires never open one."
              : "No new hires match this search."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((task) => (
            <PendingCard
              key={task.subject.hrId}
              onResolved={handleResolved}
              spotlighted={task.subject.hrId.toLowerCase() === spotlightKey}
              task={task}
            />
          ))}
        </div>
      )}

      {recentlyResolved.length > 0 && (
        <section className="border border-slate-200 bg-white">
          <h3 className="border-b border-slate-100 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-500">
            Recently dealt with
          </h3>
          {/* One card per row below md. The table beside it is desktop-only — module rule for
              every table under src/components/crm, pinned by tests/crm-mobile-table-cards.test.ts:
              four columns of decision history is a table a phone should never be handed, even one
              that fits. */}
          <ul className="divide-y divide-slate-100 md:hidden">
            {recentlyResolved.map((task) => (
              <li className="px-4 py-3" key={task.subject.hrId}>
                <p className="break-words text-sm font-bold text-slate-900">{task.subject.displayName}</p>
                <p className="break-words text-xs text-slate-500">
                  {[task.subject.jobTitle, task.subject.areaName, task.subject.lineName].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-1 break-words text-sm text-slate-700">
                  {task.status === "completed" ? "CRM account recorded" : "No CRM account needed"}
                </p>
                {task.resolutionNote ? (
                  <p className="break-words text-xs text-slate-500">{task.resolutionNote}</p>
                ) : null}
                {task.crmUsername || task.crmId ? (
                  <p className="mt-1 break-words text-xs text-slate-600">
                    {task.crmUsername ?? NOT_RECORDED}
                    {task.crmId ? ` · Code ${task.crmId}` : ""}
                  </p>
                ) : null}
                <p className="mt-1 break-words text-xs text-slate-500">
                  {task.resolvedByHrId ?? NOT_RECORDED}
                  {task.resolvedAt ? ` · ${formatOpenedAt(task.resolvedAt)}` : ""}
                </p>
              </li>
            ))}
          </ul>

          {/* w-full table-fixed with a colgroup, never a min-width scroller: the five columns fit
              their container because every cell wraps. Widths were re-budgeted when Area was added
              rather than the type being shrunk — AGENTS.md §4, the fits-the-screen golden rule.
              `hidden md:block` is the module's mobile rule, not a scroll gate, so the floor here is
              768px and the Area column is carried on the mobile card instead. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[18%]" />
                <col className="w-[20%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Employee</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Area</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Outcome</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">CRM account</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Decided by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {recentlyResolved.map((task) => (
                  <tr className="odd:bg-white even:bg-orange-50/30" key={task.subject.hrId}>
                    <td className="break-words px-3 py-2.5 align-top text-sm font-medium text-slate-900">
                      {task.subject.displayName}
                      {task.subject.jobTitle ? (
                        <span className="block text-xs font-normal text-slate-500">{task.subject.jobTitle}</span>
                      ) : null}
                    </td>
                    <td className="break-words px-3 py-2.5 align-top text-sm text-slate-700">
                      {task.subject.areaName ?? NOT_RECORDED}
                      {task.subject.lineName ? (
                        <span className="block text-xs text-slate-500">{task.subject.lineName}</span>
                      ) : null}
                    </td>
                    <td className="break-words px-3 py-2.5 align-top text-sm text-slate-700">
                      {task.status === "completed" ? "CRM account recorded" : "No CRM account needed"}
                      {task.resolutionNote ? (
                        <span className="block text-xs text-slate-500">{task.resolutionNote}</span>
                      ) : null}
                    </td>
                    <td className="break-words px-3 py-2.5 align-top text-sm text-slate-700">
                      {task.crmUsername || task.crmId ? (
                        <>
                          {task.crmUsername ? <span className="block">{task.crmUsername}</span> : null}
                          {task.crmId ? <span className="block text-xs text-slate-500">Code {task.crmId}</span> : null}
                        </>
                      ) : (
                        <span className="text-slate-400">{NOT_RECORDED}</span>
                      )}
                    </td>
                    <td className="break-words px-3 py-2.5 align-top text-sm text-slate-700">
                      {task.resolvedByHrId ?? NOT_RECORDED}
                      <span className="block text-xs text-slate-500">
                        {task.resolvedAt ? formatOpenedAt(task.resolvedAt) : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
