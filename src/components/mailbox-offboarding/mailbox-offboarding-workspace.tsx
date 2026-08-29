"use client";

/**
 * Mailbox offboarding workspace — the Turbify leaver register.
 *
 * DESIGN IDENTITY is the clearance workspace's, deliberately (AGENTS.md §4: match the sibling
 * pages, never invent a one-off look). Same `PremiumHero`, same centred metric tile with its 9px
 * uppercase micro-label and `text-3xl font-black tabular-nums` figure, same orange accent, same
 * square corners and slate borders, same desktop-table / mobile-card split.
 *
 * DESKTOP GETS THE TABLE, MOBILE NEVER DOES — the owner's standing rule.
 *
 * NOTHING TRUNCATES AND NOTHING WRAPS in the table. Email addresses are the longest thing here and
 * the most important to read in full, so they sit `whitespace-nowrap` inside a horizontally
 * scrolling container rather than behind an ellipsis.
 *
 * NO `window.prompt` OR `window.confirm`. Reasons are captured inline, against the row they are
 * about.
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

import { PremiumHero } from "@/components/ui/premium-hero";
import type {
  MailboxDisposition,
  MailboxOffboardingDashboardData,
  MailboxOffboardingTask,
} from "@/lib/mailbox-offboarding/types";

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

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", {
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
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800">
        <ShieldCheck aria-hidden="true" className="h-3 w-3" /> Revoked
      </span>
    );
  }
  if (task.status === "not_applicable") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
        <CircleSlash aria-hidden="true" className="h-3 w-3" /> Not applicable
      </span>
    );
  }
  if (task.isHalfRevoked) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
        <Smartphone aria-hidden="true" className="h-3 w-3" /> Still reachable
      </span>
    );
  }
  if (task.status === "in_progress") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-orange-300 bg-orange-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-orange-800">
        <KeyRound aria-hidden="true" className="h-3 w-3" /> In progress
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
      <MailX aria-hidden="true" className="h-3 w-3" /> Not started
    </span>
  );
}

function OverdueFlag({ task }: { task: MailboxOffboardingTask }) {
  if (!task.isOverdue) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
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
            {readOnly || done ? null : (
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
                  className="mt-1 block w-full border border-slate-300 px-2 py-1 text-[12px] font-semibold text-slate-900"
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
                      className="mt-1 block w-full border border-slate-300 px-2 py-1 text-[12px] font-semibold text-slate-900"
                      onChange={(event) => onDraftChange({ forwardingTo: event.target.value })}
                      placeholder="manager@satopharma.com"
                      type="email"
                      value={draft.forwardingTo}
                    />
                  </label>
                  <label className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                    Remove forwarding on
                    <input
                      className="mt-1 block w-full border border-slate-300 px-2 py-1 text-[12px] font-semibold text-slate-900"
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
                className="mt-1 block w-full border border-slate-300 px-2 py-1 text-[12px] font-semibold text-slate-900"
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

export function MailboxOffboardingWorkspace({
  initialData,
  initialError,
  canRecord,
  canOpen,
}: {
  initialData: MailboxOffboardingDashboardData | null;
  initialError: string | null;
  canRecord: boolean;
  canOpen: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [filter, setFilter] = useState<StatusFilter>("action");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mailbox-offboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as MailboxOffboardingDashboardData & { message?: string };
      if (!response.ok) {
        // The database's own refusal, verbatim. It is the only thing that knows why.
        setError(payload.message ?? "That mailbox action could not be completed.");
        return false;
      }
      setData(payload);
      return true;
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Network request failed.");
      return false;
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

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker="Clearance & Offboarding"
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
        <div className="mt-5 grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-5">
          <MetricTile
            label="Not started"
            sub="nothing recorded"
            tone={stats.pending > 0 ? "amber" : "emerald"}
            value={stats.pending.toLocaleString("en-US")}
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
                <span className="whitespace-nowrap text-[12px] font-bold text-slate-900">
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

      {/* DESKTOP — the table. Horizontally scrollable so nothing is ever cut off. */}
      <div className="mt-5 hidden overflow-x-auto md:block">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {["Person", "Mailbox", "Last day", "State", "", ""].map((heading, index) => (
                <th
                  className="whitespace-nowrap px-3 py-2 text-left text-[9px] font-black uppercase tracking-[0.14em] text-slate-500"
                  key={`${heading}-${index}`}
                  scope="col"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((task) => (
              <tr className="border-b border-slate-200 align-top" key={task.id}>
                <td className="whitespace-nowrap px-3 py-3 text-[12px] font-black text-slate-900">
                  {task.employeeName}
                  {task.jobTitle ? (
                    <span className="ml-2 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                      {task.jobTitle}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-[12px] font-semibold text-slate-700">
                  {task.workEmail}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-[12px] font-semibold tabular-nums text-slate-700">
                  {formatDate(task.lastWorkingDate)}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <StatusChip task={task} />
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <OverdueFlag task={task} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <button
                    className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
                    onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                    type="button"
                  >
                    {expandedId === task.id ? "Close" : "Steps"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The expanded panel sits outside the table on desktop too, so the table never reflows. */}
      {expandedId && data ? (
        <div className="mt-3 hidden md:block">
          {visible
            .filter((task) => task.id === expandedId)
            .map((task) => (
              <div className="border border-slate-300 bg-white" key={task.id}>
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
              </div>
            ))}
        </div>
      ) : null}

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
