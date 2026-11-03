"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, Loader2, MailPlus, Search } from "lucide-react";

import { AdoptMailboxCard } from "@/components/new-hire-mailbox/adopt-mailbox-card";
import { AppPasswordControlsCard } from "@/components/new-hire-mailbox/app-password-controls-card";
import { AppPasswordRehearsalCard } from "@/components/new-hire-mailbox/app-password-rehearsal-card";
import { InviteInboxCard } from "@/components/new-hire-mailbox/invite-inbox-card";
import { INVITE_INBOX_ADDRESS } from "@/lib/new-hire-mailbox/robot/invite-inbox";
import { PremiumHero } from "@/components/ui/premium-hero";
import { employeeLeftLabel } from "@/lib/employees/left-flag";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import {
  NEW_HIRE_MAILBOX_STEPS,
  newHireMailboxDetails,
  NOT_RECORDED,
  TURBIFY_CONTROL_PANEL_URL,
} from "@/lib/new-hire-mailbox/messages";
import type { NewHireMailboxTask } from "@/lib/new-hire-mailbox/service";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * New Hire Mailboxes — the page the "new employee, company email needed" notice lands on.
 *
 * Same identity as its siblings (the New Hire CRM Setup tab and Mailbox Revocation): PremiumHero,
 * square corners, slate borders, orange primary. Pending hires are CARDS at every width — each
 * carries five facts, two inputs and two buttons, which no table row can hold without a sideways
 * scroll. The closed list below is a four-column fixed table on desktop and cards on a phone.
 */

function formatInstant(value: string | null): string {
  if (!value) return NOT_RECORDED;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return NOT_RECORDED;
  // An instant we stamped, so Cairo time.
  return stableEnGbFormatter({
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

function outcomeLabel(task: NewHireMailboxTask): string {
  return task.status === "connected" ? "Email connected" : "No company email needed";
}

function PendingCard({
  canConnect,
  onResolved,
  spotlighted,
  task,
}: {
  canConnect: boolean;
  onResolved: (hrId: string, message: string) => void;
  spotlighted: boolean;
  task: NewHireMailboxTask;
}) {
  const [emailAddress, setEmailAddress] = useState(task.subject.emailAddress ?? "");
  const [appPassword, setAppPassword] = useState("");
  const [note, setNote] = useState("");
  const [showDismiss, setShowDismiss] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "connect" | "dismiss") {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/new-hire-mailboxes", {
        body: JSON.stringify(
          action === "connect"
            ? { action, appPassword, emailAddress: emailAddress.trim(), hrId: task.subject.hrId }
            : { action, hrId: task.subject.hrId, note: note.trim() },
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        emailAddress?: string;
        message?: string;
        success?: boolean;
        workEmailUpdated?: boolean;
      };
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "The save did not go through.");
        return;
      }
      setAppPassword("");
      onResolved(
        task.subject.hrId,
        action === "connect"
          ? `${task.subject.displayName}'s email ${payload.emailAddress ?? ""} is connected. Their My email works the first time they sign in.${payload.workEmailUpdated ? " Their employee record now shows this address." : ""}`
          : `${task.subject.displayName} marked as needing no company email.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "The save did not go through.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      className={
        spotlighted ? "border-2 border-orange-500 bg-white p-4 sm:p-5" : "border border-slate-200 bg-white p-4 sm:p-5"
      }
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-base font-black tracking-[-0.01em] text-slate-950">
            {task.subject.displayName}
          </h3>
          <p className="mt-0.5 break-words text-xs font-medium text-slate-500">
            {task.subject.jobTitle ?? NOT_RECORDED}
            {` · added ${formatInstant(task.openedAt)}`}
            {task.source === "employee_import" ? " · from an employee import" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {task.employeeLeft ? (
            <span className="border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700">
              {employeeLeftLabel(task.employeeLeft)}
            </span>
          ) : null}
          {task.employeeFound ? null : (
            <span className="border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700">
              Employee record not found
            </span>
          )}
          {task.hasLogin ? null : (
            <span className="border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-800">
              No Phoenix login yet
            </span>
          )}
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* The name is the card heading already; the other four facts sit under it. */}
        {newHireMailboxDetails(task.subject)
          .filter((detail) => detail.label !== "Employee")
          .map((detail) => (
          <div className="min-w-0" key={detail.label}>
            <dt className="text-[11px] font-black uppercase tracking-wider text-slate-400">{detail.label}</dt>
            <dd className="break-words text-sm font-medium text-slate-800">{detail.value}</dd>
          </div>
          ))}
      </dl>

      {canConnect ? (
        <div className="mt-4 border-t border-slate-100 pt-4">
          {showDismiss ? (
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                Why this person needs no company email
              </span>
              <input
                className={phxFieldClassName}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. Driver — never uses email"
                type="text"
                value={note}
              />
            </label>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">Email address</span>
                <input
                  autoComplete="off"
                  className={phxFieldClassName}
                  onChange={(event) => setEmailAddress(event.target.value)}
                  placeholder="first.second@satopharma.com"
                  spellCheck={false}
                  type="email"
                  value={emailAddress}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">App password</span>
                <input
                  autoComplete="off"
                  className={phxFieldClassName}
                  onChange={(event) => setAppPassword(event.target.value)}
                  placeholder="The letters Turbify showed, spaces or not"
                  spellCheck={false}
                  type="password"
                  value={appPassword}
                />
              </label>
            </div>
          )}

          <p className="mt-2 text-xs leading-5 text-slate-500">
            {showDismiss
              ? "The reason is kept with your name on it, and the card leaves the queue."
              : "Phoenix signs in to the mailbox once to check the password, then keeps it sealed for this person alone. Nobody, you included, can open their mail from here."}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 border border-orange-600 bg-orange-600 px-3 text-xs font-bold text-white transition hover:bg-orange-700 disabled:opacity-50"
              disabled={saving || (!showDismiss && appPassword.trim().length === 0)}
              onClick={() => submit(showDismiss ? "dismiss" : "connect")}
              type="button"
            >
              {saving && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
              {showDismiss ? "Confirm — no company email needed" : "Connect"}
            </button>
            <button
              className="inline-flex h-9 items-center border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-slate-400 disabled:opacity-50"
              disabled={saving}
              onClick={() => {
                setShowDismiss((current) => !current);
                setError(null);
              }}
              type="button"
            >
              {showDismiss ? "Back to connecting the email" : "No company email needed"}
            </button>
          </div>

          {error && <p className="mt-2 break-words text-xs font-medium text-rose-600">{error}</p>}
        </div>
      ) : null}
    </article>
  );
}

export function NewHireMailboxPanel({
  canAdopt,
  canConnect,
  loadError,
  pending,
  recentlyResolved,
  schemaMissing,
  spotlightHrId,
}: {
  /** Super Admin alone — the page decides it, and the route asserts it again. */
  canAdopt: boolean;
  canConnect: boolean;
  loadError: string | null;
  pending: NewHireMailboxTask[];
  recentlyResolved: NewHireMailboxTask[];
  schemaMissing: boolean;
  spotlightHrId: string | null;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  // Cards closed on this page leave at once; a refresh that brings a NEW hire still shows it.
  const [closedHere, setClosedHere] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => pending.filter((task) => !closedHere.has(task.subject.hrId)), [closedHere, pending]);
  const [toast, setToast] = useState<string | null>(null);
  const spotlightKey = (spotlightHrId ?? "").trim().toLowerCase();

  function handleResolved(hrId: string, message: string) {
    setClosedHere((current) => new Set(current).add(hrId));
    setToast(message);
    router.refresh();
  }

  const term = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matching = term
      ? rows.filter((task) =>
        [task.subject.displayName, task.subject.emailAddress, task.subject.jobTitle, task.subject.lineName]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(term)),
      )
      : rows;
    if (!spotlightKey) return matching;
    // The person the notice was about comes first.
    return [...matching].sort((left, right) => {
      const leftHit = left.subject.hrId.toLowerCase() === spotlightKey ? 0 : 1;
      const rightHit = right.subject.hrId.toLowerCase() === spotlightKey ? 0 : 1;
      return leftHit - rightHit;
    });
  }, [rows, spotlightKey, term]);

  const spotlightAlreadyDone = spotlightKey
    ? recentlyResolved.find((task) => task.subject.hrId.toLowerCase() === spotlightKey)
    : undefined;

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker="Onboarding"
        subtitle="Every new hire waiting for a company email. Create the mailbox in Turbify, paste its app password here, and their My email in Phoenix is connected before their first day — with nothing for them to do."
        title="New hire mailboxes"
      />

      <div className="mt-5 space-y-4">
        {loadError ? (
          <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900" role="alert">
            {loadError}
          </div>
        ) : null}

        {schemaMissing ? (
          <div className="border border-amber-200 bg-amber-50 px-4 py-6 text-sm font-medium text-amber-900">
            The new hire mailbox queue is not provisioned in this environment yet. It appears once the
            <span className="font-bold"> new_hire_mailbox_tasks </span> migration has been applied here.
          </div>
        ) : null}

        {canConnect ? (
          <section className="border border-slate-200 bg-white px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xs font-black uppercase tracking-wider text-slate-500">For each new hire</h2>
              <a
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                href={TURBIFY_CONTROL_PANEL_URL}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                Open Turbify
              </a>
            </div>
            <ol className="mt-3 space-y-1.5">
              {NEW_HIRE_MAILBOX_STEPS.map((step, index) => (
                <li className="flex gap-3 text-sm text-slate-700" key={step}>
                  <span className="w-5 shrink-0 text-right font-black tabular-nums text-orange-600">{index + 1}</span>
                  <span className="min-w-0 break-words">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {canAdopt ? <AdoptMailboxCard pending={pending} /> : null}

        {/* Same audience as adoption: it resets a mailbox password. Unlike the adopt card it
            does not depend on the queue — the invite inbox is adopted once, and from then on
            the robot finishes every mailbox it creates without anybody clicking. */}
        {canAdopt ? <InviteInboxCard inviteInbox={INVITE_INBOX_ADDRESS} /> : null}

        {/* The one trigger for the App Passwords capture. It changes nothing — it signs in with the
            password Phoenix already holds and reads the page — but the gate is the same audience
            anyway, because signing in AS a mailbox is what it does. Without this card the route has
            no caller at all: it refuses a cross-origin request, and this module has already shipped
            one tested, documented, merged module that nothing called. */}
        {canAdopt ? <AppPasswordControlsCard inviteInbox={INVITE_INBOX_ADDRESS} /> : null}
        {canAdopt ? <AppPasswordRehearsalCard inviteInbox={INVITE_INBOX_ADDRESS} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
          <p className="min-w-0 text-sm font-medium text-slate-600">
            {rows.length === 0 ? (
              "Every new hire has a connected company email or was ruled not to need one."
            ) : (
              <>
                <span className="font-bold text-slate-900">{rows.length}</span>
                {rows.length === 1 ? " new hire is" : " new hires are"} waiting for a company email.
              </>
            )}
          </p>
          <div className="relative w-full sm:w-64">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className={cn(phxFieldClassName, "pl-8")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, email or line"
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
              {spotlightAlreadyDone.resolvedByName ? ` by ${spotlightAlreadyDone.resolvedByName}` : ""}
              {spotlightAlreadyDone.status === "not_needed" ? " — recorded as needing no company email." : "."}
            </span>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border border-slate-200 bg-white px-4 py-10 text-center">
            <MailPlus aria-hidden="true" className="h-5 w-5 text-slate-400" />
            <p className="text-sm text-slate-500">
              {rows.length === 0
                ? "Nothing is waiting. A card appears here the moment an employee is added."
                : "No new hires match this search."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((task) => (
              <PendingCard
                canConnect={canConnect}
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
            <ul className="divide-y divide-slate-100 md:hidden">
              {recentlyResolved.map((task) => (
                <li className="px-4 py-3" key={task.subject.hrId}>
                  <p className="break-words text-sm font-bold text-slate-900">{task.subject.displayName}</p>
                  <p className="mt-1 break-words text-sm text-slate-700">{outcomeLabel(task)}</p>
                  {task.status === "connected" && task.subject.emailAddress ? (
                    <p className="break-all text-xs text-slate-600">{task.subject.emailAddress}</p>
                  ) : null}
                  {task.resolutionNote ? <p className="break-words text-xs text-slate-500">{task.resolutionNote}</p> : null}
                  <p className="mt-1 break-words text-xs text-slate-500">
                    {task.resolvedByName ?? NOT_RECORDED}
                    {task.resolvedAt ? ` · ${formatInstant(task.resolvedAt)}` : ""}
                  </p>
                </li>
              ))}
            </ul>

            {/* table-fixed with a colgroup, every cell wrapping: the four columns fit their container
                at every desktop width with no sideways scroll (AGENTS.md §4). */}
            <div className="hidden md:block">
              <table className="w-full table-fixed">
                <colgroup>
                  <col className="w-[28%]" />
                  <col className="w-[24%]" />
                  <col className="w-[28%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead className="bg-slate-900">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Employee</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Outcome</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-wider text-slate-300">Email</th>
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
                        {outcomeLabel(task)}
                        {task.resolutionNote ? <span className="block text-xs text-slate-500">{task.resolutionNote}</span> : null}
                      </td>
                      <td className="break-all px-3 py-2.5 align-top text-sm text-slate-700">
                        {task.status === "connected" && task.subject.emailAddress ? (
                          task.subject.emailAddress
                        ) : (
                          <span className="text-slate-400">{NOT_RECORDED}</span>
                        )}
                      </td>
                      <td className="break-words px-3 py-2.5 align-top text-sm text-slate-700">
                        {task.resolvedByName ?? NOT_RECORDED}
                        <span className="block text-xs text-slate-500">{task.resolvedAt ? formatInstant(task.resolvedAt) : ""}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
