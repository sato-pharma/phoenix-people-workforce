/**
 * Phoenix CRM — what a manager sees on each customer while he plans his week (owner, 2026-10-23: "group the
 * customers, give every customer a highlight color … take the concept from me and upgrade it").
 *
 * On the manager's plan board — With a rep and Single visit — every customer of a rep's list carries:
 *   - his GRADE, as the colour of the card's edge (A, B, C);
 *   - the rep's visits THIS MONTH against the grade's monthly number, as pips: two filled of three is
 *     "2 of 3". Over the number is a deviation too, never a bonus (the owner's standing frequency rule),
 *     so a pip past the number is drawn apart;
 *   - whether the MANAGER himself has seen him this month — with this rep (the rep's double, chain or
 *     product-manager visit naming him, `countsAsPlannersVisitWithRep`) and on his own single visits;
 *   - a live MARKETING REQUEST on him, which opens that request;
 *   - and the features a group of the shown customers share that the rest do not ("4 Pediatrics",
 *     "3 in Smouha", "5 behind on frequency"), each a chip that colours its group when pressed.
 *
 * 🔴 IT IS THE MANAGER'S SCREEN ONLY. The rep never sees any of it (Golden rule #1 — the rep's app is blind),
 * and nothing here is a KPI: the visit count is the one the rep's own List already shows him beside his grade
 * norm (`loadMonthVisitCounts`), read the same way.
 *
 * Pure: no database, no React.
 */

import type { PhoenixCrmDoctorListType, PhoenixCrmGrade } from "@/lib/phoenix-crm/types";

/** One live marketing request on a customer. `byName`: matched by the customer's name on the requester's own list. */
export type CustomerMarketingMark = {
  requestId: string;
  code: string;
  status: string;
  statusLabel: string;
  typeName: string | null;
  byName: boolean;
};

export type CustomerInsight = {
  grade: PhoenixCrmGrade | null;
  listType: PhoenixCrmDoctorListType | null;
  /** The grade's monthly number for his list type; null when he has no grade or the company set none. */
  target: number | null;
  /** The rep's visits this month that count (`phoenix_crm_countable_visits`), through today. */
  repVisits: number;
  /** The last of those, or null. */
  lastRepVisit: string | null;
  /** Of those, the ones that named this manager — with him. */
  withYou: number;
  /** His own single visits to this customer this month. */
  yourOwn: number;
  /** The pharmacy the customer is listed with, for the "share a pharmacy" group. */
  pharmacy: string | null;
  marketing: CustomerMarketingMark[];
};

export type CustomerInsightView = {
  /** "2026-10" — the month of the day he is planning. */
  month: string;
  /** "October" */
  monthName: string;
  /** The month is not open yet (a planned day of next month): nothing is counted in it so far. */
  monthAhead: boolean;
  /** Keyed by the rep-list customer id, and "m:<id>" for a customer of Manager's own list. */
  insights: Record<string, CustomerInsight>;
};

/** The statuses a request is live in — waiting or running. Rejected, cancelled, closed and drafts are not shown. */
export const LIVE_MARKETING_STATUSES: ReadonlyArray<string> = ["pending_validation", "pending_approval", "returned", "finance_hold", "approved", "active", "roi_tracking"];

export function ownInsightKey(managerCustomerId: string): string {
  return `m:${managerCustomerId}`;
}

// ── Frequency ───────────────────────────────────────────────────────────────────────────────────

export type FrequencyStanding = "none" | "behind" | "on" | "over";

export function frequencyStanding(visits: number, target: number | null): FrequencyStanding {
  if (target === null || target <= 0) return "none";
  if (visits < target) return "behind";
  return visits === target ? "on" : "over";
}

export type FrequencyPip = "done" | "due" | "over";

/** At most this many pips are drawn; the rest is written as "+n". */
export const FREQUENCY_PIPS_MAX = 6;

/**
 * One pip per visit owed: filled for each made, open for each still due, and the ones past the number apart.
 * With no number to owe (no grade, or none set), every visit is simply a filled pip — never "over".
 */
export function frequencyPips(visits: number, target: number | null): { pips: FrequencyPip[]; more: number } {
  const owed = target !== null && target > 0 ? target : 0;
  const all: FrequencyPip[] = [];
  for (let index = 0; index < Math.max(visits, owed); index += 1) {
    all.push(owed === 0 || index < owed ? (index < visits ? "done" : "due") : "over");
  }
  return { pips: all.slice(0, FREQUENCY_PIPS_MAX), more: Math.max(0, all.length - FREQUENCY_PIPS_MAX) };
}

/** "2 of 3 in October" · "4 of 3 in October — 1 over" · "1 visit in October" · "No visits in October yet". */
export function frequencyText(visits: number, target: number | null, monthName: string): string {
  const standing = frequencyStanding(visits, target);
  if (standing === "none") return visits === 0 ? `No visits in ${monthName} yet` : `${visits} ${visits === 1 ? "visit" : "visits"} in ${monthName}`;
  const base = `${visits} of ${target} in ${monthName}`;
  return standing === "over" ? `${base} — ${visits - (target ?? 0)} over` : base;
}

// ── Who to go with first ────────────────────────────────────────────────────────────────────────

const GRADE_WEIGHT: Record<PhoenixCrmGrade, number> = { A: 3, B: 2, C: 1 };

/**
 * How much a customer is worth his half-day now — the order the list offers him in. The grade first, then
 * the visits still owed this month, then a live marketing request (money already on him), then whether the
 * manager has not seen him yet. A customer over his number goes down: more visits there is a deviation.
 */
export function customerPriority(insight: CustomerInsight | undefined): number {
  if (!insight) return 0;
  const grade = insight.grade ? GRADE_WEIGHT[insight.grade] : 0;
  const owed = insight.target !== null ? Math.max(0, insight.target - insight.repVisits) : 0;
  const standing = frequencyStanding(insight.repVisits, insight.target);
  let score = grade * 2 + owed * 2;
  if (insight.marketing.length > 0) score += 3;
  if (insight.withYou + insight.yourOwn === 0) score += 1;
  if (standing === "over") score -= 3;
  return score;
}

/** At most this many customers of one list are marked "Go first". */
export const SUGGESTED_MAX = 3;

/**
 * The few customers to go to first: the highest priority, but only one who is behind his number or carries a
 * live marketing request — a customer already on his number is never "suggested" just for his grade.
 */
export function suggestedCustomers(ids: ReadonlyArray<string>, insights: Record<string, CustomerInsight>): Set<string> {
  const candidates = ids.filter((id) => {
    const insight = insights[id];
    return Boolean(insight) && (frequencyStanding(insight.repVisits, insight.target) === "behind" || insight.marketing.length > 0);
  });
  candidates.sort((left, right) => customerPriority(insights[right]) - customerPriority(insights[left]));
  return new Set(candidates.slice(0, SUGGESTED_MAX));
}

// ── What a group of them share ─────────────────────────────────────────────────────────────────

export type CustomerGroupTone = "violet" | "rose" | "amber" | "emerald" | "sky" | "teal" | "indigo" | "slate";

export type CustomerGroup = { key: string; label: string; ids: string[]; tone: CustomerGroupTone; hint: string };

export type GroupableCustomer = { id: string; speciality: string | null; place: string | null; pharmacy: string | null };

/** A shared speciality or place is offered as a group only when at least this many share it. */
export const SHARED_FEATURE_MIN = 3;
/** And at most this many of each kind, the biggest first. */
const SHARED_FEATURE_MAX = 3;

function sharedValueGroups(
  customers: ReadonlyArray<GroupableCustomer>,
  valueOf: (customer: GroupableCustomer) => string | null,
  prefix: string,
  tone: CustomerGroupTone,
  hint: (value: string) => string,
): CustomerGroup[] {
  const byValue = new Map<string, { label: string; ids: string[] }>();
  for (const customer of customers) {
    const raw = valueOf(customer)?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const entry = byValue.get(key) ?? { label: raw, ids: [] };
    entry.ids.push(customer.id);
    byValue.set(key, entry);
  }
  return [...byValue.entries()]
    // A feature every one of them shares tells him nothing about any of them.
    .filter(([, entry]) => entry.ids.length >= SHARED_FEATURE_MIN && entry.ids.length < customers.length)
    .sort((left, right) => right[1].ids.length - left[1].ids.length || left[1].label.localeCompare(right[1].label))
    .slice(0, SHARED_FEATURE_MAX)
    .map(([key, entry]) => ({ key: `${prefix}:${key}`, label: entry.label, ids: entry.ids, tone, hint: hint(entry.label) }));
}

/**
 * The groups the shown customers fall into, each a chip that colours its customers. The fixed ones the owner
 * named (a marketing request, his own visits, the frequency), then the features the system found a group
 * of them sharing — a speciality, a brick or a pharmacy — that the others do not. An empty group is never offered.
 */
export function customerGroups(customers: ReadonlyArray<GroupableCustomer>, insights: Record<string, CustomerInsight>, monthName: string): CustomerGroup[] {
  const pick = (test: (insight: CustomerInsight) => boolean) => customers.filter((customer) => insights[customer.id] && test(insights[customer.id])).map((customer) => customer.id);
  const standing = (insight: CustomerInsight) => frequencyStanding(insight.repVisits, insight.target);
  const fixed: CustomerGroup[] = [
    { key: "marketing", label: "Marketing request", ids: pick((insight) => insight.marketing.length > 0), tone: "violet", hint: "A live marketing request stands on these customers." },
    { key: "behind", label: "Behind on frequency", ids: pick((insight) => standing(insight) === "behind"), tone: "rose", hint: `Fewer visits than their grade asks for in ${monthName}.` },
    {
      key: "unseen",
      label: `Not seen in ${monthName}`,
      ids: pick((insight) => insight.repVisits === 0 && standing(insight) !== "none"),
      tone: "amber",
      hint: `The rep has not visited them in ${monthName} yet.`,
    },
    { key: "with-you", label: `Seen by you in ${monthName}`, ids: pick((insight) => insight.withYou + insight.yourOwn > 0), tone: "emerald", hint: "You visited them this month, with the rep or alone." },
    { key: "over", label: "Over frequency", ids: pick((insight) => standing(insight) === "over"), tone: "slate", hint: "More visits than their grade asks for — a deviation too." },
  ];
  return [
    ...fixed.filter((group) => group.ids.length > 0),
    ...sharedValueGroups(customers, (customer) => customer.speciality, "speciality", "sky", (value) => `The ${value} customers on this list.`),
    ...sharedValueGroups(customers, (customer) => customer.place, "place", "teal", (value) => `The customers in ${value}.`),
    ...sharedValueGroups(customers, (customer) => customer.pharmacy, "pharmacy", "indigo", (value) => `The customers listed with ${value} — one stop can serve them together.`),
  ];
}

/** "Go first" reasons, in a few words: why this customer is suggested. */
export function suggestionReason(insight: CustomerInsight): string {
  const parts: string[] = [];
  if (insight.grade) parts.push(`Grade ${insight.grade}`);
  if (insight.target !== null && insight.repVisits < insight.target) parts.push(`${insight.target - insight.repVisits} visit${insight.target - insight.repVisits === 1 ? "" : "s"} owed`);
  if (insight.marketing.length > 0) parts.push("marketing request");
  if (insight.withYou + insight.yourOwn === 0) parts.push("not seen by you yet");
  return parts.join(" · ");
}
