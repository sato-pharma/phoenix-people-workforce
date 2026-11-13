"use client";

/**
 * Mailbox offboarding workspace — the Turbify leaver register.
 *
 * DESIGN IDENTITY is the HR admin workspaces', deliberately (AGENTS.md §4: match the sibling
 * pages, never invent a one-off look). Same `PremiumHero`, same centred metric tile with its 9px
 * uppercase micro-label and `text-3xl font-black tabular-nums` figure, same orange accent, same
 * square corners and slate borders, same desktop-table / mobile-card split.
 *
 * DESKTOP GETS THE TABLE, MOBILE NEVER DOES — the owner's standing rule.
 *
 * IT FITS THE SCREEN (AGENTS.md §4). `table-fixed` with a `<colgroup>`, never a `min-width` under
 * an `overflow-x-auto` — that pairing IS the bug the golden rule names, and it was here: at a 1280px
 * viewport this table measured 1840px inside a 909px wrapper. The page-level check
 * `documentElement.scrollWidth > clientWidth` read FALSE the whole time, because the scrolling
 * wrapper absorbed the overflow — measure the TABLE against its WRAPPER, and the ink inside each
 * cell against that cell, or the screen certifies itself while content hangs off the side.
 *
 * NINE COLUMNS BECAME FOUR BY MERGING, never by shrinking type. Job title, mailbox and last day
 * fold into the person cell (the order the mobile card already used); the three steps share one
 * self-labelling column; the two corrections sit under the state chips. Long values WRAP — the
 * "nothing wraps" rule this file used to carry is superseded by the golden rule, and the ellipsis
 * ban is untouched: nothing truncates.
 *
 * THE WIDTH TO DESIGN AGAINST IS 669px, NOT 1280. The 292px sidebar is `hidden lg:flex`, so the
 * content box NARROWS as the viewport crosses 1024px — 991px at 1023, 669px at 1024. That is the
 * tightest this table ever gets, and the column percentages are sized so step 3's `<select>` still
 * clears its 192px natural width there (it renders 217px; a shrunk `<select>` is the one thing the
 * golden rule says cannot be fixed by narrowing). Re-measure at 1024, not only at 1280.
 *
 * NO `window.prompt` OR `window.confirm`. Reasons are captured inline, against the row they are
 * about.
 *
 * THE ROW IS THE UNIT OF WORK ON DESKTOP. All three steps are recorded from inside the row, and
 * nothing opens anywhere else. This replaced an expander whose panel rendered underneath the whole
 * table: with ~50 people in the backlog that meant scrolling down to act and back up to find the
 * next one, once per person. The owner`s words were the specification — everything in the same row,
 * no jumping down and up. Only the two rare corrections (reopen, no-mailbox) need typing, and their
 * box opens in the last cell of that same row.
 *
 * THE PAGE LEADS WITH THE HALF-REVOKED COUNT, not with the overdue count, and the standing notice
 * above the table explains why in one sentence. A password reset is the step everyone believes
 * finishes the job; Yahoo app passwords survive it, so a reset-only mailbox is still reachable
 * from the leaver's phone. If this screen teaches the admin one thing, that is the thing.
 */

import {
  CircleSlash,
  ExternalLink,
  KeyRound,
  Loader2,
  MailX,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { MailboxEditFormProbeCard } from "@/components/mailbox-offboarding/mailbox-edit-form-probe-card";
import { PremiumHero } from "@/components/ui/premium-hero";
import type {
  MailboxBulkOutcome,
  MailboxBulkStep,
  MailboxDisposition,
  MailboxOffboardingDashboardData,
  MailboxOffboardingTask,
} from "@/lib/mailbox-offboarding/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

type StatusFilter = "action" | "half" | "progress" | "revoked" | "all";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "action", label: "Needs action" },
  { key: "half", label: "Still reachable" },
  { key: "progress", label: "In progress" },
  { key: "revoked", label: "Revoked" },
  { key: "all", label: "All" },
];

const DISPOSITION_LABEL: Record<MailboxDisposition, string> = {
  deleted: "Mailbox deleted",
  suspended: "Mailbox suspended",
  forwarding: "Forwarding to someone else",
  retained: "Left running deliberately",
};

// DATE-ONLY (offboarding task dates, sliced to 10 chars first), which `new Date` parses as UTC
// midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a
// zone offset. Not an instant — do not "fix" this one to Cairo.
function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function MetricTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "slate" | "amber" | "emerald" | "rose";
}) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4 text-center">
      <div className="text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
    </div>
  );
}

function StatusChip({ task }: { task: MailboxOffboardingTask }) {
  if (task.status === "revoked") {
    return (
      <span className="inline-flex items-center gap-1 border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800">
        <ShieldCheck aria-hidden="true" className="h-3 w-3" /> Revoked
      </span>
    );
  }
  if (task.status === "not_applicable") {
    return (
      <span className="inline-flex items-center gap-1 border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
        <CircleSlash aria-hidden="true" className="h-3 w-3" /> Not applicable
      </span>
    );
  }
  if (task.isHalfRevoked) {
    return (
      <span className="inline-flex items-center gap-1 border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
        <Smartphone aria-hidden="true" className="h-3 w-3" /> Still reachable
      </span>
    );
  }
  if (task.status === "in_progress") {
    return (
      <span className="inline-flex items-center gap-1 border border-orange-300 bg-orange-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-orange-800">
        <KeyRound aria-hidden="true" className="h-3 w-3" /> In progress
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
      <MailX aria-hidden="true" className="h-3 w-3" /> Not started
    </span>
  );
}

function OverdueFlag({ task }: { task: MailboxOffboardingTask }) {
  if (!task.isOverdue) return null;
  return (
    <span className="inline-flex items-center gap-1 border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
      <TriangleAlert aria-hidden="true" className="h-3 w-3" />
      {task.daysOverdue} days since last day
    </span>
  );
}

type DraftKind = "disposition" | "not_applicable" | "reopen";

type Draft = {
  taskId: string;
  kind: DraftKind;
  disposition: MailboxDisposition;
  forwardingTo: string;
  forwardingExpiresOn: string;
  reason: string;
};

function StepPanel({
  task,
  readOnly,
  busy,
  draft,
  controlPanelUrl,
  onRecord,
  onOpenDraft,
  onDraftChange,
  onCancelDraft,
  onSubmitDraft,
}: {
  task: MailboxOffboardingTask;
  readOnly: boolean;
  busy: boolean;
  draft: Draft | null;
  controlPanelUrl: string;
  onRecord: (task: MailboxOffboardingTask, step: "password_reset" | "app_passwords_cleared") => void;
  onOpenDraft: (task: MailboxOffboardingTask, kind: DraftKind) => void;
  onDraftChange: (patch: Partial<Draft>) => void;
  onCancelDraft: () => void;
  onSubmitDraft: () => void;
}) {
  const isDrafting = draft?.taskId === task.id;
  const done = task.status === "revoked" || task.status === "not_applicable";

  return (
    <div className="border-t border-slate-200 bg-slate-50 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
          Do these in the Turbify control panel, then record them here
        </p>
        <a
          className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-white px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
          href={controlPanelUrl}
          rel="noreferrer noopener"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" className="h-3 w-3" /> Open control panel
        </a>
      </div>

      <ol className="mt-3 space-y-2">
        <li className="border border-slate-200 bg-white px-3 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-black text-slate-900">1 · Reset the mailbox password</p>
              <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-600">
                Closes webmail. On its own it closes nothing else.
              </p>
              {task.passwordResetAt ? (
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                  Recorded by {task.passwordResetByName ?? task.passwordResetBy}
                </p>
              ) : null}
            </div>
            {task.passwordResetAt ? (
              <span className="shrink-0 whitespace-nowrap border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800">
                Done
              </span>
            ) : readOnly || done ? null : (
              <button
                className="shrink-0 whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                disabled={busy}
                onClick={() => onRecord(task, "password_reset")}
                type="button"
              >
                Record
              </button>
            )}
          </div>
        </li>

        <li
          className={`border px-3 py-3 ${
            task.isHalfRevoked ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-black text-slate-900">
                2 · Delete the app passwords
              </p>
              <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-600">
                This is the step that cuts the phone and Outlook. App passwords survive the reset
                above and have to be deleted from inside the mailbox.
              </p>
              {task.appPasswordsClearedAt ? (
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                  Recorded by {task.appPasswordsClearedByName ?? task.appPasswordsClearedBy}
                </p>
              ) : null}
            </div>
            {task.appPasswordsClearedAt ? (
              <span className="shrink-0 whitespace-nowrap border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800">
                Done
              </span>
            ) : readOnly || done ? null : (
              <button
                className="shrink-0 whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                disabled={busy}
                onClick={() => onRecord(task, "app_passwords_cleared")}
                type="button"
              >
                Record
              </button>
            )}
          </div>
        </li>

        <li className="border border-slate-200 bg-white px-3 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-black text-slate-900">3 · What happened to the mailbox</p>
              <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-600">
                Deleting or suspending it closes the door outright and makes steps 1 and 2
                unnecessary. Forwarding and retaining do not — the mailbox is still alive.
              </p>
              {task.disposition ? (
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                  {DISPOSITION_LABEL[task.disposition]}
                  {task.forwardingTo ? ` to ${task.forwardingTo}` : ""}
                  {task.forwardingExpiresOn ? ` until ${formatDate(task.forwardingExpiresOn)}` : ""}
                  {" · "}
                  {task.dispositionByName ?? task.dispositionBy}
                </p>
              ) : null}
            </div>
            {/* NOT `done`, unlike steps 1 and 2. Recording those two is what makes a row
                revoked, so gating this on `done` made step 3 unreachable in the order this card
                numbers it — 57 of 60 closed mailboxes ended up with no record of what became of
                them. `canRecordDisposition` mirrors the database guard exactly. */}
            {readOnly || !task.canRecordDisposition ? null : (
              <button
                className="shrink-0 whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                disabled={busy}
                onClick={() => onOpenDraft(task, "disposition")}
                type="button"
              >
                Record
              </button>
            )}
          </div>
        </li>
      </ol>

      {isDrafting && draft ? (
        <div className="mt-3 border border-slate-300 bg-white px-3 py-3">
          {draft.kind === "disposition" ? (
            <div className="space-y-2">
              <label className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                What happened to it
                <select
                  className={`${phxSelectClassName} mt-1 block`}
                  onChange={(event) =>
                    onDraftChange({ disposition: event.target.value as MailboxDisposition })
                  }
                  value={draft.disposition}
                >
                  {(Object.keys(DISPOSITION_LABEL) as MailboxDisposition[]).map((key) => (
                    <option key={key} value={key}>
                      {DISPOSITION_LABEL[key]}
                    </option>
                  ))}
                </select>
              </label>
              {draft.disposition === "forwarding" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                    Forwarding to
                    <input
                      className={`${phxFieldClassName} mt-1 block`}
                      onChange={(event) => onDraftChange({ forwardingTo: event.target.value })}
                      placeholder="manager@satopharma.com"
                      type="email"
                      value={draft.forwardingTo}
                    />
                  </label>
                  <label className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                    Remove forwarding on
                    <input
                      className={`${phxFieldClassName} mt-1 block`}
                      onChange={(event) => onDraftChange({ forwardingExpiresOn: event.target.value })}
                      type="date"
                      value={draft.forwardingExpiresOn}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : (
            <label className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
              {draft.kind === "reopen" ? "Why this is being reopened" : "Why there is nothing to revoke"}
              <textarea
                className={`${phxTextareaClassName} mt-1 block`}
                onChange={(event) => onDraftChange({ reason: event.target.value })}
                rows={2}
                value={draft.reason}
              />
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="whitespace-nowrap border border-slate-900 bg-slate-900 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
              disabled={busy}
              onClick={onSubmitDraft}
              type="button"
            >
              Save
            </button>
            <button
              className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
              onClick={onCancelDraft}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {readOnly ? null : (
        <div className="mt-3 flex flex-wrap gap-2">
          {done ? (
            <button
              className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={busy}
              onClick={() => onOpenDraft(task, "reopen")}
              type="button"
            >
              Reopen — this was recorded wrongly
            </button>
          ) : (
            <button
              className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={busy}
              onClick={() => onOpenDraft(task, "not_applicable")}
              type="button"
            >
              There is no mailbox to revoke
            </button>
          )}
        </div>
      )}

      {task.reason ? (
        <p className="mt-2 text-[11px] font-semibold leading-relaxed text-slate-600">{task.reason}</p>
      ) : null}
    </div>
  );
}

/**
 * The draft every in-row editor opens. One shape, built in one place, because three separate call
 * sites each spelling out six fields is how one of them quietly ends up missing `forwardingTo`.
 */
function makeDraft(task: MailboxOffboardingTask, kind: DraftKind): Draft {
  return {
    taskId: task.id,
    kind,
    disposition: task.disposition ?? "deleted",
    forwardingTo: task.forwardingTo ?? "",
    forwardingExpiresOn: task.forwardingExpiresOn ?? "",
    reason: "",
  };
}

/**
 * One labelled line inside the merged steps column. The label lives here, not in a column heading,
 * because the three steps share a single column now — which is what buys step 3's `<select>` the
 * width it needs at 1024px. `flex-wrap` is the whole fitting strategy: label and control sit on one
 * line while there is room, and the control drops to its own line when there is not.
 */
function StepRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
      {children}
    </div>
  );
}

/** Steps 1 and 2: one click, recorded in place. Nothing to fill in, so nothing to open. */
function StepCell({
  busy,
  danger,
  doneAt,
  doneBy,
  label,
  locked,
  onRecord,
}: {
  busy: boolean;
  danger?: boolean;
  doneAt: string | null;
  doneBy: string | null;
  label: string;
  locked: boolean;
  onRecord: () => void;
}) {
  if (doneAt) {
    return (
      <span
        className="inline-block whitespace-nowrap border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800"
        title={doneBy ? `Recorded by ${doneBy}` : undefined}
      >
        Done
      </span>
    );
  }
  if (locked) {
    return <span className="text-[12px] font-semibold text-slate-300">—</span>;
  }
  return (
    <button
      className={`whitespace-nowrap border px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] disabled:opacity-50 ${
        danger
          ? "border-rose-400 bg-rose-50 text-rose-800 hover:bg-rose-100"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
      }`}
      disabled={busy}
      onClick={onRecord}
      type="button"
    >
      {label}
    </button>
  );
}

/** Step 3: needs a value, so the picker opens inside the cell rather than anywhere else. */
function DispositionCell({
  busy,
  draft,
  locked,
  onCancel,
  onChange,
  onOpen,
  onSubmit,
  task,
}: {
  busy: boolean;
  draft: Draft | null;
  locked: boolean;
  onCancel: () => void;
  onChange: (patch: Partial<Draft>) => void;
  onOpen: () => void;
  onSubmit: () => void;
  task: MailboxOffboardingTask;
}) {
  const editing = draft !== null && draft.taskId === task.id && draft.kind === "disposition";

  if (editing && draft) {
    return (
      <div className="w-full min-w-0 space-y-1">
        <select
          className={`${phxSelectClassName} block`}
          onChange={(event) => onChange({ disposition: event.target.value as MailboxDisposition })}
          value={draft.disposition}
        >
          {(Object.keys(DISPOSITION_LABEL) as MailboxDisposition[]).map((key) => (
            <option key={key} value={key}>
              {DISPOSITION_LABEL[key]}
            </option>
          ))}
        </select>
        {draft.disposition === "forwarding" ? (
          <div className="space-y-1">
            <input
              className={`${phxFieldClassName} block`}
              onChange={(event) => onChange({ forwardingTo: event.target.value })}
              placeholder="manager@satopharma.com"
              type="email"
              value={draft.forwardingTo}
            />
            <input
              className={`${phxFieldClassName} block`}
              onChange={(event) => onChange({ forwardingExpiresOn: event.target.value })}
              type="date"
              value={draft.forwardingExpiresOn}
            />
          </div>
        ) : null}
        <div className="flex gap-1">
          <button
            className="whitespace-nowrap border border-slate-900 bg-slate-900 px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={busy}
            onClick={onSubmit}
            type="button"
          >
            Save
          </button>
          <button
            className="whitespace-nowrap border border-slate-300 bg-white px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (task.disposition) {
    return (
      <span
        className="break-words text-[12px] font-semibold text-slate-700"
        title={task.dispositionByName ?? task.dispositionBy ?? undefined}
      >
        {DISPOSITION_LABEL[task.disposition]}
        {task.forwardingTo ? ` → ${task.forwardingTo}` : ""}
      </span>
    );
  }

  if (locked) return <span className="text-[12px] font-semibold text-slate-300">—</span>;

  return (
    <button
      className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      disabled={busy}
      onClick={onOpen}
      type="button"
    >
      Set
    </button>
  );
}

/**
 * Reopen, and "there is no mailbox to revoke". Both need a written reason — a reopen is the only
 * correction path a revoked row has, so the reason is the whole audit value — and both are rare,
 * which is why they sit at the end of the row rather than competing with the three steps.
 */
function ReasonCell({
  busy,
  draft,
  onCancel,
  onChange,
  onOpen,
  onSubmit,
  readOnly,
  settled,
  task,
}: {
  busy: boolean;
  draft: Draft | null;
  onCancel: () => void;
  onChange: (patch: Partial<Draft>) => void;
  onOpen: (kind: DraftKind) => void;
  onSubmit: () => void;
  readOnly: boolean;
  settled: boolean;
  task: MailboxOffboardingTask;
}) {
  const editing =
    draft !== null &&
    draft.taskId === task.id &&
    (draft.kind === "reopen" || draft.kind === "not_applicable");

  if (readOnly) return null;

  if (editing && draft) {
    return (
      <div className="w-full min-w-0 space-y-1 text-left">
        <textarea
          className={`${phxTextareaClassName} block`}
          onChange={(event) => onChange({ reason: event.target.value })}
          placeholder={
            draft.kind === "reopen" ? "Why this is being reopened" : "Why there is nothing to revoke"
          }
          rows={2}
          value={draft.reason}
        />
        <div className="flex gap-1">
          <button
            className="whitespace-nowrap border border-slate-900 bg-slate-900 px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={busy}
            onClick={onSubmit}
            type="button"
          >
            Save
          </button>
          <button
            className="whitespace-nowrap border border-slate-300 bg-white px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      disabled={busy}
      onClick={() => onOpen(settled ? "reopen" : "not_applicable")}
      type="button"
    >
      {settled ? "Reopen" : "No mailbox"}
    </button>
  );
}

/**
 * The bulk bar. Appears only once something is selected, and names the count in every label so the
 * admin can never press "record" without seeing how many people it lands on.
 *
 * It offers the three steps that are genuinely done in one pass through the Turbify control panel
 * and nothing else. Reopen and "no mailbox" are absent by design — both demand a written reason,
 * and one reason spread across a selection is not a reason.
 */
function BulkBar({
  busy,
  count,
  disposition,
  onClear,
  onDispositionChange,
  onRun,
  onStepChange,
  step,
}: {
  busy: boolean;
  count: number;
  disposition: MailboxDisposition;
  onClear: () => void;
  onDispositionChange: (value: MailboxDisposition) => void;
  onRun: (step: MailboxBulkStep) => void;
  onStepChange: (step: MailboxBulkStep | null) => void;
  step: MailboxBulkStep | null;
}) {
  if (count === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border border-slate-900 bg-slate-900 px-3 py-2">
      <span className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.12em] text-white">
        {count} selected
      </span>

      <button
        className="whitespace-nowrap border border-white/30 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-white/20 disabled:opacity-50"
        disabled={busy}
        onClick={() => onRun("password_reset")}
        type="button"
      >
        1 · Password reset
      </button>

      <button
        className="whitespace-nowrap border border-white/30 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-white/20 disabled:opacity-50"
        disabled={busy}
        onClick={() => onRun("app_passwords_cleared")}
        type="button"
      >
        2 · App passwords cleared
      </button>

      {step === "disposition" ? (
        <span className="flex flex-wrap items-center gap-1">
          <select
            className={phxSelectClassName}
            onChange={(event) => onDispositionChange(event.target.value as MailboxDisposition)}
            value={disposition}
          >
            {(Object.keys(DISPOSITION_LABEL) as MailboxDisposition[]).map((key) => (
              <option key={key} value={key}>
                {DISPOSITION_LABEL[key]}
              </option>
            ))}
          </select>
          <button
            className="whitespace-nowrap border border-white bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-900 hover:bg-slate-100 disabled:opacity-50"
            disabled={busy || disposition === "forwarding"}
            onClick={() => onRun("disposition")}
            title={
              disposition === "forwarding"
                ? "Forwarding needs an address per person — record it in the row."
                : undefined
            }
            type="button"
          >
            Apply to {count}
          </button>
          <button
            className="whitespace-nowrap border border-white/30 px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-white/10"
            onClick={() => onStepChange(null)}
            type="button"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          className="whitespace-nowrap border border-white/30 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-white/20 disabled:opacity-50"
          disabled={busy}
          onClick={() => onStepChange("disposition")}
          type="button"
        >
          3 · Mailbox…
        </button>
      )}

      <button
        className="ml-auto whitespace-nowrap border border-white/30 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-white/10"
        onClick={onClear}
        type="button"
      >
        Clear
      </button>
    </div>
  );
}

/**
 * What the last bulk recording did, per person.
 *
 * `skipped` is shown as loudly as `recorded`. Selecting forty people and having twelve already
 * carry the step is the ordinary case, and a summary reading "40 recorded" would be claiming
 * twelve writes that never happened — the exact false confidence this register exists to prevent.
 */
function BulkReport({ outcomes, onDismiss }: { outcomes: MailboxBulkOutcome[]; onDismiss: () => void }) {
  if (outcomes.length === 0) return null;

  const recorded = outcomes.filter((outcome) => outcome.result === "recorded");
  const skipped = outcomes.filter((outcome) => outcome.result === "skipped");
  const failed = outcomes.filter((outcome) => outcome.result === "failed");

  return (
    <div
      className={`mt-3 border px-3 py-2 ${
        failed.length > 0 ? "border-rose-300 bg-rose-50" : "border-emerald-300 bg-emerald-50"
      }`}
    >
      <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-700">
        {recorded.length} recorded
        {skipped.length > 0 ? ` · ${skipped.length} already done` : ""}
        {failed.length > 0 ? ` · ${failed.length} failed` : ""}
        <button
          className="ml-3 border border-slate-300 bg-white px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.1em] text-slate-600 hover:bg-slate-100"
          onClick={onDismiss}
          type="button"
        >
          Dismiss
        </button>
      </p>
      {failed.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {failed.map((outcome) => (
            <li className="text-[11px] font-semibold text-rose-800" key={outcome.taskId}>
              {outcome.employeeName} — {outcome.error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MailboxOffboardingWorkspace({
  initialData,
  initialError,
  canRecord,
  canOpen,
  canReadEditForm = false,
}: {
  initialData: MailboxOffboardingDashboardData | null;
  initialError: string | null;
  canRecord: boolean;
  canOpen: boolean;
  /**
   * The System Administrator alone (`canReadInitialPassword`) — the Edit-form capture signs in to
   * the Turbify console as its administrator. UX only: the route asserts the same gate again.
   */
  canReadEditForm?: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [filter, setFilter] = useState<StatusFilter>("action");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The selection, and the report of what the last bulk recording actually did.
   *
   * Held as ids rather than tasks: `data` is replaced wholesale by every mutation, so holding rows
   * would pin stale copies of people whose status has since moved.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkStep, setBulkStep] = useState<MailboxBulkStep | null>(null);
  const [bulkDisposition, setBulkDisposition] = useState<MailboxDisposition>("deleted");
  const [bulkReport, setBulkReport] = useState<MailboxBulkOutcome[] | null>(null);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mailbox-offboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as MailboxOffboardingDashboardData & {
        message?: string;
        outcomes?: MailboxBulkOutcome[];
      };
      if (!response.ok) {
        // The database's own refusal, verbatim. It is the only thing that knows why.
        setError(payload.message ?? "That mailbox action could not be completed.");
        return null;
      }
      setData(payload);
      return payload;
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Network request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const recordStep = useCallback(
    (task: MailboxOffboardingTask, step: "password_reset" | "app_passwords_cleared") => {
      void post({ action: "record", taskId: task.id, step });
    },
    [post],
  );

  const submitDraft = useCallback(() => {
    if (!draft) return;

    if (draft.kind === "disposition") {
      if (draft.disposition === "forwarding" && draft.forwardingTo.trim() === "") {
        setError("Forwarding needs a destination address.");
        return;
      }
      void post({
        action: "record",
        taskId: draft.taskId,
        step: "disposition",
        disposition: draft.disposition,
        forwardingTo: draft.forwardingTo.trim() || null,
        forwardingExpiresOn: draft.forwardingExpiresOn || null,
      }).then((ok) => {
        if (ok) setDraft(null);
      });
      return;
    }

    const reason = draft.reason.trim();
    if (reason === "") {
      setError(
        draft.kind === "reopen"
          ? "Reopening a record needs a written reason."
          : "Marking a mailbox not applicable needs a written reason.",
      );
      return;
    }
    void post({ action: "record", taskId: draft.taskId, step: draft.kind, reason }).then((ok) => {
      if (ok) setDraft(null);
    });
  }, [draft, post]);

  const stats = data?.stats ?? null;

  const visible = useMemo(() => {
    const tasks = data?.tasks ?? [];
    if (filter === "all") return tasks;
    if (filter === "half") return tasks.filter((task) => task.isHalfRevoked);
    if (filter === "revoked") return tasks.filter((task) => task.status === "revoked");
    if (filter === "progress") return tasks.filter((task) => task.status === "in_progress");
    // "Needs action": everything still open, worst first — half-revoked above merely overdue,
    // because a half-revoked mailbox is the one nobody would otherwise know to look at.
    return tasks
      .filter((task) => task.status === "pending" || task.status === "in_progress")
      .sort((left, right) => {
        if (left.isHalfRevoked !== right.isHalfRevoked) return left.isHalfRevoked ? -1 : 1;
        return right.daysOverdue - left.daysOverdue;
      });
  }, [data, filter]);

  /**
   * Which visible rows a bulk action may touch, and therefore what "select all" means.
   *
   * DERIVED, never stored. Storing it would need a `setState` inside an effect to keep it in step
   * with the filter — a lint error in this repo, and the wrong shape anyway: a selection that
   * outlives the filter which produced it is how someone records a step against a person they can
   * no longer see. Filtering the register narrows the selection to match, on the same render.
   */
  const selectableIds = useMemo(
    () =>
      canRecord
        ? visible
            .filter((task) => task.status !== "revoked" && task.status !== "not_applicable")
            .map((task) => task.id)
        : [],
    [canRecord, visible],
  );

  const selectedIds = useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );

  const allSelected = selectableIds.length > 0 && selectedIds.length === selectableIds.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  const toggleRow = useCallback((taskId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  /** Select-all covers the rows on screen, never the whole register hidden behind a filter. */
  const toggleAll = useCallback(() => {
    setSelected((current) => {
      const everyOneOnScreenIsSelected = selectableIds.length > 0 && selectableIds.every((id) => current.has(id));
      if (everyOneOnScreenIsSelected) return new Set();
      return new Set(selectableIds);
    });
  }, [selectableIds]);

  /**
   * Records one step against everything selected, in a single request.
   *
   * The response carries a per-row report and this keeps it: "38 recorded" alone would hide the
   * six that were already done and the one that failed, and the whole reason to record centrally
   * is to know which people are actually covered.
   */
  const runBulk = useCallback(
    async (step: MailboxBulkStep, disposition?: MailboxDisposition) => {
      if (selectedIds.length === 0) return;
      setBulkReport(null);
      const payload = await post({
        action: "record_bulk",
        taskIds: selectedIds,
        step,
        disposition: step === "disposition" ? (disposition ?? bulkDisposition) : null,
      });
      if (!payload) return;
      setBulkReport(payload.outcomes ?? []);
      setBulkStep(null);
      setSelected(new Set());
    },
    [bulkDisposition, post, selectedIds],
  );

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker="Resignation & Offboarding"
        subtitle="Every leaver who still holds a company mailbox, and what has actually been done about it. Phoenix cannot close a Turbify mailbox — it records who closed it, and refuses to call a mailbox shut until it is."
        title="Mailbox revocation"
      />

      {error ? (
        <div className="mt-5 flex items-start gap-3 border border-rose-200 bg-rose-50 px-4 py-3" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-rose-900">{error}</p>
        </div>
      ) : null}

      {stats ? (
        <div className="mt-5 grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-6">
          <MetricTile
            label="Not started"
            sub="nothing recorded"
            tone={stats.pending > 0 ? "amber" : "emerald"}
            value={stats.pending.toLocaleString("en-US")}
          />
          <MetricTile
            label="App passwords live"
            sub="leavers, not cleared"
            tone={stats.appPasswordsMayBeLive > 0 ? "rose" : "emerald"}
            value={stats.appPasswordsMayBeLive.toLocaleString("en-US")}
          />
          <MetricTile
            label="Still reachable"
            sub="reset, not cleared"
            tone={stats.halfRevoked > 0 ? "rose" : "emerald"}
            value={stats.halfRevoked.toLocaleString("en-US")}
          />
          <MetricTile
            label="Past last day"
            sub="still not revoked"
            tone={stats.overdue > 0 ? "rose" : "emerald"}
            value={stats.overdue.toLocaleString("en-US")}
          />
          <MetricTile
            label="Forwarding lapsed"
            sub="expiry has passed"
            tone={stats.forwardingExpired > 0 ? "amber" : "emerald"}
            value={stats.forwardingExpired.toLocaleString("en-US")}
          />
          <MetricTile
            label="Revoked"
            sub="door confirmed shut"
            tone="emerald"
            value={stats.revoked.toLocaleString("en-US")}
          />
        </div>
      ) : null}

      <div className="mt-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
        <Smartphone aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
          Resetting the password is not enough. Turbify runs on Yahoo, and Yahoo app passwords stay
          valid after a password change — so a leaver whose phone or Outlook was ever set up keeps
          receiving and sending company mail until those app passwords are deleted. This register
          will not call a mailbox revoked on a reset alone.
        </p>
      </div>

      {data && data.appPasswordReport.length > 0 ? (
        <div className="mt-5 border border-rose-200 bg-white px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-rose-700">
            App-password report — {data.appPasswordReport.length} leaver
            {data.appPasswordReport.length === 1 ? "" : "s"} whose phone or Outlook may still be connected
          </p>
          <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-600">
            Only clearing the app passwords, or deleting the mailbox, ends them. A password reset does not.
          </p>
          <ul className="mt-2 space-y-1">
            {data.appPasswordReport.map((row) => (
              <li
                key={row.employeeHrId}
                className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 px-3 py-2"
              >
                <span className="min-w-0 break-words text-[12px] font-bold text-slate-900">
                  {row.employeeName} — {row.workEmail}
                </span>
                <span className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">
                  {row.lastWorkingDate ? `Left ${formatDate(row.lastWorkingDate)}` : "Last day unknown"} ·{" "}
                  {!row.hasRecord ? "no record" : row.passwordReset ? "reset, not cleared" : "nothing done"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canReadEditForm && data ? (
        <MailboxEditFormProbeCard
          leavers={data.tasks
            .filter((task) => task.status !== "not_applicable")
            .map((task) => ({
              address: task.workEmail,
              lastDay: task.lastWorkingDate ? `left ${formatDate(task.lastWorkingDate)}` : "last day unknown",
              name: task.employeeName,
              taskId: task.id,
            }))
            .sort((left, right) => left.name.localeCompare(right.name))}
        />
      ) : null}

      {data && data.awaiting.length > 0 ? (
        <div className="mt-5 border border-slate-300 bg-white px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
            {data.awaiting.length} leaver{data.awaiting.length === 1 ? "" : "s"} with a mailbox and no
            record
          </p>
          <ul className="mt-2 space-y-1">
            {data.awaiting.map((leaver) => (
              <li
                key={leaver.employeeHrId}
                className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 px-3 py-2"
              >
                <span className="min-w-0 break-words text-[12px] font-bold text-slate-900">
                  {leaver.employeeName} — {leaver.workEmail}
                </span>
                {canOpen ? (
                  <button
                    className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      void post({ action: "open", employeeHrId: leaver.employeeHrId })
                    }
                    type="button"
                  >
                    Open a record
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-px bg-slate-200">
        {STATUS_FILTERS.map((option) => (
          <button
            className={`whitespace-nowrap border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] ${
              filter === option.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            key={option.key}
            onClick={() => setFilter(option.key)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>

      {busy ? (
        <p className="mt-3 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500">
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> Saving
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-5 border border-slate-200 bg-white px-4 py-6 text-center text-[12px] font-bold text-slate-500">
          Nothing here.
        </p>
      ) : null}

      {/* The bulk bar and its report — desktop only, because only the table carries checkboxes.
          A card is already one person, so selecting several of them buys nothing. */}
      <div className="hidden md:block">
        <BulkBar
          busy={busy}
          count={selectedIds.length}
          disposition={bulkDisposition}
          onClear={() => setSelected(new Set())}
          onDispositionChange={setBulkDisposition}
          onRun={(step) => void runBulk(step)}
          onStepChange={setBulkStep}
          step={bulkStep}
        />
        {bulkReport ? <BulkReport onDismiss={() => setBulkReport(null)} outcomes={bulkReport} /> : null}
      </div>

      {/* DESKTOP — the table. Every step is recorded from INSIDE the row.
          This used to be an expander whose panel rendered underneath the whole table, which meant
          scrolling down, acting, and scrolling back for each of ~50 people. The work here is one
          pass down a backlog, so the row is the unit of work and nothing may leave it. */}
      <div className="mt-5 hidden md:block">
        <table className="w-full table-fixed border-collapse">
          {/* Four columns, fixed. Measured against the REAL shell chain, not the raw viewport:
              669px of content at a 1024px window (the tightest, because the 292px sidebar arrives
              at `lg`), 721px at 768px, 909px at 1280px. Table width equals wrapper width at all
              three, with no cell ink crossing its own cell. Adding a fifth column is what breaks
              this — merge into an existing one instead, as the four originals were merged. */}
          <colgroup>
            <col className="w-[6%]" />
            <col className="w-[32%]" />
            <col className="w-[36%]" />
            <col className="w-[26%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              <th className="px-2 py-2 text-left" scope="col">
                {selectableIds.length > 0 ? (
                  <input
                    aria-label={allSelected ? "Clear the selection" : "Select every row on screen"}
                    checked={allSelected}
                    className="h-3.5 w-3.5 accent-slate-900"
                    onChange={toggleAll}
                    ref={(element) => {
                      // A partial selection is neither on nor off. Set imperatively — React has
                      // no attribute for `indeterminate`, only the DOM property.
                      if (element) element.indeterminate = someSelected;
                    }}
                    type="checkbox"
                  />
                ) : null}
              </th>
              {["Person & mailbox", "Steps", "State"].map((heading) => (
                <th
                  className="px-3 py-2 text-left text-[9px] font-black uppercase tracking-[0.14em] text-slate-500"
                  key={heading}
                  scope="col"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((task) => {
              const settled = task.status === "revoked" || task.status === "not_applicable";
              const locked = !canRecord || settled;
              return (
                <tr className="border-b border-slate-200 align-top" key={task.id}>
                  <td className="px-2 py-3">
                    {/* No checkbox on a settled row: there is nothing left to record on it. */}
                    {locked ? null : (
                      <input
                        aria-label={`Select ${task.employeeName}`}
                        checked={selected.has(task.id)}
                        className="h-3.5 w-3.5 accent-slate-900"
                        onChange={() => toggleRow(task.id)}
                        type="checkbox"
                      />
                    )}
                  </td>

                  {/* WHO. Four columns folded into one — name, job title, mailbox, last day — in
                      the order the mobile card below already presents them. The mailbox is the
                      longest value on this screen and still reads in full: it wraps, it is never
                      cut. */}
                  <td className="px-3 py-3">
                    <p className="break-words text-[12px] font-black leading-snug text-slate-900">
                      {task.employeeName}
                    </p>
                    {task.jobTitle ? (
                      <p className="mt-0.5 break-words text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                        {task.jobTitle}
                      </p>
                    ) : null}
                    <p className="mt-1 break-words text-[12px] font-semibold text-slate-700">
                      {task.workEmail}
                    </p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                      Last day{" "}
                      <span className="tabular-nums text-slate-500">
                        {formatDate(task.lastWorkingDate)}
                      </span>
                    </p>
                  </td>

                  {/* THE THREE STEPS, still recorded from inside the row — one column instead of
                      three, each step named on its own line. */}
                  <td className="px-3 py-3">
                    <div className="space-y-1">
                      <StepRow label="1 · Password">
                        <StepCell
                          busy={busy}
                          doneAt={task.passwordResetAt}
                          doneBy={task.passwordResetByName ?? task.passwordResetBy}
                          label="Reset"
                          locked={locked}
                          onRecord={() => recordStep(task, "password_reset")}
                        />
                      </StepRow>
                      <StepRow label="2 · App passwords">
                        <StepCell
                          busy={busy}
                          /* Rose only when the password is already reset and this is not: that is
                             the half-revoked mailbox, the one that looks finished and is not. */
                          danger={task.isHalfRevoked}
                          doneAt={task.appPasswordsClearedAt}
                          doneBy={task.appPasswordsClearedByName ?? task.appPasswordsClearedBy}
                          label="Clear"
                          locked={locked}
                          onRecord={() => recordStep(task, "app_passwords_cleared")}
                        />
                      </StepRow>
                      <StepRow label="3 · Mailbox">
                        <DispositionCell
                          busy={busy}
                          draft={draft}
                          /* Its own lock, not the row's: a revoked row still accepts a disposition
                             when both revocation steps are recorded, because that cannot change the
                             status. Mirrors the guard in phx_mailbox_offboarding_record. */
                          locked={!canRecord || !task.canRecordDisposition}
                          onCancel={() => setDraft(null)}
                          onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
                          onOpen={() => setDraft(makeDraft(task, "disposition"))}
                          onSubmit={submitDraft}
                          task={task}
                        />
                      </StepRow>
                    </div>
                  </td>

                  {/* WHERE IT STANDS, and the two rare corrections under it. They had a column of
                      their own; both are about the row as a whole, so they belong together. */}
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-start gap-1">
                      <StatusChip task={task} />
                      <OverdueFlag task={task} />
                    </div>
                    {canRecord ? (
                      <div className="mt-2">
                        <ReasonCell
                          busy={busy}
                          draft={draft}
                          onCancel={() => setDraft(null)}
                          onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
                          onOpen={(kind) => setDraft(makeDraft(task, kind))}
                          onSubmit={submitDraft}
                          readOnly={!canRecord}
                          settled={settled}
                          task={task}
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data ? (
          <p className="mt-2 text-[11px] font-semibold text-slate-500">
            Do the work in Turbify, then record it here.{" "}
            <a
              className="font-black text-slate-700 underline"
              href={data.controlPanelUrl}
              rel="noreferrer noopener"
              target="_blank"
            >
              Open the control panel
            </a>
          </p>
        ) : null}
      </div>

      {/* MOBILE — cards, never the table. The owner's standing rule. */}
      <div className="mt-5 space-y-3 md:hidden">
        {visible.map((task) => (
          <div className="border border-slate-200 bg-white" key={task.id}>
            <div className="px-4 py-3">
              <p className="text-[13px] font-black text-slate-900">{task.employeeName}</p>
              <p className="mt-1 text-[12px] font-semibold text-slate-700">{task.workEmail}</p>
              <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-400">
                Last day {formatDate(task.lastWorkingDate)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <StatusChip task={task} />
                <OverdueFlag task={task} />
              </div>
              <button
                className="mt-3 w-full whitespace-nowrap border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700"
                onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                type="button"
              >
                {expandedId === task.id ? "Close" : "Steps"}
              </button>
            </div>
            {expandedId === task.id && data ? (
              <StepPanel
                busy={busy}
                controlPanelUrl={data.controlPanelUrl}
                draft={draft}
                onCancelDraft={() => setDraft(null)}
                onDraftChange={(patch) =>
                  setDraft((current) => (current ? { ...current, ...patch } : current))
                }
                onOpenDraft={(target, kind) =>
                  setDraft({
                    taskId: target.id,
                    kind,
                    disposition: target.disposition ?? "deleted",
                    forwardingTo: target.forwardingTo ?? "",
                    forwardingExpiresOn: target.forwardingExpiresOn ?? "",
                    reason: "",
                  })
                }
                onRecord={recordStep}
                onSubmitDraft={submitDraft}
                readOnly={!canRecord}
                task={task}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
