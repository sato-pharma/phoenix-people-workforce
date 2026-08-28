"use client";

/**
 * Clearance & offboarding workspace — HR Operations job description §6.
 *
 * DESIGN IDENTITY is the HR command centre's, deliberately (AGENTS.md §4: match the sibling pages,
 * never invent a one-off look). Same `PremiumHero`, same centred metric tile with its 9px uppercase
 * micro-label and `text-3xl font-black tabular-nums` figure, same orange accent, same square
 * corners and slate borders.
 *
 * DESKTOP GETS THE TABLE, MOBILE NEVER DOES — the owner's standing rule. The `md:` split here is a
 * real one: a clearance list genuinely is tabular (person, last day, progress, outstanding), so the
 * desktop view is a table and the phone view is a stack of cards carrying the same fields.
 *
 * NOTHING TRUNCATES AND NOTHING WRAPS in the table — another standing rule. Long names get
 * `whitespace-nowrap` inside a horizontally scrolling container rather than an ellipsis, so the
 * full name is always readable by scrolling and never cut off.
 *
 * NO `window.prompt` OR `window.confirm` ANYWHERE. A reason is captured in an inline form that
 * belongs to the station it is about, and the release is a two-step inline confirmation. A native
 * dialog cannot be styled, cannot be read on a phone, and loses the context of what it is asking
 * about — it is the opposite of the polish this account was asked for.
 *
 * The release button is the point of the page. It stays disabled until the database would accept
 * it, and when a refusal does come back the exact sentence from `phx_hr_clearance_release` is
 * shown — it names the outstanding stations, which a boolean never could.
 */

import {
  CircleCheck,
  CircleSlash,
  Clock,
  HandCoins,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Fragment, useCallback, useMemo, useState } from "react";

import { PremiumHero } from "@/components/ui/premium-hero";
import type {
  ClearanceChecklist,
  ClearanceDashboardData,
  ClearanceItem,
  ClearanceItemStatus,
} from "@/lib/clearance/types";

type StatusFilter = "action" | "open" | "ready" | "released" | "all";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "action", label: "Needs action" },
  { key: "open", label: "In progress" },
  { key: "ready", label: "Ready to release" },
  { key: "released", label: "Released" },
  { key: "all", label: "All" },
];

const ITEM_STATUS_LABEL: Record<ClearanceItemStatus, string> = {
  pending: "Pending",
  cleared: "Cleared",
  blocked: "Blocked",
  waived: "Waived",
};

const ITEM_STATUS_CLASS: Record<ClearanceItemStatus, string> = {
  pending: "border-slate-300 bg-white text-slate-600",
  cleared: "border-emerald-300 bg-emerald-50 text-emerald-800",
  blocked: "border-rose-300 bg-rose-50 text-rose-800",
  waived: "border-amber-300 bg-amber-50 text-amber-800",
};

const REASON_PROMPT: Record<"blocked" | "waived", string> = {
  blocked: "Why is this station blocked? Recorded against the clearance.",
  waived: "Why is this station waived? A written reason is the only override there is.",
};

function formatEgp(value: number): string {
  return `EGP ${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | null): string {
  if (!value) return "Not set";
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString("en-GB", {
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

function ProgressBar({ cleared, total }: { cleared: number; total: number }) {
  const percent = total > 0 ? Math.round((cleared / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        aria-label={`${cleared} of ${total} stations decided`}
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={cleared}
        className="h-1.5 w-24 shrink-0 bg-slate-200"
        role="progressbar"
      >
        <div
          className={`h-full ${percent === 100 ? "bg-emerald-500" : "bg-orange-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-[11px] font-bold tabular-nums text-slate-600">
        {cleared}/{total}
      </span>
    </div>
  );
}

function StatusChip({ status }: { status: ClearanceChecklist["status"] }) {
  if (status === "released") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800">
        <ShieldCheck aria-hidden="true" className="h-3 w-3" /> Released
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
        <CircleSlash aria-hidden="true" className="h-3 w-3" /> Cancelled
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-orange-300 bg-orange-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-orange-800">
        <HandCoins aria-hidden="true" className="h-3 w-3" /> Ready to release
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
      <Clock aria-hidden="true" className="h-3 w-3" /> In progress
    </span>
  );
}

function OverdueFlag({ checklist }: { checklist: ClearanceChecklist }) {
  if (!checklist.isOverdue || checklist.daysSinceLastWorkingDate === null) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
      <TriangleAlert aria-hidden="true" className="h-3 w-3" />
      {checklist.daysSinceLastWorkingDate} days since last day
    </span>
  );
}

type ReasonDraft = { itemId: string; status: "blocked" | "waived"; reason: string; amount: string };

function StationRow({
  item,
  readOnly,
  busy,
  draft,
  onOpenDraft,
  onDraftChange,
  onCancelDraft,
  onSubmitDraft,
  onDecideDirect,
}: {
  item: ClearanceItem;
  readOnly: boolean;
  busy: boolean;
  draft: ReasonDraft | null;
  onOpenDraft: (item: ClearanceItem, status: "blocked" | "waived") => void;
  onDraftChange: (patch: Partial<ReasonDraft>) => void;
  onCancelDraft: () => void;
  onSubmitDraft: () => void;
  onDecideDirect: (item: ClearanceItem, status: ClearanceItemStatus) => void;
}) {
  const isDrafting = draft?.itemId === item.id;

  return (
    <li className="border border-slate-200 bg-white px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-black text-slate-900">{item.stationLabel}</p>
          {item.reason ? (
            <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-600">
              {item.reason}
            </p>
          ) : null}
          {item.amountDue !== null && item.amountDue > 0 ? (
            <p className="mt-1 text-[11px] font-black tabular-nums text-rose-700">
              {formatEgp(item.amountDue)} outstanding
            </p>
          ) : null}
          {item.decidedByName ?? item.decidedBy ? (
            <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
              {ITEM_STATUS_LABEL[item.status]} by {item.decidedByName ?? item.decidedBy}
            </p>
          ) : null}
        </div>
        <span
          className={`shrink-0 whitespace-nowrap border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${ITEM_STATUS_CLASS[item.status]}`}
        >
          {ITEM_STATUS_LABEL[item.status]}
        </span>
      </div>

      {readOnly ? null : isDrafting && draft ? (
        <div className="mt-3 border border-slate-300 bg-slate-50 px-3 py-3">
          <label
            className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
            htmlFor={`reason-${item.id}`}
          >
            {REASON_PROMPT[draft.status]}
          </label>
          <textarea
            className="mt-2 w-full border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            id={`reason-${item.id}`}
            onChange={(event) => onDraftChange({ reason: event.target.value })}
            rows={2}
            value={draft.reason}
          />

          {draft.status === "blocked" ? (
            <>
              <label
                className="mt-3 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                htmlFor={`amount-${item.id}`}
              >
                Amount owed, if any (EGP)
              </label>
              <input
                className="mt-2 w-full border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-semibold tabular-nums text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                id={`amount-${item.id}`}
                inputMode="decimal"
                min="0"
                onChange={(event) => onDraftChange({ amount: event.target.value })}
                step="0.01"
                type="number"
                value={draft.amount}
              />
            </>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="border border-slate-900 bg-slate-900 px-3 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy || draft.reason.trim() === ""}
              onClick={onSubmitDraft}
              type="button"
            >
              Save {ITEM_STATUS_LABEL[draft.status].toLowerCase()}
            </button>
            <button
              className="border border-slate-300 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={onCancelDraft}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {(["cleared", "blocked", "waived", "pending"] as ClearanceItemStatus[])
            .filter((status) => status !== item.status)
            .map((status) => (
              <button
                className="border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy}
                key={status}
                onClick={() =>
                  status === "blocked" || status === "waived"
                    ? onOpenDraft(item, status)
                    : onDecideDirect(item, status)
                }
                type="button"
              >
                {status === "pending" ? "Reopen" : ITEM_STATUS_LABEL[status]}
              </button>
            ))}
        </div>
      )}
    </li>
  );
}

function ChecklistDetail({
  checklist,
  busy,
  draft,
  releasing,
  canDecide,
  onOpenDraft,
  onDraftChange,
  onCancelDraft,
  onSubmitDraft,
  onDecideDirect,
  onAskRelease,
  onCancelRelease,
  onConfirmRelease,
}: {
  checklist: ClearanceChecklist;
  busy: boolean;
  draft: ReasonDraft | null;
  releasing: boolean;
  canDecide: boolean;
  onOpenDraft: (item: ClearanceItem, status: "blocked" | "waived") => void;
  onDraftChange: (patch: Partial<ReasonDraft>) => void;
  onCancelDraft: () => void;
  onSubmitDraft: () => void;
  onDecideDirect: (item: ClearanceItem, status: ClearanceItemStatus) => void;
  onAskRelease: (checklist: ClearanceChecklist) => void;
  onCancelRelease: () => void;
  onConfirmRelease: (checklist: ClearanceChecklist) => void;
}) {
  const frozen = checklist.status === "released" || checklist.status === "cancelled";
  const readOnly = frozen || !canDecide;

  return (
    <div className="border border-slate-200 bg-slate-50 px-4 py-4">
      <ul className="grid gap-2 sm:grid-cols-2">
        {checklist.items.map((item) => (
          <StationRow
            busy={busy}
            draft={draft}
            item={item}
            key={item.id}
            onCancelDraft={onCancelDraft}
            onDecideDirect={onDecideDirect}
            onDraftChange={onDraftChange}
            onOpenDraft={onOpenDraft}
            onSubmitDraft={onSubmitDraft}
            readOnly={readOnly}
          />
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <div className="min-w-0">
          {checklist.status === "released" ? (
            <p className="text-[11px] font-semibold leading-relaxed text-emerald-800">
              Final settlement recorded as released
              {checklist.settlementReleasedByName ? ` by ${checklist.settlementReleasedByName}` : ""}
              {checklist.settlementReleasedAt
                ? ` on ${formatDate(checklist.settlementReleasedAt.slice(0, 10))}`
                : ""}
              .
            </p>
          ) : checklist.outstandingLabels.length > 0 ? (
            <p className="text-[11px] font-semibold leading-relaxed text-slate-600">
              Still outstanding:{" "}
              <span className="font-black text-slate-900">
                {checklist.outstandingLabels.join(", ")}
              </span>
            </p>
          ) : (
            <p className="text-[11px] font-semibold leading-relaxed text-emerald-800">
              Every station is decided. The final settlement can be released.
            </p>
          )}
        </div>

        {readOnly ? null : releasing ? null : (
          <button
            className="inline-flex shrink-0 items-center gap-2 border border-orange-500 bg-orange-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-white transition-colors hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
            disabled={busy || checklist.status !== "ready"}
            onClick={() => onAskRelease(checklist)}
            type="button"
          >
            <HandCoins aria-hidden="true" className="h-3.5 w-3.5" />
            Record settlement release
          </button>
        )}
      </div>

      {releasing && !readOnly ? (
        <div className="mt-3 border border-orange-300 bg-orange-50 px-4 py-3">
          <p className="text-[12px] font-black text-orange-900">
            Record that the final settlement for {checklist.employeeName} was released?
          </p>
          <p className="mt-1 text-[11px] font-semibold leading-relaxed text-orange-900">
            This records that HR handed the settlement over. It does not pay anyone and does not
            touch payroll.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 border border-orange-600 bg-orange-600 px-3 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-white transition-colors hover:bg-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => onConfirmRelease(checklist)}
              type="button"
            >
              {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
              Yes, record the release
            </button>
            <button
              className="border border-slate-300 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={onCancelRelease}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ClearanceWorkspace({
  initialData,
  initialError,
  canDecide,
  canOpen,
}: {
  initialData: ClearanceDashboardData | null;
  initialError: string | null;
  canDecide: boolean;
  canOpen: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [filter, setFilter] = useState<StatusFilter>("action");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReasonDraft | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/clearance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ClearanceDashboardData & { message?: string };
      if (!response.ok) {
        // The database's own refusal, verbatim — it names the outstanding stations.
        setError(payload.message ?? "That clearance action could not be completed.");
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

  const decideDirect = useCallback(
    (item: ClearanceItem, status: ClearanceItemStatus) => {
      void post({ action: "decide", item: { itemId: item.id, status } });
    },
    [post],
  );

  const submitDraft = useCallback(() => {
    if (!draft) return;
    const reason = draft.reason.trim();
    if (reason === "") {
      setError(`A ${draft.status} decision needs a written reason.`);
      return;
    }
    const parsedAmount = draft.amount.trim() === "" ? null : Number.parseFloat(draft.amount);
    if (parsedAmount !== null && (!Number.isFinite(parsedAmount) || parsedAmount < 0)) {
      setError("An amount owed has to be a number of EGP, zero or more.");
      return;
    }
    void post({
      action: "decide",
      item: {
        itemId: draft.itemId,
        status: draft.status,
        reason,
        amountDue: draft.status === "blocked" ? parsedAmount : null,
      },
    }).then((ok) => {
      if (ok) setDraft(null);
    });
  }, [draft, post]);

  const confirmRelease = useCallback(
    (checklist: ClearanceChecklist) => {
      void post({ action: "release", checklistId: checklist.id }).then((ok) => {
        if (ok) setReleasingId(null);
      });
    },
    [post],
  );

  const openChecklist = useCallback(
    (resignationId: string) => {
      void post({ action: "open", resignationId });
    },
    [post],
  );

  const checklists = useMemo(() => {
    const all = data?.checklists ?? [];
    if (filter === "all") return all;
    if (filter === "action") return all.filter((c) => c.status === "open" || c.status === "ready");
    return all.filter((c) => c.status === filter);
  }, [data, filter]);

  const stats = data?.stats;

  const detailProps = (checklist: ClearanceChecklist) => ({
    busy,
    canDecide,
    checklist,
    draft,
    onAskRelease: (target: ClearanceChecklist) => setReleasingId(target.id),
    onCancelDraft: () => setDraft(null),
    onCancelRelease: () => setReleasingId(null),
    onConfirmRelease: confirmRelease,
    onDecideDirect: decideDirect,
    onDraftChange: (patch: Partial<ReasonDraft>) =>
      setDraft((current) => (current ? { ...current, ...patch } : current)),
    onOpenDraft: (item: ClearanceItem, status: "blocked" | "waived") =>
      setDraft({ itemId: item.id, status, reason: item.reason ?? "", amount: "" }),
    onSubmitDraft: submitDraft,
    releasing: releasingId === checklist.id,
  });

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker="Clearance & Offboarding"
        subtitle="Every station a leaver has to clear, and the evidence behind each one. A final settlement can only be recorded once every station is decided."
        title="Clearance"
      />

      {data && !data.schemaReady ? (
        <div className="mt-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
            The clearance tables have not reached this environment yet, so nothing is shown below.
            This is not an empty list — it is a database that has not been migrated.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-5 flex items-start gap-3 border border-rose-200 bg-rose-50 px-4 py-3" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-rose-900">{error}</p>
        </div>
      ) : null}

      {stats ? (
        <div className="mt-5 grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-5">
          <MetricTile
            label="In progress"
            sub="stations open"
            tone="slate"
            value={stats.open.toLocaleString("en-US")}
          />
          <MetricTile
            label="Ready to release"
            sub="all stations decided"
            tone={stats.ready > 0 ? "amber" : "emerald"}
            value={stats.ready.toLocaleString("en-US")}
          />
          <MetricTile
            label="Past last day"
            sub="still unreleased"
            tone={stats.overdue > 0 ? "rose" : "slate"}
            value={stats.overdue.toLocaleString("en-US")}
          />
          <MetricTile
            label="Blocked stations"
            sub="need a decision"
            tone={stats.blockedStations > 0 ? "amber" : "slate"}
            value={stats.blockedStations.toLocaleString("en-US")}
          />
          <MetricTile
            label="Outstanding"
            sub="owed to the company"
            tone={stats.amountOutstanding > 0 ? "rose" : "slate"}
            value={formatEgp(stats.amountOutstanding)}
          />
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((option) => (
          <button
            aria-pressed={filter === option.key}
            className={`whitespace-nowrap border px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
              filter === option.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
            }`}
            key={option.key}
            onClick={() => setFilter(option.key)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>

      {/*
        Resignations with no checklist. Everything recorded from now on opens one automatically, so
        this is the pre-trigger backlog and it empties as HR works through it. It sits ABOVE the
        table on purpose: a leaver who is not on the list at all is the failure this module exists
        to prevent, and it is the one thing the table below can never show.
      */}
      {(data?.awaiting.length ?? 0) > 0 ? (
        <section className="mt-5 border border-amber-200 bg-amber-50/60">
          <div className="border-b border-amber-200 px-4 py-3">
            <h2 className="text-[11px] font-black uppercase tracking-[0.12em] text-amber-900">
              Awaiting clearance · {data?.awaiting.length}
            </h2>
            <p className="mt-1 text-[11px] font-semibold text-amber-800">
              {canOpen
                ? "These departures have no clearance checklist. Open one for anyone whose settlement has not been released yet."
                : "These departures have no clearance checklist. HR Operations opens them."}
            </p>
          </div>
          <ul className="divide-y divide-amber-200">
            {data?.awaiting.map((row) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                key={row.resignationId}
              >
                <div className="min-w-0">
                  <p className="whitespace-nowrap text-[12px] font-black text-slate-900">
                    {row.employeeName}
                  </p>
                  <p className="whitespace-nowrap text-[11px] font-semibold text-slate-600">
                    {row.jobTitle ?? "—"}
                    {row.lineName ? ` · ${row.lineName}` : ""} · Last working day{" "}
                    {formatDate(row.lastWorkingDate)}
                  </p>
                </div>
                {canOpen ? (
                  <button
                    className="whitespace-nowrap border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    onClick={() => openChecklist(row.resignationId)}
                    type="button"
                  >
                    Open clearance
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {checklists.length === 0 ? (
        <p className="mt-5 border border-slate-200 bg-white px-4 py-8 text-center text-[12px] font-semibold text-slate-500">
          {data?.schemaReady === false
            ? "Nothing to show until the migration reaches this environment."
            : "No clearances match this filter."}
        </p>
      ) : null}

      {/* DESKTOP — the table. Scrolls sideways rather than wrapping or truncating a name. */}
      {checklists.length > 0 ? (
        <div className="mt-5 hidden overflow-x-auto border border-slate-200 bg-white md:block">
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {["Employee", "Last working day", "Progress", "Status", "Outstanding", "Stations"].map(
                  (heading) => (
                    <th
                      className="whitespace-nowrap px-4 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500"
                      key={heading}
                      scope="col"
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {checklists.map((checklist) => (
                <Fragment key={checklist.id}>
                  <tr className="border-b border-slate-100">
                    <td className="whitespace-nowrap px-4 py-3">
                      <p className="text-[13px] font-black text-slate-900">
                        {checklist.employeeName}
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                        {checklist.employeeHrId}
                        {checklist.jobTitle ? ` · ${checklist.jobTitle}` : ""}
                        {checklist.lineName ? ` · ${checklist.lineName}` : ""}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] font-semibold tabular-nums text-slate-700">
                      {formatDate(checklist.lastWorkingDate)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <ProgressBar cleared={checklist.clearedCount} total={checklist.totalCount} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <StatusChip status={checklist.status} />
                        <OverdueFlag checklist={checklist} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] font-black tabular-nums text-slate-900">
                      {checklist.amountOutstanding > 0 ? formatEgp(checklist.amountOutstanding) : "None"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        aria-expanded={expandedId === checklist.id}
                        className="border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                        onClick={() =>
                          setExpandedId(expandedId === checklist.id ? null : checklist.id)
                        }
                        type="button"
                      >
                        {expandedId === checklist.id ? "Hide" : "Open"}
                      </button>
                    </td>
                  </tr>
                  {expandedId === checklist.id ? (
                    <tr>
                      <td className="px-4 pb-4" colSpan={6}>
                        <ChecklistDetail {...detailProps(checklist)} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* MOBILE — cards, never a table. */}
      <div className="mt-5 grid gap-3 md:hidden">
        {checklists.map((checklist) => (
          <div className="border border-slate-200 bg-white px-4 py-4" key={checklist.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] font-black leading-tight text-slate-900">
                  {checklist.employeeName}
                </p>
                <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                  {checklist.employeeHrId}
                  {checklist.jobTitle ? ` · ${checklist.jobTitle}` : ""}
                </p>
              </div>
              <StatusChip status={checklist.status} />
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">
                  Last working day
                </dt>
                <dd className="mt-1 text-[12px] font-bold tabular-nums text-slate-800">
                  {formatDate(checklist.lastWorkingDate)}
                </dd>
              </div>
              <div>
                <dt className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">
                  Outstanding
                </dt>
                <dd className="mt-1 text-[12px] font-black tabular-nums text-slate-900">
                  {checklist.amountOutstanding > 0 ? formatEgp(checklist.amountOutstanding) : "None"}
                </dd>
              </div>
            </dl>

            <div className="mt-3">
              <ProgressBar cleared={checklist.clearedCount} total={checklist.totalCount} />
            </div>

            {checklist.isOverdue ? (
              <div className="mt-2">
                <OverdueFlag checklist={checklist} />
              </div>
            ) : null}

            <button
              aria-expanded={expandedId === checklist.id}
              className="mt-3 w-full border border-slate-300 bg-white px-3 py-2 text-[11px] font-black uppercase tracking-[0.08em] text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() => setExpandedId(expandedId === checklist.id ? null : checklist.id)}
              type="button"
            >
              {expandedId === checklist.id ? "Hide stations" : `Stations (${checklist.totalCount})`}
            </button>

            {expandedId === checklist.id ? (
              <div className="mt-3">
                <ChecklistDetail {...detailProps(checklist)} />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {canDecide ? null : (
        <p className="mt-5 flex items-center gap-2 border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] font-semibold text-slate-600">
          <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
          You have read access to clearance. Deciding a station and recording a settlement release
          belong to HR Operations.
        </p>
      )}
    </div>
  );
}
