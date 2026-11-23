/**
 * What the Expense Approvals page shows and how a press changes it — pure, so the browser, the
 * address bar and the tests all read one definition.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). Four things live here:
 *
 *   1. The lanes. Ready (every check passed) · Your call (the one reason it is unclear) · History
 *      (read on a press). The two waiting lanes always add up to the Waiting tile: one list, split
 *      once, by the verdict the server already gave.
 *   2. The view kept in the address — lane, search, "over 7 days", kind, trip dates, the open trip — so a reload or a
 *      shared link opens the same thing. Defaults are left out of the address.
 *   3. What a press sends, and what the page looks like after the answer: the decided claim leaves
 *      the list, the Waiting tile loses it and its new tile gains it; a claim the server refused or
 *      found changed comes back with its new figures. No re-read of the whole page.
 *   4. The words. One vocabulary for the buttons, and the reasons offered as one-press chips — each
 *      a finished sentence the employee can read, built only from a check that FAILED on this claim
 *      (a rejection's reason is told to the employee; never a reason that is not true of the trip).
 */

import { CLAIM_KIND_LABEL, claimKindFromParam } from "@/lib/outstation/approvals/claim-kind";
import { TRIP_STANDINGS, type TripStanding } from "@/lib/outstation/approvals/standing";
import { claimInPeriod, periodMonth, periodWords, tripPeriodOf } from "@/lib/outstation/approvals/trip-period";
import type {
  ClaimKind,
  DecisionAction,
  DeskClaim,
  DeskDecisionOutcome,
  DeskDecisionRequest,
  DeskLaneSummary,
  DeskQueue,
} from "@/lib/outstation/approvals/types";

/** The one vocabulary. Pinned by tests/expense-desk-view.test.ts. */
export const DESK_WORDS = {
  approve: "Approve",
  approveAll: "Approve all",
  clearTicks: "Clear",
  keepFull: "Keep full claim",
  open: "Open",
  reduce: "Reduce",
  reject: "Reject",
  undo: "Undo",
} as const;

export const DESK_LANES = ["ready", "your_call", "history"] as const;
export type DeskLane = (typeof DESK_LANES)[number];

export const DESK_LANE_LABEL: Record<DeskLane, string> = { history: "History", ready: "Ready", your_call: "Your call" };

export const DESK_LANE_MEANING: Record<DeskLane, string> = {
  history: "What was already decided. Read when you open it.",
  ready: "Every check passed. Nothing to look at.",
  your_call: "Something is unclear. Each row says the one reason.",
};

export type DeskHistoryChoice = "all" | "approved" | "rejected";

export type DeskView = {
  /** First trip day shown (owner, 2026-11-23: "filter by period or month or date"); null = no start. Narrows all three lanes. */
  from: string | null;
  history: DeskHistoryChoice;
  /** Traveling, Meeting or Other (owner, 2026-11-23); null = every kind. Narrows all three lanes. */
  kind: ClaimKind | null;
  /** Null = not chosen: the page opens the first waiting lane that holds a claim. */
  lane: DeskLane | null;
  overSevenDays: boolean;
  search: string;
  /** Last trip day shown; null = no end. One day is From and To the same; a month is its first and last day. */
  to: string | null;
  /** The trip open in the reviewer; null when none. */
  trip: number | null;
};

export const DEFAULT_DESK_VIEW: DeskView = { from: null, history: "all", kind: null, lane: null, overSevenDays: false, search: "", to: null, trip: null };

const isLane = (value: string | null): value is DeskLane => (DESK_LANES as readonly string[]).includes(String(value));

export function deskViewFromSearch(search: string | URLSearchParams | null | undefined): DeskView {
  const params = typeof search === "string" ? new URLSearchParams(search) : (search ?? new URLSearchParams());
  const lane = params.get("lane");
  const history = params.get("decided");
  const trip = params.get("trip");
  const period = tripPeriodOf(params.get("from"), params.get("to"));
  return {
    from: period.from,
    history: history === "approved" || history === "rejected" ? history : "all",
    kind: claimKindFromParam(params.get("kind")),
    lane: isLane(lane) ? lane : null,
    overSevenDays: params.get("over7") === "1",
    search: (params.get("q") ?? "").trim().slice(0, 60),
    to: period.to,
    trip: trip && /^\d{1,12}$/.test(trip) && Number(trip) > 0 ? Number(trip) : null,
  };
}

/** The address for a view — defaults left out, keys in one order, so the same view is the same link. */
export function deskViewToSearch(view: DeskView): string {
  const params = new URLSearchParams();
  if (view.lane) params.set("lane", view.lane);
  if (view.search.trim()) params.set("q", view.search.trim());
  if (view.overSevenDays) params.set("over7", "1");
  if (view.kind) params.set("kind", view.kind);
  if (view.from) params.set("from", view.from);
  if (view.to) params.set("to", view.to);
  if (view.history !== "all") params.set("decided", view.history);
  if (view.trip) params.set("trip", String(view.trip));
  const text = params.toString();
  return text ? `?${text}` : "";
}

const money = (value: number) => Math.round(value * 100) / 100;

/** The two waiting lanes. They add up to the Waiting tile: nothing waits outside them. */
export function laneSummaries(claims: ReadonlyArray<DeskClaim>): Record<Exclude<DeskLane, "history">, DeskLaneSummary> {
  const out = { ready: { count: 0, value: 0 }, your_call: { count: 0, value: 0 } };
  for (const claim of claims) {
    if (claim.standing !== "waiting") continue;
    const lane = out[claim.verdict.lane];
    lane.count += 1;
    lane.value += claim.payable;
  }
  out.ready.value = money(out.ready.value);
  out.your_call.value = money(out.your_call.value);
  return out;
}

/**
 * True when the view is narrowed by something History also reads — the kind, the trip dates or the
 * search. "Over 7 days" is about waiting, so it alone sends nobody to History.
 */
export function narrowsHistory(view: Pick<DeskView, "from" | "kind" | "search" | "to">): boolean {
  return view.kind !== null || view.from !== null || view.to !== null || Boolean(view.search.trim());
}

/**
 * How many claims each waiting lane shows under the view's filters — the figure on its tab. Owner,
 * 23 Nov 2026, October picked: "I can see nothing. The tab are empty … Of course, there's something
 * wrong." The tabs went on saying "Ready (15) · Your call (51)" over two empty lists, because they
 * counted every waiting claim; a tab now counts what pressing it will show.
 */
export function filteredLaneCounts(claims: ReadonlyArray<DeskClaim>, view: Pick<DeskView, "from" | "kind" | "overSevenDays" | "search" | "to">): Record<Exclude<DeskLane, "history">, number> {
  return { ready: claimsInLane(claims, "ready", view).length, your_call: claimsInLane(claims, "your_call", view).length };
}

/**
 * The lane the page opens on when the address names none: Ready when it shows a claim, else Your
 * call — each read under the filters. When neither shows one and the filters are ones History reads,
 * what they match is decided, so the page opens on History rather than on an empty list (no claim
 * with an October trip date was waiting on 23 Nov 2026; all 116 were decided).
 * `claims` is null while the page has not read them yet.
 */
export function openingLane(view: DeskView, claims: ReadonlyArray<DeskClaim> | null): DeskLane {
  if (view.lane) return view.lane;
  if (!claims) return "your_call";
  const counts = filteredLaneCounts(claims, view);
  if (counts.ready > 0) return "ready";
  if (counts.your_call > 0) return "your_call";
  return narrowsHistory(view) ? "history" : "your_call";
}

/** "Meeting claims with a trip day in October 2026 named “Wesam”" — what the filters ask for, in words. */
export function filterWords(view: Pick<DeskView, "from" | "kind" | "search" | "to">): string {
  const parts = [view.kind ? `${CLAIM_KIND_LABEL[view.kind]} claims` : "claims"];
  const period = tripPeriodOf(view.from, view.to);
  const words = periodWords(period);
  if (period.from && period.to) parts.push(period.from === period.to ? `on ${words}` : periodMonth(period) ? `with a trip day in ${words}` : `with a trip day from ${words}`);
  else if (period.from || period.to) parts.push(`with a trip day ${period.from ? "from " : ""}${words}`);
  const search = view.search.trim();
  if (search) parts.push(`for “${search}”`);
  return parts.join(" ");
}

/**
 * What an empty waiting lane says when the filters left it empty. `decided` is how many decided
 * claims the same filters match (History's own count), or null while it is read or could not be.
 * The page never leaves an empty list without saying where the claims went.
 */
export function emptyLaneWords(view: Pick<DeskView, "from" | "kind" | "overSevenDays" | "search" | "to">, decided: number | null): { history: boolean; message: string; title: string } {
  const asked = filterWords(view);
  if (!narrowsHistory(view) || decided === null) {
    return { history: false, message: "Nothing in this lane matches the search and the filters. Clear them to see every waiting claim.", title: "Nothing matches" };
  }
  if (decided > 0) {
    return {
      history: true,
      message: `No waiting ${asked}${view.overSevenDays ? ", over 7 days," : ""} are in this lane. ${decided === 1 ? "The 1 already decided is" : `The ${formatCount(decided)} already decided are`} in History.`,
      title: `${formatCount(decided)} in History`,
    };
  }
  return { history: false, message: `No ${asked}, waiting or decided. Clear the filters to see every waiting claim.`, title: "Nothing matches" };
}

const formatCount = (value: number) => value.toLocaleString("en-US");

const fold = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

/** The claims a waiting lane shows: its lane, the search (name, places), "over 7 days", the kind and the trip dates. Oldest first, as sent. */
export function claimsInLane(
  claims: ReadonlyArray<DeskClaim>,
  lane: Exclude<DeskLane, "history">,
  view: Pick<DeskView, "overSevenDays" | "search"> & { from?: string | null; kind?: ClaimKind | null; to?: string | null },
  hidden: ReadonlySet<number> = new Set(),
): DeskClaim[] {
  const words = fold(view.search).split(/\s+/).filter(Boolean);
  const period = tripPeriodOf(view.from, view.to);
  return claims.filter((claim) => {
    if (claim.standing !== "waiting" || claim.verdict.lane !== lane || hidden.has(claim.requestId)) return false;
    if (view.overSevenDays && claim.daysWaiting <= 7) return false;
    if (view.kind && claim.kind !== view.kind) return false;
    if (!claimInPeriod(claim, period)) return false;
    if (words.length === 0) return true;
    const text = fold(`${claim.employeeName} ${claim.from} ${claim.to} ${claim.employeeRole ?? ""}`);
    return words.every((word) => text.includes(word));
  });
}

/** "Today", "1 day", "9 days" — how long a claim has waited. */
export function waitLabel(days: number): string {
  if (!(days >= 1)) return "Today";
  return days === 1 ? "1 day" : `${Math.floor(days)} days`;
}

/** Whole days of the trip, first to last inclusive, from the dates' own text. */
export function tripDayCount(claim: Pick<DeskClaim, "tripEnd" | "tripStart">): number {
  const start = Date.parse(`${claim.tripStart.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${claim.tripEnd.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * What Approve sends for one waiting claim. With idle days and an allowance the button names the cut
 * and sends it; a trip the payroll gate would hold cannot carry a reduced amount, so there the
 * button pays the claim in full and the row says why. `full: true` is "Keep full claim".
 *
 * 🔴 Paying an idle day in full is always SAID: wherever the page knows of a cut and the press does
 * not send it, the press carries `keepFull`. A press with neither an amount nor `keepFull` is paid
 * in full only while the server finds no cut either (decision-plan.ts), so a page read before the
 * field work was can never pay an idle day by its silence.
 */
export function approvePress(claim: DeskClaim, options: { full?: boolean } = {}): DeskDecisionRequest {
  const cut = !options.full && claim.preCut && !claim.holdReason ? claim.preCut : null;
  return {
    action: "approve",
    ...(cut ? { approvedAmount: cut.payable } : {}),
    ...(!cut && claim.preCut ? { keepFull: true } : {}),
    requestId: claim.requestId,
    revision: claim.revision,
  };
}

/** What the amount box beside Approve opens with: what Approve pays untouched. Pure. */
export function defaultAmountText(claim: DeskClaim): string {
  const cut = claim.preCut && !claim.holdReason ? claim.preCut : null;
  return String(money(cut ? cut.payable : claim.total));
}

export type AmountPress = { decision: DeskDecisionRequest; error: null; figure: number } | { decision: null; error: string; figure: number | null };

const amountWords = (value: number) => `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * Approve at the amount typed in the box beside it (owner, 23 Nov 2026: "make me able to edit in the
 * value, make it as it is or decrease it, or if you decided that it should be decreased, make me able
 * to edit it"). Every waiting claim's box opens on what Approve pays — the claim, or the idle-day cut
 * the system offered — and the one press pays what the box says:
 *
 *   - the claim itself (within half a pound) → Approve in full, "Keep full claim" said out loud
 *     wherever a cut was offered, so the server never reads it as a stale page;
 *   - exactly the system's cut → that cut, the same press the untouched button sends;
 *   - any other figure below the claim → a reduced amount, its reason the sentence of what he set,
 *     never sent to the employee (a reduced amount is not told);
 *   - more than the claim, nothing, zero, or a lower figure on a trip the payroll gate would hold →
 *     no press, and the words why. The server refuses all of those again (decision-plan.ts).
 *
 * Pure: it builds the press, the page sends it.
 */
export function amountPress(claim: DeskClaim, text: string): AmountPress {
  const figure = typedAmount(text);
  if (figure === null) return { decision: null, error: "Type the amount to pay. To pay nothing, reject the claim.", figure: null };
  const amount = money(figure);
  if (amount > claim.total + 0.005) return { decision: null, error: `More than the claim (${amountWords(claim.total)}).`, figure: amount };
  if (Math.abs(amount - claim.total) <= 0.5) return { decision: approvePress(claim, { full: true }), error: null, figure: claim.total };
  const cut = claim.preCut && !claim.holdReason ? claim.preCut : null;
  if (cut && Math.abs(cut.payable - amount) <= 0.005) return { decision: approvePress(claim), error: null, figure: cut.payable };
  const blocked = reduceBlocked(claim);
  if (blocked) return { decision: null, error: blocked, figure: amount };
  const offered = cut ? ` The system offered ${amountWords(cut.payable)} for the idle days.` : "";
  return {
    decision: {
      action: "reduce",
      approvedAmount: amount,
      comment: `Amount set to ${amountWords(amount)} of the ${amountWords(claim.total)} claimed.${offered}`,
      requestId: claim.requestId,
      revision: claim.revision,
    },
    error: null,
    figure: amount,
  };
}

/**
 * Approve on a claim that was REJECTED (History, and its opened trip): the claim in full. It names
 * no amount and never the idle-day cut, which is read for a waiting claim only, and the server
 * refuses an approval of a rejected claim that names one (`decided-change.ts`).
 */
export function approveRejectedPress(claim: DeskClaim): DeskDecisionRequest {
  return { action: "approve", requestId: claim.requestId, revision: claim.revision };
}

/**
 * True on the one waiting claim whose own Approve pays an idle day in full: the trip has an idle
 * day and an allowance, and the payroll gate would hold it, so it cannot carry the cut. Its row
 * says so and he may still press it — but no batch sends it (owner, 2026-11-07: a batch approve
 * holds such a trip back to be opened).
 */
export function paysIdleDayInFull(claim: DeskClaim): boolean {
  return claim.standing === "waiting" && claim.preCut !== null && claim.holdReason !== null;
}

/**
 * What "Approve all" in the Ready lane sends, and the two figures it shows before the press. A Ready
 * claim has no idle day, so it carries no cut — but the batch still sends each row's OWN Approve,
 * never "Keep full claim", and leaves out a trip whose own Approve would pay an idle day in full:
 * no batch can pay an idle day in full, whatever lane it was built from.
 */
export function readyBatch(claims: ReadonlyArray<DeskClaim>, limit: number): { count: number; decisions: DeskDecisionRequest[]; left: number; value: number } {
  const sendable = claims.filter((claim) => !paysIdleDayInFull(claim));
  const taken = sendable.slice(0, Math.max(0, limit));
  return {
    count: taken.length,
    decisions: taken.map((claim) => approvePress(claim)),
    left: sendable.length - taken.length,
    value: money(taken.reduce((sum, claim) => sum + approvePays(claim), 0)),
  };
}

/** What a waiting claim's own Approve pays: the idle-day cut where the button names one, else the claim. */
export function approvePays(claim: DeskClaim): number {
  return claim.preCut && !claim.holdReason ? claim.preCut.payable : claim.total;
}

export type DeskSelection = {
  /** "Approve N": each ticked row's OWN Approve — a cut named on a row is the cut that is paid. */
  approve: DeskDecisionRequest[];
  /** Every ticked claim in this press — what "Reject N" covers (a rejection pays nothing). */
  claims: DeskClaim[];
  count: number;
  /** Ticked beyond one request's limit; they stay ticked for the next press. */
  left: number;
  /** Ticked, but left out of "Approve N": approving one pays an idle day in full, so it is opened. */
  needsOpening: DeskClaim[];
  /** What "Approve N" pays in all. */
  value: number;
};

/**
 * The ticked rows of a waiting lane, as one press. Only a claim still waiting on screen counts: a
 * tick on a claim that was decided, or left the lane, is forgotten rather than sent. A batch never
 * pays an idle day in full — it sends what each row's own Approve button says, and a trip whose
 * button would pay an idle day in full is held back and named, to be opened.
 */
export function selectionBatch(claims: ReadonlyArray<DeskClaim>, ticked: ReadonlySet<number>, limit: number): DeskSelection {
  const chosen = claims.filter((claim) => claim.standing === "waiting" && ticked.has(claim.requestId));
  const taken = chosen.slice(0, Math.max(0, limit));
  const sendable = taken.filter((claim) => !paysIdleDayInFull(claim));
  return {
    approve: sendable.map((claim) => approvePress(claim)),
    claims: taken,
    count: taken.length,
    left: chosen.length - taken.length,
    needsOpening: taken.filter(paysIdleDayInFull),
    value: money(sendable.reduce((sum, claim) => sum + approvePays(claim), 0)),
  };
}

/** What "Reject N" sends: every ticked claim with the ONE written reason. Nothing without a reason. */
export function rejectSelection(claims: ReadonlyArray<DeskClaim>, reason: string): DeskDecisionRequest[] {
  const comment = reason.trim();
  if (!comment) return [];
  return claims.map((claim) => ({ action: "reject" as const, comment, requestId: claim.requestId, revision: claim.revision }));
}

/**
 * Every check that did not pass, other than the one whose sentence the row already wears: the ones
 * that FAILED, and the ones that could not be made. A row prints them as tags; a phone card prints
 * them as one line (five tags stacked made a card 300 px tall, measured at 375 on 23 Nov 2026).
 */
export function otherFindings(claim: Pick<DeskClaim, "verdict">): { failed: string[]; notChecked: string[] } {
  const others = claim.verdict.checks.filter((check) => check.answer !== "pass" && check.sentence !== claim.verdict.reason);
  return {
    failed: others.filter((check) => check.answer === "fail").map((check) => check.label),
    notChecked: others.filter((check) => check.answer !== "fail").map((check) => check.label),
  };
}

export type ReasonChip = { key: string; label: string; text: string };

/**
 * The reasons offered as one-press chips, for a rejection or a reduced amount. Built only from a
 * check that FAILED on this claim. A claim with no failed check gets no chip: the reason is typed.
 */
export function reasonChips(claim: DeskClaim): ReasonChip[] {
  const failed = new Map(claim.verdict.checks.filter((check) => check.answer === "fail").map((check) => [check.key, check]));
  const chips: ReasonChip[] = [];
  const idle = claim.verdict.idleDates.length;
  const days = tripDayCount(claim);
  if (failed.has("field_work") && idle > 0) {
    chips.push(
      idle >= days
        ? {
            key: "no-activity",
            label: "No field activity",
            text: days > 1 ? `No field activity was recorded on any of the ${days} days of this trip.` : "No field activity was recorded on the day of this trip.",
          }
        : { key: "idle-days", label: "Idle days", text: `${idle} of the ${days} days of this trip had no field activity.` },
    );
  }
  const duplicate = failed.get("duplicate");
  if (duplicate) chips.push({ key: "duplicate", label: "Already claimed", text: `This trip was already claimed. ${duplicate.sentence}` });
  if (failed.has("route")) {
    chips.push({ key: "route", label: "Not at the destination", text: "The field work recorded on this trip was not at the claimed destination." });
  }
  if (failed.has("arrival_photo")) {
    chips.push({ key: "arrival-photo", label: "Arrival photo", text: "The arrival photo is missing or did not pass its check." });
  }
  if (failed.has("departure_photo")) {
    chips.push({ key: "departure-photo", label: "Departure photo", text: "The departure photo is missing or did not pass its check." });
  }
  if (failed.has("ticket")) chips.push({ key: "ticket", label: "No ticket", text: "No ticket was attached to this trip." });
  if (failed.has("meeting_day")) chips.push({ key: "meeting-day", label: "Not a Thursday", text: "The meeting on this claim was not held on a Thursday." });
  if (failed.has("amounts")) chips.push({ key: "invoice", label: "No invoice", text: "No invoice or picture was attached to this cost." });
  return chips;
}

/** What is said before a Reduce press is offered at all; null when the claim can be reduced. */
export function reduceBlocked(claim: DeskClaim): string | null {
  if (claim.locked) return "A payroll has already taken this trip.";
  if (claim.standing !== "waiting") return "This claim was already decided.";
  if (claim.holdReason) {
    return "This trip would be held out of payroll for now, and a held trip cannot carry a reduced amount.";
  }
  return null;
}

/** "2,430.50" typed by a person, as a figure; null when it is not one. */
export function typedAmount(value: string): number | null {
  const text = value.replace(/[,\s]/g, "").replace(/^egp/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const parsed = Number(text);
  return parsed > 0 ? parsed : null;
}

/**
 * The page after the server answered. `sent` is each claim as it was on screen when it was pressed,
 * with the press. A claim that landed leaves the waiting list and moves between tiles; one that was
 * refused or had changed is put back as the server now reads it. Tiles never go below zero.
 */
export function applyDeskOutcomes(
  queue: DeskQueue,
  outcomes: ReadonlyArray<DeskDecisionOutcome>,
  sent: ReadonlyArray<{ action: DecisionAction; claim: DeskClaim }>,
): DeskQueue {
  const before = new Map(sent.map((entry) => [entry.claim.requestId, entry]));
  const tiles = Object.fromEntries(TRIP_STANDINGS.map((key) => [key, { ...queue.tiles[key] }])) as DeskQueue["tiles"];
  const agreement = { ...queue.agreement, ready: { ...queue.agreement.ready }, yourCall: { ...queue.agreement.yourCall } };
  const claims = new Map(queue.claims.map((claim) => [claim.requestId, claim]));
  const order = queue.claims.map((claim) => claim.requestId);

  const move = (from: { payable: number; standing: TripStanding }, to: { payable: number; standing: TripStanding }) => {
    tiles[from.standing].count = Math.max(0, tiles[from.standing].count - 1);
    if (from.standing !== "rejected") tiles[from.standing].value = Math.max(0, money(tiles[from.standing].value - from.payable));
    tiles[to.standing].count += 1;
    if (to.standing !== "rejected") tiles[to.standing].value = money(tiles[to.standing].value + to.payable);
  };

  for (const outcome of outcomes) {
    const was = before.get(outcome.requestId);
    const now = outcome.claim;
    if (!was || !now) continue;
    move(was.claim, now);
    if (now.standing === "waiting") {
      claims.set(now.requestId, now);
      if (!order.includes(now.requestId)) order.push(now.requestId);
    } else {
      claims.delete(now.requestId);
    }
    if (outcome.code === "saved" && was.claim.standing === "waiting") {
      const bucket = was.claim.verdict.lane === "ready" ? agreement.ready : agreement.yourCall;
      bucket.decided += 1;
      if (was.action === "approve") bucket.approved += 1;
    }
  }

  const list = order.map((id) => claims.get(id)).filter((claim): claim is DeskClaim => Boolean(claim));
  return { ...queue, agreement, claims: list, overSevenDays: list.filter((claim) => claim.daysWaiting > 7).length, tiles };
}

/** The top line: how many decisions wait, what they are worth, how many are old. One unit, one function. */
export function deskTopLine(queue: Pick<DeskQueue, "overSevenDays" | "tiles">): { count: number; overSevenDays: number; value: number } {
  return { count: queue.tiles.waiting.count, overSevenDays: queue.overSevenDays, value: queue.tiles.waiting.value };
}

/** What the Undo bar says about a press that has not been sent yet. */
export function pressLabel(decisions: ReadonlyArray<DeskDecisionRequest>, claims: ReadonlyArray<DeskClaim>): string {
  if (decisions.length > 1) {
    // A batch says what was done to it — "approved" over a batch of rejections would be a lie
    // sitting beside the Undo button.
    const word = decisions.every((one) => one.action === "reject") ? "rejected" : decisions.every((one) => one.action !== "reject") ? "approved" : "decided";
    return `${decisions.length} claims ${word}`;
  }
  const [decision] = decisions;
  const name = claims.find((claim) => claim.requestId === decision?.requestId)?.employeeName ?? "The claim";
  if (decision?.action === "reject") return `${name}: rejected`;
  if (decision?.action === "reduce") return `${name}: reduced`;
  return `${name}: approved`;
}
