"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  CheckCircle2,
  Eye,
  History,
  Inbox,
  MapPin,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  RotateCcw,
  TriangleAlert,
  UserRound,
  XCircle,
} from "lucide-react";

import { Conversation } from "@/components/market-awareness/market-awareness-conversation";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
// Pure, and client-safe: workflow.ts imports permissions only as a TYPE, so nothing server-side
// follows it into this bundle.
import { describeInboxStep, describeInboxWait } from "@/lib/market-awareness/workflow";
import {
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * Market Awareness — the approvals inbox.
 *
 * Its own screen under Approvals Hub, beside Marketing Inbox, rather than a row in the consolidated
 * hub: the owner asked for a separate inbox, and marketing is precedent for a module keeping its
 * own queue.
 *
 * THE LIST IS NOT THE AUTHORITY. It is built server-side from the same `canDecideStep` the decision
 * route enforces, so a row can never appear here that the server would then refuse — which is the
 * failure a hand-written "who can see this" filter produces.
 *
 * THE SAME GOLDEN RULES AS THE WORKSPACE: no horizontal scroll at any width, square edges only (no
 * `rounded-*` class in this file), no ellipsis, human names never codes, Cairo time.
 */

/**
 * The five answers. `hold` and `release` are the owner's 2026-09-09 addition: any member of the
 * group may freeze the request, and only whoever froze it, the CEO or Super Admin may lift it.
 */
type DecisionAction = "approve" | "reject" | "return" | "hold" | "release";

type Line = { id: number; lineCode: string; name: string };

type SeatHolder = { name: string | null; vacant: boolean };

/**
 * One member of the parallel approval group. `decision` null means they have not answered yet, and
 * that is what the progress strip counts — a request is waiting on everyone who has not answered,
 * all at once, which is the whole point of the group.
 */
type ApproverSlot = {
  id: number;
  approverRole: "marketing_manager" | "nsm";
  lineName: string | null;
  isPrimaryLine: boolean;
  assignedName: string | null;
  decision: "approve" | "reject" | "return" | null;
  decidedByName: string | null;
  decidedAt: string | null;
  comment: string | null;
};

type Activity = {
  id: string;
  activityCode: string;
  status: string;
  requesterName: string | null;
  requesterHrId: string;
  managerName: string | null;
  approvers: ApproverSlot[];
  heldByName: string | null;
  heldAt: string | null;
  holdReason: string | null;
  activityType: { name: string };
  title: string | null;
  venue: string | null;
  city: string | null;
  startDate: string;
  endDate: string | null;
  primaryLine: Line;
  lines: Line[];
  regionName: string | null;
  areaName: string | null;
  areaCode: string;
  products: Array<{ productCode: string; productName: string | null }>;
  currency: string;
  estimatedCost: number;
  approvedCost: number | null;
  durationMonths: number;
  baselineMonths: number;
  expectedUpliftPct: number | null;
  expectedAttendees: number | null;
  speakers: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  executedAt: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  rep: SeatHolder;
  decisions: Array<{
    id: number;
    stepCode: string;
    actorName: string | null;
    action: string;
    comment: string | null;
    createdAt: string;
  }>;
};

/** What a slot is, in the words the owner uses. Never a code, and the line is part of the name. */
function slotLabel(slot: ApproverSlot): string {
  if (slot.approverRole === "marketing_manager") return "Marketing Manager";
  return slot.lineName ? `National Sales Manager · ${slot.lineName}` : "National Sales Manager";
}

function money(amount: number | null | undefined, currency = "EGP"): string {
  if (amount === null || amount === undefined) return "Not set";
  return `${new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(amount)} ${currency}`;
}

function cairoDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const raw = String(value);
  const parsed = new Date(raw.length <= 10 ? `${raw}T12:00:00Z` : raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return stableEnGbFormatter({
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-phx-3xs font-bold uppercase tracking-[0.14em] text-phx-ink-faint">
      {children}
    </span>
  );
}

const BTN_APPROVE =
  "inline-flex items-center justify-center gap-2 border border-phx-ok bg-phx-ok px-4 py-2.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-paper transition disabled:cursor-not-allowed disabled:opacity-60";
const BTN_RETURN =
  "inline-flex items-center justify-center gap-2 border border-phx-warn-line bg-phx-warn-bg px-4 py-2.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-warn transition disabled:cursor-not-allowed disabled:opacity-60";
const BTN_REJECT =
  "inline-flex items-center justify-center gap-2 border border-phx-danger-line bg-phx-danger-bg px-4 py-2.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-danger transition disabled:cursor-not-allowed disabled:opacity-60";
const BTN_QUIET =
  "inline-flex items-center justify-center gap-2 border border-phx-line bg-phx-paper px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.10em] text-phx-ink-soft transition hover:border-phx-line-strong hover:text-phx-ink";
const INPUT = cn(phxFieldClassName, "w-full px-3 text-phx-sm");
const TEXTAREA = cn(phxTextareaClassName, "min-h-20 w-full px-3 py-2 text-phx-sm");

type InboxScope = "open" | "history";

type InboxRow = { activity: Activity; canDecide: boolean; canRelease: boolean };

const INBOX_TABS: ReadonlyArray<{ description: string; icon: typeof Inbox; key: InboxScope; label: string }> = [
  { description: "Still moving through the chain", icon: Inbox, key: "open", label: "In approval" },
  { description: "Every answered activity you can see", icon: History, key: "history", label: "History" },
];

/**
 * The approvals inbox — the same two tabs as the Marketing inbox, on the owner's instruction
 * (2026-09-07: "exactly the same tabs of any other approval inbox, and be able to see historical").
 *
 * WHAT "IN APPROVAL" MEANS HERE IS WIDER THAN "MINE TO DECIDE", and that is the point. The Group
 * Product Manager asked to track a Product Manager's request while it sits with that PM's own
 * manager — he is not in its chain, so it was visible to nobody but that manager. Every row the
 * caller may SEE is listed now, and the server marks each with `canDecide`; a row that is not
 * theirs renders its state and no buttons. The header count stays the number of decisions actually
 * OWED, never the number of rows, because "3 waiting on you" must not come to mean "3 things exist".
 *
 * The tab strip copies the Marketing inbox's structure — roles, descriptions, both panels kept
 * mounted — but NOT its `rounded-sm`: the square-edge golden rule outranks matching a sibling's
 * radius, and inheriting a rounded corner by copying is exactly how that rule gets lost.
 */
export function MarketAwarenessInbox({ isCeoStepHolder }: { isCeoStepHolder: boolean }) {
  const [scope, setScope] = useState<InboxScope>("open");
  const [rowsByScope, setRowsByScope] = useState<Partial<Record<InboxScope, InboxRow[]>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const current = rowsByScope[scope];
  const loading = current === undefined;
  const rows = useMemo(() => current ?? [], [current]);
  const openRows = rowsByScope.open;
  const owed = useMemo(
    () => (openRows ?? []).filter((row) => row.canDecide).length,
    [openRows],
  );

  const load = useCallback(async (which: InboxScope) => {
    try {
      const response = await fetch(`/api/market-awareness/inbox?scope=${which}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.message ?? `Could not load the approvals inbox (HTTP ${response.status}).`,
        );
      }
      setRowsByScope((previous) => ({ ...previous, [which]: payload.rows ?? [] }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the approvals inbox.");
      setRowsByScope((previous) => ({ ...previous, [which]: [] }));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load(scope);
    })();
  }, [load, scope]);

  const decide = async (
    activityId: string,
    action: DecisionAction,
    comment: string,
    amendedCost: number | null,
  ) => {
    setBusyId(activityId);
    setError(null);
    try {
      const response = await fetch(`/api/market-awareness/${activityId}/decision`, {
        body: JSON.stringify({ action, amendedCost, comment: comment.trim() || null }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.message ?? `Could not record that decision (HTTP ${response.status}).`,
        );
      }
      // A decision moves the row from one tab to the other, so every tab already loaded is now
      // stale — refresh them all rather than only the one being looked at.
      const loaded = Object.keys(rowsByScope) as InboxScope[];
      await Promise.all(loaded.map((which) => load(which)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record that decision.");
    } finally {
      setBusyId(null);
    }
  };

  const headline = loading
    ? "Loading"
    : scope === "history"
      ? rows.length === 0
        ? "Nothing answered yet"
        : `${rows.length} answered`
      : owed === 0
        ? rows.length === 0
          ? "Nothing waiting"
          : `${rows.length} moving, none waiting on you`
        : `${owed} waiting on you`;

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      {error ? (
        <div className="flex min-w-0 items-start gap-2 border border-phx-warn-line bg-phx-warn-bg px-3 py-2.5">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phx-warn" />
          <p className="min-w-0 break-words text-phx-xs font-bold text-phx-warn">{error}</p>
        </div>
      ) : null}

      <div className="flex w-full min-w-0 border border-phx-line bg-phx-paper p-1" role="tablist">
        {INBOX_TABS.map((definition) => {
          const Icon = definition.icon;
          const isActive = definition.key === scope;
          return (
            <button
              aria-selected={isActive}
              className={`inline-flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.08em] transition ${
                isActive
                  ? "bg-phx-ink text-phx-paper"
                  : "text-phx-ink-soft hover:bg-phx-paper-2 hover:text-phx-ink"
              }`}
              key={definition.key}
              onClick={() => setScope(definition.key)}
              role="tab"
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{definition.label}</span>
              <span
                className={`hidden break-words text-phx-3xs font-medium normal-case tracking-normal sm:inline ${
                  isActive ? "text-phx-paper-2" : "text-phx-ink-faint"
                }`}
              >
                {definition.description}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-phx-line pb-3">
        <p className="min-w-0 break-words text-phx-sm font-black uppercase tracking-[0.08em] text-phx-ink">
          {headline}
        </p>
        <button className={BTN_QUIET} onClick={() => void load(scope)} type="button">
          <RefreshCcw aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>Refresh</span>
        </button>
      </div>

      {loading ? (
        <div className="flex min-w-0 flex-col gap-2">
          {[0, 1].map((i) => (
            <div className="h-28 w-full animate-pulse border border-phx-line bg-phx-paper-2" key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-w-0 flex-col items-center gap-2 border border-dashed border-phx-line bg-phx-paper-2 px-4 py-12 text-center">
          <CheckCircle2 aria-hidden="true" className="h-6 w-6 shrink-0 text-phx-ok" />
          <p className="break-words text-phx-sm font-black text-phx-ink">
            {scope === "history" ? "Nothing has been answered yet" : "Your queue is clear"}
          </p>
          <p className="max-w-md break-words text-phx-xs font-medium text-phx-ink-soft">
            {scope === "history"
              ? "Approved, rejected, withdrawn, executed and closed activities you can see collect here once they have been answered."
              : "An awareness activity appears here the moment a product manager submits it. Everything you can see is listed; the decision buttons show only where the decision is actually yours."}
          </p>
        </div>
      ) : (
        <ul className="flex min-w-0 flex-col gap-4">
          {rows.map((row) => (
            <li className="min-w-0" key={row.activity.id}>
              <InboxCard
                activity={row.activity}
                busy={busyId === row.activity.id}
                canAmend={isCeoStepHolder && row.activity.status === "pending_ceo"}
                canDecide={row.canDecide}
                canRelease={row.canRelease}
                onDecide={(action, comment, amended) =>
                  void decide(row.activity.id, action, comment, amended)
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Who a row is currently waiting on, for someone who is watching rather than deciding.
 *
 * Named, never a status code — the owner's standing rule is human-readable names. At the group step
 * that means EVERY name still outstanding, because they are all being waited on at once and naming
 * only the first reads as a queue they take in turns. A missing name means the seat was emptied
 * after submission, and saying so is better than printing an id or an empty space.
 */
function waitingOn(activity: Activity): string {
  if (activity.status === "pending_group") {
    const names = activity.approvers
      .filter((slot) => slot.decision === null)
      .map((slot) => slot.assignedName ?? `${slotLabel(slot)} (seat empty)`);
    if (names.length === 0) return "Waiting on the marketing and sales approvers";
    return `Waiting on ${names.join(" and ")}`;
  }
  if (activity.status === "on_hold") {
    return activity.heldByName
      ? `On hold — ${activity.heldByName} froze it`
      : "On hold until it is released";
  }
  if (activity.status === "pending_ceo") return "Waiting on the CEO";
  if (activity.status === "returned") {
    return `Sent back to ${activity.requesterName ?? "the requester"} for changes`;
  }
  return "No decision is outstanding";
}

/**
 * The group, as a strip: who has answered and who has not.
 *
 * THIS IS WHAT MAKES A PARALLEL STEP READABLE. Sequentially, "who has it" is one name and the
 * status carries it. In parallel it is two or three at once, and without this an approver cannot
 * tell whether he is the last one holding it up or the first to be asked.
 */
function ApproverStrip({ activity }: { activity: Activity }) {
  if (activity.approvers.length === 0) return null;
  const answered = activity.approvers.filter((slot) => slot.decision !== null).length;

  return (
    <div className="mt-3 min-w-0 border border-phx-line bg-phx-paper-2 px-3 py-2">
      <MicroLabel>
        Marketing and sales approval — {answered} of {activity.approvers.length} answered
      </MicroLabel>
      <ul className="mt-1.5 flex min-w-0 flex-col gap-1.5">
        {activity.approvers.map((slot) => {
          const tone =
            slot.decision === "approve"
              ? "text-phx-ok"
              : slot.decision === null
                ? "text-phx-ink-faint"
                : "text-phx-warn";
          const answer =
            slot.decision === "approve"
              ? "Approved"
              : slot.decision === "reject"
                ? "Rejected"
                : slot.decision === "return"
                  ? "Sent back"
                  : "Not answered yet";
          return (
            <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5" key={slot.id}>
              <span className="break-words text-phx-2xs font-black text-phx-ink">
                {slot.assignedName ?? "Seat empty"}
              </span>
              <span className="break-words text-phx-3xs font-bold uppercase tracking-[0.08em] text-phx-ink-soft">
                {slotLabel(slot)}
              </span>
              <span className={`text-phx-3xs font-black uppercase tracking-[0.08em] ${tone}`}>
                {answer}
              </span>
              {/* Somebody covering answered in place of the person it was sent to. Said plainly,
                  because a decision attributed to the wrong name is worse than an extra line. */}
              {slot.decidedByName && slot.decidedByName !== slot.assignedName ? (
                <span className="break-words text-phx-3xs font-medium text-phx-ink-faint">
                  answered by {slot.decidedByName}
                </span>
              ) : null}
              {slot.comment ? (
                <span className="block w-full break-words text-phx-2xs font-medium text-phx-ink-soft">
                  {slot.comment}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InboxCard({
  activity,
  busy,
  canAmend,
  canDecide,
  canRelease,
  onDecide,
}: {
  activity: Activity;
  busy: boolean;
  canAmend: boolean;
  /** Whether the release route would accept a release from this viewer, resolved server-side. */
  canRelease: boolean;
  /**
   * Whether the decision route would accept a decision from this viewer, resolved server-side.
   * False for a row somebody is only TRACKING — the Group Product Manager watching a request that
   * sits with a Product Manager's own manager. Those rows show their state and no buttons: offering
   * a control the server refuses is worse than not offering it.
   */
  canDecide: boolean;
  onDecide: (action: DecisionAction, comment: string, amendedCost: number | null) => void;
}) {
  const [comment, setComment] = useState("");
  const [amend, setAmend] = useState("");
  const [confirming, setConfirming] = useState<"reject" | null>(null);
  // Hold belongs to the group, never to the CEO — his answers are approve, reject and return, as
  // they have always been. The server refuses it either way; this stops the button appearing.
  const canHold = canDecide && activity.status === "pending_group";

  const asked = activity.estimatedCost;
  const amendedValue = amend.trim() === "" ? null : Number(amend);
  const amendInvalid = amendedValue !== null && !(amendedValue > 0);

  const facts: Array<[string, string]> = [
    ["Type", activity.activityType.name],
    ["Line", activity.primaryLine.name],
    ["Where", `${activity.areaName ?? activity.areaCode} · ${activity.regionName ?? ""}`],
    ["Starts", cairoDate(activity.startDate)],
    ["Asked for", money(asked, activity.currency)],
    ["Window", `${activity.durationMonths} months, against ${activity.baselineMonths} before`],
  ];

  return (
    <article className="relative min-w-0 border border-phx-line bg-phx-paper">
      <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[2px] bg-phx-accent" />

      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-phx-line px-4 py-3 pl-5">
        <div className="min-w-0">
          <MicroLabel>{describeInboxStep({ canDecide, status: activity.status })}</MicroLabel>
          <h3 className="break-words text-phx-md font-black text-phx-ink">
            {activity.title?.trim() || activity.activityType.name}
          </h3>
          <p className="mt-0.5 break-words text-phx-3xs font-medium text-phx-ink-faint">
            {activity.activityCode}
          </p>
        </div>
        <span className="shrink-0 border border-phx-accent-line bg-phx-accent-soft px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-accent-press">
          {describeInboxWait(activity)}
        </span>
      </header>

      <div className="min-w-0 p-4 pl-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-phx-line pb-3">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold text-phx-ink-soft">
            <UserRound aria-hidden="true" className="h-3 w-3 shrink-0 text-phx-ink-faint" />
            <span className="break-words">{activity.requesterName ?? activity.requesterHrId}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold text-phx-ink-soft">
            <MapPin aria-hidden="true" className="h-3 w-3 shrink-0 text-phx-ink-faint" />
            <span className="break-words">{activity.areaName ?? activity.areaCode}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold text-phx-ink-soft">
            <CalendarRange aria-hidden="true" className="h-3 w-3 shrink-0 text-phx-ink-faint" />
            <span className="break-words">{cairoDate(activity.startDate)}</span>
          </span>
        </div>

        <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {facts.map(([label, value]) => (
            <div className="min-w-0 border border-phx-line bg-phx-paper-2 px-3 py-2" key={label}>
              <dt>
                <MicroLabel>{label}</MicroLabel>
              </dt>
              <dd className="mt-0.5 break-words text-phx-xs font-black text-phx-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-3 min-w-0 border border-phx-line bg-phx-paper-2 px-3 py-2">
          <MicroLabel>Targeted products</MicroLabel>
          <p className="mt-0.5 break-words text-phx-xs font-bold text-phx-ink">
            {activity.products.map((p) => p.productName ?? p.productCode).join(" · ") || "None"}
          </p>
        </div>

        <ApproverStrip activity={activity} />

        {/* Frozen. Stated at the top of the body rather than buried, because it is the reason
            nothing else on this card can be pressed. */}
        {activity.status === "on_hold" ? (
          <div className="mt-3 flex min-w-0 items-start gap-2 border border-phx-warn-line bg-phx-warn-bg px-3 py-2.5">
            <PauseCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phx-warn" />
            <p className="min-w-0 break-words text-phx-xs font-bold text-phx-warn">
              {activity.heldByName ? `${activity.heldByName} put this on hold` : "This is on hold"}
              {activity.heldAt ? ` on ${cairoDate(activity.heldAt)}` : ""}
              {activity.holdReason ? `: ${activity.holdReason}` : "."}
            </p>
          </div>
        ) : null}

        {/* What the step below already said. A group return comment is the CEO's context. */}
        {activity.decisions.length > 0 ? (
          <div className="mt-3 min-w-0">
            <MicroLabel>Already decided</MicroLabel>
            <ol className="mt-1.5 flex min-w-0 flex-col gap-1.5">
              {activity.decisions.map((decision) => (
                <li
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2 border-l-2 border-phx-line pl-2.5"
                  key={decision.id}
                >
                  <span className="break-words text-phx-2xs font-black text-phx-ink">
                    {decision.actorName ?? "Unknown"}
                  </span>
                  <span className="text-phx-3xs font-bold uppercase tracking-[0.08em] text-phx-ink-soft">
                    {decision.action}
                  </span>
                  <span className="text-phx-3xs font-medium text-phx-ink-faint">
                    {cairoDate(decision.createdAt)}
                  </span>
                  {decision.comment ? (
                    <span className="block w-full break-words text-phx-2xs font-medium text-phx-ink-soft">
                      {decision.comment}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="mt-3 min-w-0">
          <Conversation activityId={activity.id} />
        </div>

        {/* The decision — rendered only where it is actually this viewer's to make. */}
        {canDecide ? (
          <div className="mt-4 flex min-w-0 flex-col gap-3 border-t border-phx-line pt-4">
            <label className="block min-w-0">
              <span className="mb-1.5 flex flex-wrap items-center gap-2">
                <MicroLabel>Comment</MicroLabel>
                <span className="inline-flex items-center gap-1 text-phx-3xs font-bold uppercase tracking-[0.10em] text-phx-ink-faint">
                  <MessageSquare aria-hidden="true" className="h-3 w-3 shrink-0" />
                  Required to return it
                </span>
              </span>
              <textarea
                className={TEXTAREA}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Say what needs changing, or leave a note with your approval."
                value={comment}
              />
            </label>

            {/* The CEO may approve at a different figure — the common real case, "yes but 50,000".
                Only his step offers it, because an amended amount is HIS decision and nobody else's. */}
            {canAmend ? (
              <label className="block min-w-0 sm:max-w-xs">
                <span className="mb-1.5 block">
                  <MicroLabel>Approve at a different amount (EGP)</MicroLabel>
                </span>
                <input
                  className={INPUT}
                  inputMode="decimal"
                  onChange={(event) => setAmend(event.target.value)}
                  placeholder={String(Math.round(asked))}
                  value={amend}
                />
                <span className="mt-1.5 block break-words text-phx-3xs font-medium text-phx-ink-faint">
                  {amendInvalid
                    ? "An amended amount has to be greater than zero."
                    : amendedValue === null
                      ? `Leave blank to approve the ${money(asked, activity.currency)} asked for.`
                      : `Approves at ${money(amendedValue, activity.currency)} instead of ${money(asked, activity.currency)}.`}
                </span>
              </label>
            ) : null}

            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <button
                className={BTN_APPROVE}
                disabled={busy || amendInvalid}
                onClick={() => onDecide("approve", comment, canAmend ? amendedValue : null)}
                type="button"
              >
                <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>{busy ? "Saving" : "Approve"}</span>
              </button>

              <button
                className={BTN_RETURN}
                disabled={busy || comment.trim() === ""}
                onClick={() => onDecide("return", comment, null)}
                type="button"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>Return for changes</span>
              </button>

              {/* A rejection is the one action with no way back, so it asks twice. */}
              {confirming === "reject" ? (
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <button
                    className={BTN_REJECT}
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      onDecide("reject", comment, null);
                    }}
                    type="button"
                  >
                    <XCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span>Confirm reject</span>
                  </button>
                  <button className={BTN_QUIET} onClick={() => setConfirming(null)} type="button">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className={BTN_REJECT}
                  disabled={busy}
                  onClick={() => setConfirming("reject")}
                  type="button"
                >
                  <XCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span>Reject</span>
                </button>
              )}

              {/* Hold freezes it for EVERYONE, so it says why — the requester is told, and the
                  reason is the only thing that tells him what it is waiting on. */}
              {canHold ? (
                <button
                  className={BTN_RETURN}
                  disabled={busy || comment.trim() === ""}
                  onClick={() => onDecide("hold", comment, null)}
                  type="button"
                >
                  <PauseCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span>Put on hold</span>
                </button>
              ) : null}
            </div>

            <p className="break-words text-phx-3xs font-medium text-phx-ink-faint">
              {activity.status === "pending_ceo"
                ? "Approving releases it: every district manager in the region for this line, the national sales manager, the SFE manager, the area's rep and Finance are told."
                : "It goes to the CEO once everyone here has approved. Returning it sends it back to the requester to edit and resubmit, and the whole group is asked again. Putting it on hold freezes it for everyone until you release it."}
            </p>
          </div>
        ) : canRelease ? (
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2.5 border-t border-phx-line pt-4">
            <button
              className={BTN_APPROVE}
              disabled={busy}
              onClick={() => onDecide("release", "", null)}
              type="button"
            >
              <PlayCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span>{busy ? "Saving" : "Release the hold"}</span>
            </button>
            <span className="min-w-0 break-words text-phx-3xs font-medium text-phx-ink-faint">
              Puts it back in front of everyone who has not answered. The days it spent on hold do
              not count against them.
            </span>
          </div>
        ) : (
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2 border-t border-phx-line pt-4">
            <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
            <span className="min-w-0 break-words text-phx-2xs font-bold text-phx-ink-soft">
              {waitingOn(activity)}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
