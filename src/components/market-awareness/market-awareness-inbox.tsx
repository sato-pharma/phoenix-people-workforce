"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  CheckCircle2,
  MapPin,
  MessageSquare,
  RefreshCcw,
  RotateCcw,
  TriangleAlert,
  UserRound,
  XCircle,
} from "lucide-react";

import { Conversation } from "@/components/market-awareness/market-awareness-conversation";

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

type Line = { id: number; lineCode: string; name: string };

type SeatHolder = { name: string | null; vacant: boolean };

type Activity = {
  id: string;
  activityCode: string;
  status: string;
  requesterName: string | null;
  requesterHrId: string;
  managerName: string | null;
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

const STEP_LABEL: Record<string, string> = {
  pending_manager: "Waiting on you as the manager",
  pending_ceo: "Waiting on you as the CEO",
};

function money(amount: number | null | undefined, currency = "EGP"): string {
  if (amount === null || amount === undefined) return "Not set";
  return `${new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(amount)} ${currency}`;
}

function cairoDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const raw = String(value);
  const parsed = new Date(raw.length <= 10 ? `${raw}T12:00:00Z` : raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

/** How long it has been sitting. An SLA marker, never a blocker. */
function waitingFor(submittedAt: string | null): string {
  if (!submittedAt) return "Just submitted";
  const days = Math.floor((Date.now() - new Date(submittedAt).getTime()) / 86_400_000);
  if (days <= 0) return "Submitted today";
  if (days === 1) return "Waiting 1 day";
  return `Waiting ${days} days`;
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
const INPUT =
  "h-10 w-full border border-phx-line bg-phx-paper px-3 text-phx-sm font-bold text-phx-ink outline-none transition focus:border-phx-accent focus:ring-2 focus:ring-phx-accent-soft";
const TEXTAREA =
  "min-h-20 w-full border border-phx-line bg-phx-paper px-3 py-2 text-phx-sm font-bold text-phx-ink outline-none transition focus:border-phx-accent focus:ring-2 focus:ring-phx-accent-soft";

export function MarketAwarenessInbox({ isCeoStepHolder }: { isCeoStepHolder: boolean }) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loading = activities === null;
  const rows = useMemo(() => activities ?? [], [activities]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/market-awareness/inbox", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.message ?? `Could not load the approvals inbox (HTTP ${response.status}).`,
        );
      }
      setActivities(payload.activities ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the approvals inbox.");
      setActivities([]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const decide = async (
    activityId: string,
    action: "approve" | "reject" | "return",
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
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record that decision.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      {error ? (
        <div className="flex min-w-0 items-start gap-2 border border-phx-warn-line bg-phx-warn-bg px-3 py-2.5">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phx-warn" />
          <p className="min-w-0 break-words text-phx-xs font-bold text-phx-warn">{error}</p>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-phx-line pb-3">
        <p className="min-w-0 break-words text-phx-sm font-black uppercase tracking-[0.08em] text-phx-ink">
          {loading
            ? "Loading"
            : rows.length === 0
              ? "Nothing waiting on you"
              : `${rows.length} waiting on you`}
        </p>
        <button className={BTN_QUIET} onClick={() => void load()} type="button">
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
          <p className="break-words text-phx-sm font-black text-phx-ink">Your queue is clear</p>
          <p className="max-w-md break-words text-phx-xs font-medium text-phx-ink-soft">
            An awareness activity appears here the moment the product manager submits it — and only
            for the person whose decision it actually is.
          </p>
        </div>
      ) : (
        <ul className="flex min-w-0 flex-col gap-4">
          {rows.map((activity) => (
            <li className="min-w-0" key={activity.id}>
              <InboxCard
                activity={activity}
                busy={busyId === activity.id}
                canAmend={isCeoStepHolder && activity.status === "pending_ceo"}
                onDecide={(action, comment, amended) =>
                  void decide(activity.id, action, comment, amended)
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxCard({
  activity,
  busy,
  canAmend,
  onDecide,
}: {
  activity: Activity;
  busy: boolean;
  canAmend: boolean;
  onDecide: (
    action: "approve" | "reject" | "return",
    comment: string,
    amendedCost: number | null,
  ) => void;
}) {
  const [comment, setComment] = useState("");
  const [amend, setAmend] = useState("");
  const [confirming, setConfirming] = useState<"reject" | null>(null);

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
          <MicroLabel>{STEP_LABEL[activity.status] ?? "Waiting on you"}</MicroLabel>
          <h3 className="break-words text-phx-md font-black text-phx-ink">
            {activity.title?.trim() || activity.activityType.name}
          </h3>
          <p className="mt-0.5 break-words text-phx-3xs font-medium text-phx-ink-faint">
            {activity.activityCode}
          </p>
        </div>
        <span className="shrink-0 border border-phx-accent-line bg-phx-accent-soft px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-accent-press">
          {waitingFor(activity.submittedAt)}
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

        {/* What the step below already said. A manager's return comment is the CEO's context. */}
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

        {/* The decision. */}
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
          </div>

          <p className="break-words text-phx-3xs font-medium text-phx-ink-faint">
            {activity.status === "pending_ceo"
              ? "Approving releases it: every district manager in the region for this line, the national sales manager, the SFE manager, the area's rep and Finance are told."
              : "Approving sends it to the CEO. Returning it sends it back to the requester to edit and resubmit."}
          </p>
        </div>
      </div>
    </article>
  );
}
