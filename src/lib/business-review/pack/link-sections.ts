// The Sales Review pack — the sections that lay the field work beside the money.
//
// Owner, 2026-10-01: "in the business review I want to add in the exported data matching the real
// work they do — every brick, how many class A doctors and I visited how many, vs this area or brick
// sales … if a DM over-focused some MRs in double visits and forgot others … link them together to
// do a real professional business review yet simple to understand, built on maturity level: a
// medical rep's BR must show all data but simple and easy for him to understand."
//
// MATURITY IS THE WORDING, NEVER THE DATA. A medical rep gets every figure his own territory can
// answer — the same numbers his district manager reads about him — but in short plain sentences
// that say "you", with the caveats a manager needs cut to what the rep can act on. A manager's pack
// carries the full analytical note. `plainForRep` below does the same for the sections that existed
// before this change, so a rep's whole pack reads in one voice.
//
// EVERY FIGURE HERE COMES FROM field-link.ts, which computes and never words; this file words and
// never computes a number of its own beyond a share or a per-day division of two figures it was
// handed. The one-page summary is built from the SAME builder results as the sections after it, so
// a sentence on page one cannot disagree with the table it summarises.
//
// NAMES, NEVER CODES OR IDS (owner's standing rule). A leaver keeps his rows and his "(left …)" mark,
// which the renderers colour red; a leaver's name is never put inside a sentence, where no renderer
// could colour it.

import {
  PHARMACIES_IREPORTS360_ONLY,
  PHARMACIES_NOT_RECORDED_IN_PHOENIX,
  PHOENIX_LOGS_NO_PHARMACY_VISIT,
  emptyVisitCountSplit,
  formatVisitCountSplit,
  mergeVisitCountSplits,
  pharmacyFigureText,
  pharmacyRecordingOf,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";

import { isResignedStatus, leaverLabel } from "../employment-status";
import {
  BRICK_READING_LABEL,
  BRICK_READING_RULES,
  DV_FOCUS_LABEL,
  DV_FOCUS_RULES,
  LIST_HISTORY_FROM,
  buildBrickWork,
  buildDvFocus,
  buildMissedClassA,
  costPerWork,
  directOrderTotals,
  dvPatternSentence,
  listReach,
  repFieldSummary,
  rideDaysReceived,
  sharePct,
  spendPerThousand,
  splitTotal,
  type BrickWork,
  type DvFocusManager,
  type FieldLinkFacts,
  type ListedContact,
  type MissedContactRow,
  type ReachCount,
} from "../field-link";
import { periodColumnLabel, periodLabel, periodMonthEnd } from "../period-format";
import { kpiSummaryRows } from "./kpi-sections";
import { deltaPct, formatDelta } from "../previous-window";
import type { ReviewPersonRow } from "../sources/roles";
import type { PackLevel, ReviewMetricId } from "./metrics";
import type { PackAlign, PackArea, PackCell, PackInput, PackSection } from "./model";
import { sumSlices } from "./slices";

// ─────────────────────────────────────────────────────────────── formatting ──

const num = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const whole = (value: number) => Math.round(num(value));
const egp = (value: number) => `EGP ${whole(value).toLocaleString("en-US")}`;
const pct0 = (value: number | null) => (value == null ? "—" : `${value.toFixed(0)}%`);
const pct1 = (value: number | null) => (value == null ? "not gradeable" : `${value.toFixed(1)}%`);
const reachCell = (reach: ReachCount) => (reach.listed === 0 ? "—" : `${reach.reached} of ${reach.listed}`);
const reachPct = (reach: ReachCount) => sharePct(reach.reached, reach.listed);

// ── PHOENIX CRM LOGS NO PHARMACY VISIT (src/lib/crm/visit-count-buckets.ts) ──
// From a team's start its visits come from Phoenix CRM, where a pharmacy is feedback on a doctor's
// visit and never a visit of its own. So a Pharmacies figure built from those visits is not a zero —
// it was never recorded — and beside iReports360 visits it counts the iReports360 visits alone.

/**
 * Listed pharmacies reached, judged by the visits behind them: "not recorded in Phoenix" when every one
 * is Phoenix CRM's (never "0 of 12"), "3 of 12 (iReports360 only)" beside iReports360 visits.
 */
const pharmacyReachCell = (reach: ReachCount, visits: VisitCountSplit) => {
  const recording = pharmacyRecordingOf(visits);
  if (reach.listed === 0 || recording === "recorded") return reachCell(reach);
  if (recording === "not-recorded" && reach.reached === 0) return PHARMACIES_NOT_RECORDED_IN_PHOENIX;
  return `${reachCell(reach)} ${PHARMACIES_IREPORTS360_ONLY}`;
};

/**
 * A pack table's Pharmacies cell: the figure; BLANK — never 0 — when every visit behind it is Phoenix
 * CRM's; or "2 (iReports360 only)" beside iReports360 visits. `fromVisits` judges a customer count by the
 * visits it was counted from.
 */
export function pharmacyCell(split: VisitCountSplit, fromVisits?: VisitCountSplit | null): PackCell {
  const recording = pharmacyRecordingOf(split, fromVisits);
  if (recording === "recorded") return num(split.pharmacies);
  return recording === "not-recorded" ? null : pharmacyFigureText(split, { fromVisits });
}

/** Said under a table that carries a blank or a qualified Pharmacies cell — the outstation export's rule. */
export const PHARMACY_PACK_NOTE =
  `A blank Pharmacies figure (— on the page) is ${PHARMACIES_NOT_RECORDED_IN_PHOENIX}, never 0: ` +
  `${PHOENIX_LOGS_NO_PHARMACY_VISIT}, a pharmacy there is feedback on a doctor's visit. Beside Phoenix CRM ` +
  `visits the figure counts the iReports360 visits only ${PHARMACIES_IREPORTS360_ONLY}.`;

/** The section note, with {@link PHARMACY_PACK_NOTE} when any of its Pharmacies figures needed it. */
export function withPharmacyNote(note: string, splits: ReadonlyArray<readonly [VisitCountSplit, (VisitCountSplit | null)?]>): string {
  const needed = splits.some(([split, fromVisits]) => pharmacyRecordingOf(split, fromVisits) !== "recorded");
  return needed ? `${note} ${PHARMACY_PACK_NOTE}` : note;
}
const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const count0 = (value: number) => value.toLocaleString("en-US");

/** "12 Jul 2026", in the only calendar the owner reads — a DATE carries no time, so no zone shifts it. */
function dayLabel(iso: string | null): string {
  if (!iso) return "No visit on record";
  const when = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" }).format(when);
}

const REQUEST_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  approved: "Approved",
  archived: "Archived",
  cancelled: "Cancelled",
  closed: "Closed",
  draft: "Draft",
  executed: "Held",
  finance_hold: "Held by Finance",
  on_hold: "On hold",
  pending_approval: "Waiting for approval",
  pending_ceo: "Waiting for the CEO",
  pending_group: "Waiting for approval",
  pending_validation: "Waiting for validation",
  rejected: "Refused",
  returned: "Returned for changes",
  roi_tracking: "Tracking its return",
};

/** True when the request was raised by one of the pack's own reps — on a rep's pack, by him. */
function isOwnRequest(ctx: LinkContext, requesterHrId: string): boolean {
  return ctx.reps.includes(requesterHrId.trim().toUpperCase());
}

function statusLabel(status: string): string {
  return REQUEST_STATUS_LABEL[status] ?? (status ? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");
}

// ─────────────────────────────────────────────────────────────── the context, computed once ──

/**
 * Everything the linked sections share, computed ONCE per pack so the summary and the tables read
 * the same builder results.
 */
export type LinkContext = {
  facts: FieldLinkFacts;
  level: PackLevel;
  isRep: boolean;
  months: string[];
  reps: string[];
  multiLine: boolean;
  personByHr: Map<string, ReviewPersonRow>;
  /** Null below district level, or when the closing's brick rows were not read. */
  bricks: BrickWork | null;
  missed: MissedContactRow[];
  dv: DvFocusManager[];
  /** The rep's own district manager, on a rep's pack. */
  ownManagerHrId: string | null;
};

export function buildLinkContext(input: PackInput): LinkContext | null {
  const facts = input.fieldLink ?? null;
  if (!facts) return null;
  const level = input.subject.level;
  const isRep = level === "rep";
  const months = facts.months.length > 0 ? [...facts.months] : [...input.months];
  const reps = [...facts.repHrIds];
  const personByHr = new Map(input.people.map((person) => [person.hrId.toUpperCase(), person]));
  const closeUp = level === "rep" || level === "district";

  const bricks =
    closeUp && input.brickSales
      ? buildBrickWork({
          brickNames: facts.brickNames,
          contacts: facts.contacts,
          sales: input.brickSales,
          visitsByContact: facts.visitsByContact,
        })
      : null;

  const missed = closeUp
    ? buildMissedClassA({
        brickNames: facts.brickNames,
        brickOrder: bricks?.rows.map((row) => row.brickId) ?? [],
        contacts: facts.contacts,
        visitsByContact: facts.visitsByContact,
      })
    : [];

  // Teams from the pack's own areas — the seat model's reps for each district seat, only those this
  // pack's facts were read for.
  const scopeReps = new Set(reps);
  const managerBySeat = new Map(facts.managers.map((manager) => [manager.dmSeatId, manager]));
  const teamBySeat = new Map<string, Set<string>>();
  for (const area of input.areas) {
    if (!area.dmSeatId) continue;
    const team = teamBySeat.get(area.dmSeatId) ?? new Set<string>();
    for (const rep of area.repHrIds ?? []) if (scopeReps.has(rep.toUpperCase())) team.add(rep.toUpperCase());
    teamBySeat.set(area.dmSeatId, team);
  }
  const names = { ...facts.names };
  for (const [hrId, person] of personByHr) {
    names[hrId] = isResignedStatus(person.employmentStatus) ? leaverLabel(person.name, person.lastWorkingDate) : person.name;
  }
  const dv = isRep
    ? []
    : buildDvFocus({
        months,
        names,
        repDays: facts.repDays,
        rides: facts.rides,
        ridesOutside: facts.ridesOutside,
        teams: [...teamBySeat.entries()].flatMap(([dmSeatId, team]) => {
          const manager = managerBySeat.get(dmSeatId);
          return manager
            ? [{ dmSeatId, managerHrId: manager.hrId, managerName: names[manager.hrId] ?? manager.name, repHrIds: [...team] }]
            : [];
        }),
      });

  let ownManagerHrId: string | null = null;
  if (isRep) {
    const seat = input.areas.find((area) => area.dmSeatId)?.dmSeatId ?? null;
    ownManagerHrId = seat ? managerBySeat.get(seat)?.hrId ?? null : null;
  }

  return {
    bricks,
    dv,
    facts: { ...facts, names },
    isRep,
    level,
    missed,
    months,
    multiLine: input.areas.some((area) => area.lineLabel),
    ownManagerHrId,
    personByHr,
    reps,
  };
}

function nameOf(ctx: LinkContext, hrId: string): string {
  return ctx.facts.names[hrId.toUpperCase()] ?? "Unnamed employee";
}

/** The area a rep stood in — the area whose seat model lists him, else his busiest area's code. */
function areaOfRep(input: PackInput, hrId: string): PackArea | null {
  const key = hrId.toUpperCase();
  return (
    input.areas.find((area) => (area.repHrIds ?? []).some((rep) => rep.toUpperCase() === key)) ??
    input.areas.find((area) => area.areaCode != null && area.areaCode === input.people.find((p) => p.hrId.toUpperCase() === key)?.areaCode) ??
    null
  );
}

function listOfReps(ctx: LinkContext, reps: readonly string[]): ListedContact[] {
  const wanted = new Set(reps.map((rep) => rep.toUpperCase()));
  return ctx.facts.contacts.filter((contact) => wanted.has(contact.repHrId));
}

const LIST_NOTE_TAIL = (ctx: LinkContext) =>
  ctx.facts.listBeforeHistory
    ? ` Lists are dated from ${dayLabel(LIST_HISTORY_FROM)}, the first day Phoenix recorded them, so a month before that is read against the list as first recorded.`
    : "";

// ─────────────────────────────────────────────────────────────── one page ──

/**
 * The period in plain sentences — for a rep in the second person, for a manager in the third.
 * Every sentence is drawn from a builder result the later sections also print.
 */
export function summarySection(input: PackInput, ctx: LinkContext | null): PackSection | null {
  const rows: PackCell[][] = [];
  const isRep = input.subject.level === "rep";
  const subjectNoun =
    input.subject.level === "rep"
      ? input.areas.length > 1
        ? "Your areas"
        : "Your area"
      : input.subject.level === "district"
        ? "The district"
        : input.subject.level === "line"
          ? "The line"
          : "The company";

  // ── Sales, against target, and its direction ──
  const total = sumSlices(input.areas.map((area) => area.allProducts));
  if (total.sales !== 0 || total.target !== 0) {
    rows.push([
      "Sales",
      total.target > 0
        ? `${subjectNoun} sold ${egp(total.sales)} against a target of ${egp(total.target)}: ${pct1(total.ach)} achievement.`
        : `${subjectNoun} sold ${egp(total.sales)}; these months carry no target.`,
    ]);
  }
  const months = [...input.months];
  if (months.length >= 2) {
    const first = sumSlices(input.areas.map((area) => area.byMonth?.[months[0]]));
    const last = sumSlices(input.areas.map((area) => area.byMonth?.[months[months.length - 1]]));
    const change = deltaPct(last.sales, first.sales);
    if (first.sales !== 0 || last.sales !== 0) {
      rows.push([
        "Direction",
        `Monthly sales went from ${egp(first.sales)} in ${periodLabel(months[0])} to ${egp(last.sales)} in ${periodLabel(months[months.length - 1])}${change == null ? "" : ` (${formatDelta(change, "%")})`}.`,
      ]);
    }
  }

  // ── The plan and the calls — the CRM KPIs board's own figures, read whether or not the linked
  // facts were (owner, 2026-10-01: "add all three") ──
  rows.push(...kpiSummaryRows(input));

  if (ctx) {
    // ── Bricks ──
    const bricks = ctx.bricks;
    const topBrick = bricks?.rows.find((row) => row.sales > 0) ?? null;
    if (bricks && topBrick) {
      // 🔴 EVERY SENTENCE STARTS IN ENGLISH. A cell is laid out by its FIRST strong character
      // (`dir="auto"` in the PDF, the same rule in the deck), so a sentence that opens on an Arabic
      // brick name is set right-to-left and its full stop jumps to the front — measured on the first
      // real pack, 2026-10-01. The name goes INSIDE the sentence, never at its head.
      rows.push([
        "Biggest brick",
        `${pct0(topBrick.salesShare)} of the sales came from ${topBrick.brickName}; ${
          topBrick.reach.classA.listed > 0
            ? `${isRep ? "you" : "the team"} reached ${reachCell(topBrick.reach.classA)} class A doctors there.`
            : "nobody on the list is a class A doctor there."
        }`,
      ]);
      const underserved = bricks.rows.filter((row) => row.reading === "money-little-work");
      if (underserved.length > 0) {
        const lead = underserved[0];
        rows.push([
          "Money without the visits",
          underserved.length === 1
            ? `The brick ${lead.brickName} brought ${pct0(lead.salesShare)} of the sales but got ${pct0(lead.visitShare)} of the visits.`
            : `${plural(underserved.length, "brick brings", "bricks bring")} big sales with few visits — the biggest is ${lead.brickName} (${pct0(lead.salesShare)} of the sales, ${pct0(lead.visitShare)} of the visits).`,
        ]);
      }
      const unrewarded = bricks.rows.filter((row) => row.reading === "work-little-money");
      if (unrewarded.length > 0) {
        const lead = unrewarded[0];
        rows.push([
          "Visits without the money",
          `The brick ${lead.brickName} got ${pct0(lead.visitShare)} of the visits for ${pct0(lead.salesShare)} of the sales${
            unrewarded.length > 1 ? `, and ${plural(unrewarded.length - 1, "more brick reads", "more bricks read")} the same` : ""
          }.`,
        ]);
      }
    }

    // ── The team's field work — read first, because it judges the pharmacy reach below ──
    const field = ctx.reps
      .map((rep) =>
        repFieldSummary({ months: ctx.months, ownManagerHrId: ctx.ownManagerHrId, repDays: ctx.facts.repDays, repHrId: rep, rides: ctx.facts.rides }),
      )
      .reduce(
        (sum, one) => ({
          fieldDays: sum.fieldDays + one.fieldDays,
          fieldVisits: sum.fieldVisits + one.fieldVisits,
          rideDays: sum.rideDays + one.rideDays,
          rideDaysFromOwnManager: sum.rideDaysFromOwnManager + one.rideDaysFromOwnManager,
          // Merged by the golden-rule helper, so the Phoenix CRM share travels with the sum.
          split: mergeVisitCountSplits(sum.split, one.split),
        }),
        { fieldDays: 0, fieldVisits: 0, rideDays: 0, rideDaysFromOwnManager: 0, split: emptyVisitCountSplit() },
      );

    // ── Class A doctors ──
    const reach = listReach(listOfReps(ctx, ctx.reps), ctx.facts.visitsByContact);
    if (reach.classA.listed > 0) {
      rows.push([
        "Class A doctors",
        `${isRep ? "You" : "The team"} reached ${reachCell(reach.classA)} class A doctors on ${isRep ? "your" : "its"} list (${pct0(reachPct(reach.classA))}).${
          ctx.missed.length > 0 && (ctx.level === "rep" || ctx.level === "district")
            ? ` ${plural(ctx.missed.filter((row) => row.bucket === "PM").length, "was", "were")} not visited — listed by name, brick by brick, in this pack.`
            : ""
        }`,
      ]);
    }
    if (reach.am.listed > 0 || reach.pharmacies.listed > 0) {
      rows.push([
        "Accounts and pharmacies",
        `AM accounts reached: ${reachCell(reach.am)}. Pharmacies reached: ${pharmacyReachCell(reach.pharmacies, field.split)}.`,
      ]);
    }

    // ── Field work and who rode along ──
    if (field.fieldVisits > 0) {
      rows.push([
        "Field work",
        `${plural(field.fieldDays, isRep ? "field day" : "rep field day", isRep ? "field days" : "rep field days")} and ${plural(field.fieldVisits, "visit", "visits")}: ${formatVisitCountSplit(field.split)}.`,
      ]);
    }
    if (isRep) {
      rows.push([
        "Double visits",
        field.rideDays === 0
          ? "No manager rode with you in the period."
          : `A manager rode with you on ${plural(field.rideDays, "day", "days")}${
              ctx.ownManagerHrId ? ` — your district manager on ${plural(field.rideDaysFromOwnManager, "day", "days")} of them` : ""
            }.`,
      ]);
    } else if (ctx.dv.length > 0) {
      const never = ctx.dv.reduce((sum, m) => sum + m.never, 0);
      const rarely = ctx.dv.reduce((sum, m) => sum + m.rarely, 0);
      const most = ctx.dv.reduce((sum, m) => sum + m.most, 0);
      const days = ctx.dv.reduce((sum, m) => sum + m.teamRideDays, 0);
      const who = ctx.dv.length === 1 ? "The district manager" : plural(ctx.dv.length, "district manager", "district managers");
      const findings = [
        most > 0 ? `${plural(most, "rep took", "reps took")} most of the rides` : null,
        never > 0 ? `${plural(never, "rep was", "reps were")} never ridden` : null,
        rarely > 0 ? `${plural(rarely, "rep was", "reps were")} rarely ridden` : null,
      ].filter((part): part is string => part != null);
      rows.push([
        "Double visits",
        `${who} rode ${plural(days, "day", "days")} with ${ctx.dv.length === 1 ? "the team" : "their teams"}; ${
          findings.length > 0 ? findings.join(", ") : "the days were spread fairly across the reps"
        }.`,
      ]);
    }

    // ── Direct orders, requests, awareness ──
    if (ctx.facts.directOrders && ctx.facts.directOrders.length > 0) {
      const totals = directOrderTotals(ctx.facts.directOrders, ctx.months);
      rows.push([
        "Direct orders",
        `${plural(totals.booked.orders, "direct order", "direct orders")} booked for ${isRep ? "your area's" : "the area's"} pharmacies: ${egp(totals.booked.value)}${
          totals.notBooked.orders > 0 ? `; ${plural(totals.notBooked.orders, "more is", "more are")} approved and not booked yet` : ""
        }.`,
      ]);
    }
    if (ctx.facts.marketing && ctx.facts.marketing.length > 0) {
      const committed = ctx.facts.marketing.filter((request) => request.bucket === "committed");
      const cost = committed.reduce((sum, request) => sum + request.cost, 0);
      const back = committed.reduce((sum, request) => sum + num(request.returnSoFar), 0);
      const yours = ctx.facts.marketing.filter((request) => isOwnRequest(ctx, request.requesterHrId)).length;
      rows.push([
        "Marketing requests",
        isRep
          ? `${plural(ctx.facts.marketing.length, "request for your area was", "requests for your area were")} paid in the period, ${yours === 0 ? "none of them raised by you" : `${count0(yours)} raised by you`}: ${egp(cost)} committed, ${egp(back)} of sales brought back so far.`
          : `${plural(ctx.facts.marketing.length, "request was", "requests were")} paid in the period: ${egp(cost)} committed, ${egp(back)} of sales brought back so far.`,
      ]);
    }
    if (ctx.facts.awareness && ctx.facts.awareness.length > 0) {
      const approved = ctx.facts.awareness.filter((activity) => activity.bucket === "committed").length;
      rows.push([
        "Awareness activities",
        `${plural(ctx.facts.awareness.length, "activity is", "activities are")} held or planned in the area — ${plural(approved, "is", "are")} approved.`,
      ]);
    }

    // ── What it cost ──
    const claimed = ctx.reps.reduce((sum, rep) => sum + num(ctx.personByHr.get(rep)?.outstationClaimed), 0);
    if (claimed > 0) {
      const per = costPerWork(claimed, field);
      rows.push([
        "Outstation",
        `${egp(claimed)} claimed${per.perFieldDay != null ? `: ${egp(per.perFieldDay)} per field day` : ""}.`,
      ]);
    }
  }

  const spend = input.areas.reduce((sum, area) => sum + num(area.marketingCommitted) + num(area.outstationClaimed), 0);
  const perThousand = spendPerThousand(spend, total.sales);
  if (!isRep && spend > 0 && perThousand != null) {
    rows.push(["Cost against sales", `Marketing and outstation came to ${egp(spend)}: ${egp(perThousand)} for every EGP 1,000 sold.`]);
  }

  if (rows.length === 0) return null;
  return {
    align: ["left", "left"],
    columns: ["Topic", isRep ? "Your period" : "The period"],
    metric: "review-summary",
    note: isRep
      ? "Your period in short sentences. Every figure here is in the pages that follow."
      : "The period in plain sentences, each drawn from the section that follows it in this pack — the tables hold the detail and the rules.",
    rows,
    title: isRep ? "Your period in one page" : "The period in one page",
    // A short topic beside a whole sentence — the PDF's alignment rule alone would split them 50/50.
    weights: [1, 4],
  };
}

// ─────────────────────────────────────────────────────────────── bricks ──

export function brickWorkSection(input: PackInput, ctx: LinkContext | null): PackSection | null {
  if (!ctx?.bricks || ctx.bricks.rows.length === 0) return null;
  const bricks = ctx.bricks;
  const charted = bricks.rows.filter((row) => row.reach.classA.listed > 0).slice(0, 12);
  const rows: PackCell[][] = bricks.rows.map((row) => [
    row.brickName,
    whole(row.sales),
    pct0(row.salesShare),
    reachCell(row.reach.classA),
    reachCell(row.reach.otherDoctors),
    reachCell(row.reach.am),
    pharmacyReachCell(row.reach.pharmacies, row.visits),
    splitTotal(row.visits) > 0 ? formatVisitCountSplit(row.visits) : "No visits",
    BRICK_READING_LABEL[row.reading],
  ]);
  if (bricks.rows.length > 1) {
    rows.push([
      "All bricks",
      whole(bricks.total.sales),
      bricks.total.sales > 0 ? "100%" : "—",
      reachCell(bricks.total.reach.classA),
      reachCell(bricks.total.reach.otherDoctors),
      reachCell(bricks.total.reach.am),
      pharmacyReachCell(bricks.total.reach.pharmacies, bricks.total.visits),
      formatVisitCountSplit(bricks.total.visits),
      "—",
    ]);
  }
  const { bigShare } = BRICK_READING_RULES;
  // The bricks are the closing's customer rows; the area's total also carries the wholesale and
  // warehouse sales the closing spreads across a city's areas, which sit in no single brick. Said with
  // both figures, so a rep who adds the column up is not left wondering where the rest went.
  const areaSales = sumSlices(input.areas.map((area) => area.allProducts)).sales;
  const gap =
    areaSales > 0 && bricks.total.sales < areaSales * 0.99
      ? ` The bricks add up to ${egp(bricks.total.sales)} of ${ctx.isRep ? "your" : "the"} ${input.areas.length > 1 ? "areas'" : "area's"} ${egp(areaSales)} — the rest is store sales the Monthly Closing spreads across a city, in no single brick.`
      : "";
  return {
    align: ["left", "right", "right", "right", "right", "right", "right", "left", "left"],
    chart:
      charted.length >= 2
        ? {
            capNote: `Class A doctors reached in each brick, as a share of those on the list — ${
              charted.length < bricks.rows.length ? `the ${charted.length} biggest-selling bricks that hold any; ` : ""
            }the table holds every brick.`,
            items: charted.map((row) => ({ label: row.brickName, note: `${reachCell(row.reach.classA)} reached`, value: reachPct(row.reach.classA) })),
            kind: "bars",
            reference: null,
            unit: "pct",
          }
        : null,
    columns: [
      "Brick",
      "Sales",
      "Share of sales",
      "Class A doctors reached",
      "Other doctors reached",
      "AM accounts reached",
      "Pharmacies reached",
      "Visits",
      "What it says",
    ],
    metric: "brick-work",
    note: ctx.isRep
      ? `What each brick sold, and how many of the doctors, accounts and pharmacies on your list there you visited at least once.${gap}${LIST_NOTE_TAIL(ctx)}`
      : `Sales are the Monthly Closing's own customer rows. Reached = at least one regular visit in the period to a listed customer; visits count every regular visit placed in the brick, AM · PM · Pharmacies apart. "Big sales, few visits" = ${bigShare}%+ of the sales on under half that share of the visits, unless ${BRICK_READING_RULES.coveredAt}%+ of its class A doctors were reached; "Class A doctors missed" = ${BRICK_READING_RULES.classAFloor}+ listed, under half reached.${gap}${LIST_NOTE_TAIL(ctx)}`,
    rows,
    title: ctx.isRep ? "Your bricks: doctors, visits and sales" : "Bricks: class A doctors, visits and sales",
  };
}

// ─────────────────────────────────────────────────────────────── the class A to-do list ──

export function classAMissedSection(_input: PackInput, ctx: LinkContext | null): PackSection | null {
  if (!ctx || ctx.missed.length === 0) return null;
  const withRep = !ctx.isRep;
  // The register's last visit is the last one EVER, so it can fall after the period — a doctor missed
  // in August and seen on 5 September. Printing "5 Sept" under "not visited" reads as a contradiction.
  const periodEnd = ctx.months.length > 0 ? periodMonthEnd(ctx.months[ctx.months.length - 1]) : null;
  const lastVisit = (iso: string | null) =>
    iso && periodEnd && iso.slice(0, 10) > periodEnd ? `Visited after the period, on ${dayLabel(iso)}` : dayLabel(iso);
  return {
    align: withRep ? ["left", "left", "left", "left", "left", "left"] : ["left", "left", "left", "left", "left"],
    columns: [
      ...(withRep ? ["Rep"] : []),
      "Brick",
      "Doctor or account",
      "Speciality",
      "List",
      "Last visit on record",
    ],
    metric: "class-a-missed",
    note: ctx.isRep
      ? `Every class A doctor (PM) and class A account (AM) on your list who got no visit in the period — the brick that sells most comes first.${LIST_NOTE_TAIL(ctx)}`
      : `Every class A doctor (PM list) and class A account (AM list) on the reps' lists with no regular visit in the period, ordered by what the brick sells. "Last visit on record" is the last regular visit Phoenix holds for that customer; one that came after the period says so.${LIST_NOTE_TAIL(ctx)}`,
    rows: ctx.missed.map((row) => [
      ...(withRep ? [nameOf(ctx, row.repHrId)] : []),
      row.brickName,
      row.name,
      row.speciality || "Not recorded",
      row.bucket === "PM" ? "PM doctor" : "AM account",
      lastVisit(row.lastVisitedOn),
    ]),
    title: ctx.isRep ? "Class A doctors you did not visit" : "Class A doctors not visited",
  };
}

// ─────────────────────────────────────────────────────────────── areas ──

type AreaReading = "vacant" | "no-target" | "class-a-missed" | "visits-not-selling" | "on-track" | "watch";
const AREA_READING_LABEL: Record<AreaReading, string> = {
  "class-a-missed": "Class A doctors missed",
  "no-target": "No target set",
  "on-track": "On track",
  vacant: "Vacant",
  "visits-not-selling": "Visits not turning into sales",
  watch: "Below the 90% line",
};

export function areaWorkSection(input: PackInput, ctx: LinkContext | null): PackSection | null {
  if (!ctx || ctx.isRep || input.areas.length === 0) return null;
  const withLine = ctx.multiLine;
  const rows = input.areas
    .map((area) => {
      const reps = (area.repHrIds ?? []).map((rep) => rep.toUpperCase()).filter((rep) => ctx.reps.includes(rep));
      const reach = listReach(listOfReps(ctx, reps), ctx.facts.visitsByContact);
      const fieldDays = ctx.facts.repDays
        .filter((fact) => reps.includes(fact.repHrId) && ctx.months.includes(fact.period))
        .reduce((sum, fact) => sum + fact.fieldDays, 0);
      // The same reps' visits — they judge the area's pharmacy reach (Phoenix CRM logs no pharmacy visit).
      const visits = ctx.facts.repDays
        .filter((fact) => reps.includes(fact.repHrId) && ctx.months.includes(fact.period))
        .reduce((sum, fact) => mergeVisitCountSplits(sum, fact.split), emptyVisitCountSplit());
      const rideDays = reps.reduce((sum, rep) => sum + rideDaysReceived(ctx.facts.rides, rep, ctx.months), 0);
      const aReach = reachPct(reach.classA);
      const ach = area.allProducts.ach;
      const reading: AreaReading = area.vacant
        ? "vacant"
        : ach == null
          ? "no-target"
          : reach.classA.listed >= BRICK_READING_RULES.classAFloor && (aReach ?? 0) < 50
            ? "class-a-missed"
            : ach < 90 && (aReach ?? 0) >= 70
              ? "visits-not-selling"
              : ach >= 90
                ? "on-track"
                : "watch";
      return { aReach, area, fieldDays, reach, reading, rideDays, visits };
    })
    .sort((a, b) => num(b.area.allProducts.sales) - num(a.area.allProducts.sales));
  const charted = rows.filter((row) => row.reach.classA.listed > 0).slice(0, 12);
  return {
    align: withLine
      ? ["left", "left", "left", "right", "right", "right", "right", "right", "right", "left"]
      : ["left", "left", "right", "right", "right", "right", "right", "right", "left"],
    chart:
      charted.length >= 2
        ? {
            capNote: `Class A doctors reached in each area, as a share of those on its reps' lists${
              charted.length < rows.length ? ` — the ${charted.length} biggest-selling areas that hold any` : ""
            }.`,
            items: charted.map((row) => ({ label: row.area.area, note: row.area.lineLabel ?? row.area.dm, value: row.aReach })),
            kind: "bars",
            reference: null,
            unit: "pct",
          }
        : null,
    columns: [
      "Area",
      ...(withLine ? ["Line"] : []),
      "District manager",
      "Achievement",
      "Sales",
      "Class A doctors reached",
      "Pharmacies reached",
      "Rep field days",
      "Ride days",
      "What it says",
    ],
    metric: "area-work",
    note: `Each area's achievement (the Monthly Closing's rule) beside the work of the reps standing in it: class A doctors on their lists reached with at least one regular visit, their field days, and the days a manager rode with them. "Class A doctors missed" = ${BRICK_READING_RULES.classAFloor} or more listed and under half reached; "Visits not turning into sales" = under 90% achievement with at least 70% of the class A doctors reached.${LIST_NOTE_TAIL(ctx)}`,
    rows: rows.map((row) => [
      row.area.area,
      ...(withLine ? [row.area.lineLabel ?? "—"] : []),
      row.area.dm,
      pct1(row.area.allProducts.ach),
      whole(row.area.allProducts.sales),
      reachCell(row.reach.classA),
      pharmacyReachCell(row.reach.pharmacies, row.visits),
      row.fieldDays,
      row.rideDays,
      AREA_READING_LABEL[row.reading],
    ]),
    title: "Areas: class A doctors, visits and achievement",
  };
}

// ─────────────────────────────────────────────────────────────── double visits ──

// Short on purpose: the owner's rule in two lines, so the page keeps its room for the reps.
const DV_RULE_NOTE =
  `A ride day is a day the manager spent in the field with that rep. Fair share = the manager's ride days in each month the rep worked, shared evenly by the reps working that month. Never = no ride day; rarely = under half the fair share; most of the rides = over ${DV_FOCUS_RULES.mostAbove} times it — the manager who always goes with the same few and never or rarely with the rest (owner's rule, 2026-10-01).`;

export function dvFocusSections(input: PackInput, ctx: LinkContext | null): PackSection[] {
  if (!ctx || ctx.isRep || ctx.dv.length === 0) return [];
  const months = ctx.months;
  const monthLabels = months.map((month) => periodColumnLabel(month, months));

  // A district pack: each manager's own table, rep by rep, month by month.
  if (ctx.level === "district") {
    return ctx.dv.map((manager): PackSection => ({
      align: ["left", ...months.map((): PackAlign => "right"), "right", "right", "right", "left"],
      chart:
        manager.reps.length >= 2 && manager.teamRideDays > 0
          ? {
              capNote: "Ride days with each rep of the team. A bar is days spent together, never a score.",
              countSuffix: "days",
              items: manager.reps.map((rep) => ({ label: rep.name, note: DV_FOCUS_LABEL[rep.status], value: rep.rideDays })),
              kind: "bars",
              reference: null,
              unit: "count",
            }
          : null,
      columns: ["Rep", ...monthLabels, "Ride days", "Share of their ride days", "Fair share (days)", "What it says"],
      metric: "dv-focus",
      note: `${dvPatternSentence(manager)} ${
        manager.outsideRideDays > 0 ? `${plural(manager.outsideRideDays, "further day was", "further days were")} spent riding with people outside this team. ` : ""
      }${DV_RULE_NOTE}`,
      rows: manager.reps.map((rep) => [
        rep.name,
        ...months.map((month) => rep.rideDaysByMonth[month] ?? 0),
        rep.rideDays,
        pct0(rep.share),
        rep.fairDays.toFixed(1),
        DV_FOCUS_LABEL[rep.status],
      ]),
      // One line: a two-line title takes a table row's room from the page.
      title: `Double visits by rep — ${manager.managerName}`,
    }));
  }

  // A line or company pack: one row per manager, then only the reps a manager left or favoured.
  const lineOf = new Map<string, string>();
  for (const area of input.areas) if (area.dmSeatId && area.lineLabel) lineOf.set(area.dmSeatId, area.lineLabel);
  const withLine = ctx.multiLine;
  const managers: PackSection = {
    align: withLine
      ? ["left", "left", "right", "right", "right", "right", "right", "right", "left"]
      : ["left", "right", "right", "right", "right", "right", "right", "left"],
    columns: [
      "District manager",
      ...(withLine ? ["Line"] : []),
      "Team",
      "Ride days with the team",
      "Ride days outside it",
      "Never ridden",
      "Rarely ridden",
      "Most of the rides",
      "Pattern",
    ],
    metric: "dv-focus",
    note: DV_RULE_NOTE,
    rows: ctx.dv.map((manager) => [
      manager.managerName,
      ...(withLine ? [lineOf.get(manager.dmSeatId) ?? "—"] : []),
      manager.teamSize,
      manager.teamRideDays,
      manager.outsideRideDays,
      manager.never,
      manager.rarely,
      manager.most,
      dvPatternSentence(manager),
    ]),
    title: "Double visits: who gets the managers' days",
  };
  const flagged = ctx.dv.flatMap((manager) =>
    manager.reps
      .filter((rep) => rep.status === "never" || rep.status === "rarely" || rep.status === "most")
      .map((rep) => ({ manager, rep })),
  );
  const reps: PackSection | null =
    flagged.length > 0
      ? {
          align: ["left", "left", "right", "right", "left"],
          columns: ["District manager", "Rep", "Ride days", "Fair share (days)", "What it says"],
          metric: "dv-focus",
          note: "Only the reps a manager never or rarely rode with, or rode with most — every other rep had about their fair share.",
          rows: flagged.map(({ manager, rep }) => [
            manager.managerName,
            rep.name,
            rep.rideDays,
            rep.fairDays.toFixed(1),
            DV_FOCUS_LABEL[rep.status],
          ]),
          title: "Double visits: the reps left out, and the ones favoured",
        }
      : null;
  return reps ? [managers, reps] : [managers];
}

// ─────────────────────────────────────────────────────────────── the team at a glance ──

export function teamScorecardSection(input: PackInput, ctx: LinkContext | null): PackSection | null {
  if (!ctx || ctx.isRep || ctx.reps.length === 0) return null;
  const withLine = ctx.multiLine;
  const rows = ctx.reps
    .map((rep) => {
      const person = ctx.personByHr.get(rep) ?? null;
      const area = areaOfRep(input, rep);
      const reach = listReach(listOfReps(ctx, [rep]), ctx.facts.visitsByContact);
      const field = repFieldSummary({ months: ctx.months, ownManagerHrId: null, repDays: ctx.facts.repDays, repHrId: rep, rides: ctx.facts.rides });
      const claimed = num(person?.outstationClaimed);
      return { area, claimed, field, person, reach, rep };
    })
    // Somebody who neither listed, worked nor claimed anything in the period has nothing to show.
    .filter((row) => row.field.fieldVisits > 0 || row.reach.classA.listed + row.reach.pharmacies.listed > 0 || row.claimed > 0)
    .sort(
      (a, b) =>
        (a.area?.area ?? "").localeCompare(b.area?.area ?? "") || nameOf(ctx, a.rep).localeCompare(nameOf(ctx, b.rep)),
    );
  if (rows.length === 0) return null;
  return {
    align: withLine
      ? ["left", "left", "left", "right", "right", "right", "right", "left", "right", "right", "right"]
      : ["left", "left", "right", "right", "right", "right", "left", "right", "right", "right"],
    columns: [
      "Rep",
      "Area",
      ...(withLine ? ["Line"] : []),
      "Area achievement",
      "Class A doctors reached",
      "Pharmacies reached",
      "Field days",
      "Visits",
      "Ride days received",
      "Outstation claimed",
      "Per field day",
    ],
    metric: "team-scorecard",
    note: `Achievement is the AREA's, shared by everyone standing in it — targets are set per area, never per rep. Reached = at least one regular visit in the period to a customer on their own list. Ride days count every manager who rode with them. Per field day = outstation claimed over their field days.${LIST_NOTE_TAIL(ctx)}`,
    rows: rows.map((row) => {
      const per = costPerWork(row.claimed, row.field);
      return [
        nameOf(ctx, row.rep),
        row.area?.area ?? "Area not resolved",
        ...(withLine ? [row.area?.lineLabel ?? "—"] : []),
        pct1(row.area?.allProducts.ach ?? null),
        reachCell(row.reach.classA),
        pharmacyReachCell(row.reach.pharmacies, row.field.split),
        row.field.fieldDays,
        row.field.fieldVisits > 0 ? formatVisitCountSplit(row.field.split) : "No visits",
        row.field.rideDays,
        whole(row.claimed),
        per.perFieldDay == null || row.claimed === 0 ? "—" : whole(per.perFieldDay),
      ];
    }),
    title: "The team at a glance",
  };
}

// ─────────────────────────────────────────────────────────────── direct orders ──

export function directOrdersSection(input: PackInput, ctx: LinkContext | null): PackSection | null {
  const orders = ctx?.facts.directOrders;
  if (!ctx || !orders || orders.length === 0) return null;
  const monthLabel = (month: string | null) => (month ? periodLabel(month) : "Not booked yet");
  const orderNote =
    "An order counts in the month Finance books it, at its pharmacy's own brick and area — the Monthly Closing's rule, so these orders are already inside the sales above. One approved and not booked yet counts in no month.";

  if (ctx.level === "rep" || ctx.level === "district") {
    return {
      align: ["left", "left", "left", "left", "right", "left"],
      columns: ["Month booked", "Pharmacy", "Brick", "Doctor", "Value", "Raised by"],
      metric: "direct-orders",
      note: ctx.isRep ? `Direct orders for pharmacies in your area. ${orderNote}` : orderNote,
      rows: orders.map((order) => [
        monthLabel(order.salesMonth),
        order.pharmacyName,
        order.brickId ? ctx.facts.brickNames[order.brickId] ?? "Brick not named" : "Brick not recorded",
        order.doctorName ?? "Not recorded",
        whole(order.value),
        order.requesterName,
      ]),
      title: ctx.isRep ? "Direct orders in your area" : "Direct orders",
    };
  }

  // Line and company: per area — the order list would run to hundreds of rows.
  const areaName = new Map<string, { name: string; line: string | null }>();
  for (const area of input.areas) if (area.areaCode) areaName.set(`${area.lineLabel ?? ""}|${area.areaCode}`, { line: area.lineLabel ?? null, name: area.area });
  const byArea = new Map<string, { label: string; line: string; booked: number; value: number; pharmacies: Set<string>; waiting: number }>();
  for (const order of orders) {
    const known =
      areaName.get(`${order.line}|${order.areaCode}`) ??
      [...areaName.entries()].find(([key]) => key.endsWith(`|${order.areaCode}`))?.[1] ??
      null;
    const key = `${order.line}|${order.areaCode}`;
    const entry = byArea.get(key) ?? {
      booked: 0,
      label: known?.name ?? "Area not named",
      line: order.line,
      pharmacies: new Set<string>(),
      value: 0,
      waiting: 0,
    };
    if (order.salesMonth && ctx.months.includes(order.salesMonth)) {
      entry.booked += 1;
      entry.value += order.value;
      entry.pharmacies.add(order.pharmacyName);
    } else if (!order.salesMonth) entry.waiting += 1;
    byArea.set(key, entry);
  }
  const rows = [...byArea.values()].sort((a, b) => b.value - a.value);
  const withLine = ctx.multiLine;
  return {
    align: withLine ? ["left", "left", "right", "right", "right", "right"] : ["left", "right", "right", "right", "right"],
    chart:
      rows.filter((row) => row.value > 0).length >= 2
        ? {
            capNote: "Direct orders booked in the period, EGP, per area.",
            countSuffix: "EGP",
            items: rows.filter((row) => row.value > 0).slice(0, 12).map((row) => ({ label: row.label, note: withLine ? row.line : null, value: whole(row.value) })),
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    columns: ["Area", ...(withLine ? ["Line"] : []), "Orders booked", "Pharmacies", "Value booked", "Approved, not booked yet"],
    metric: "direct-orders",
    note: orderNote,
    rows: rows.map((row) => [row.label, ...(withLine ? [row.line] : []), row.booked, row.pharmacies.size, whole(row.value), row.waiting]),
    title: "Direct orders",
  };
}

// ─────────────────────────────────────────────────────────────── marketing requests ──

export function requestsSection(_input: PackInput, ctx: LinkContext | null): PackSection | null {
  const requests = ctx?.facts.marketing;
  if (!ctx || !requests || requests.length === 0) return null;
  // A rep's pack lists every request for HIS line in HIS area, whoever raised it (owner, 2026-10-01:
  // "all on his patch") — so it names who raised each, and his own read "You".
  return {
    align: ["left", "left", "left", "left", "right", "left", "right", "right", "right"],
    columns: [
      "Paid in",
      "Customer",
      "Type",
      "Requested by",
      "Cost",
      "Status",
      "Sales brought back so far",
      "Needed",
      "Brought back",
    ],
    metric: "requests-return",
    note: ctx.isRep
      ? "Every marketing request for your line in your area paid in the period, whoever raised it. A request should bring back ten times its cost in sales; the figure is the Marketing ROI module's own matching, from the month it was paid. The cost page counts only the requests you raised yourself."
      : "Marketing requests paid in the period, for these areas and lines. 'Sales brought back so far' is the Marketing ROI engine's own matching since the pay month — its figure, not the Monthly Closing's — and a request must bring back ten times its cost. Pending and refused requests have no return. The confidential Head Office products are never counted.",
    rows: requests.map((request) => [
      periodLabel(request.period),
      request.customerName,
      request.typeName,
      ctx.isRep && isOwnRequest(ctx, request.requesterHrId) ? "You" : request.requesterName,
      whole(request.cost),
      statusLabel(request.status),
      request.returnSoFar == null ? "—" : whole(request.returnSoFar),
      whole(request.requiredReturn),
      request.returnSoFar == null ? "—" : pct0(sharePct(request.returnSoFar, request.requiredReturn)),
    ]),
    title: ctx.isRep ? "Marketing requests for your area and what they brought" : "Marketing requests and what they brought",
  };
}

// ─────────────────────────────────────────────────────────────── awareness ──

export function awarenessSection(_input: PackInput, ctx: LinkContext | null): PackSection | null {
  const activities = ctx?.facts.awareness;
  if (!ctx || !activities || activities.length === 0) return null;
  // A rep reads what is happening in his area; what it costs is the managers' page.
  const withCost = !ctx.isRep;
  const bricksOf = (ids: readonly string[]) =>
    ids.length === 0 ? "Whole area" : ids.map((id) => ctx.facts.brickNames[id] ?? "Brick not named").join(", ");
  return {
    align: withCost ? ["left", "left", "left", "left", "left", "right", "right"] : ["left", "left", "left", "left", "left"],
    columns: ["Date", "Activity", "Type", "Status", "Bricks", ...(withCost ? ["Cost", "Attendees expected"] : [])],
    metric: "awareness",
    note: ctx.isRep
      ? "Market awareness activities in your area from the start of the period, including ones still ahead or waiting for approval."
      : "Market awareness activities in these areas from the start of the period, including ones still ahead or waiting for approval — the cost is the actual where recorded, else the amended, else the estimate.",
    rows: activities.map((activity) => [
      dayLabel(activity.startDate),
      activity.title,
      activity.typeName,
      statusLabel(activity.status),
      bricksOf(activity.brickIds),
      ...(withCost ? [whole(activity.cost), activity.expectedAttendees ?? "—"] : []),
    ]),
    title: ctx.isRep ? "Awareness activities in your area" : "Awareness activities",
  };
}

// ─────────────────────────────────────────────────────────────── cost ──

export function costToServeSection(input: PackInput, ctx: LinkContext | null): PackSection | null {
  if (!ctx) return null;
  if (ctx.level === "rep" || ctx.level === "district") {
    const rows = ctx.reps
      .map((rep) => {
        const field = repFieldSummary({ months: ctx.months, ownManagerHrId: null, repDays: ctx.facts.repDays, repHrId: rep, rides: ctx.facts.rides });
        const claimed = num(ctx.personByHr.get(rep)?.outstationClaimed);
        return { claimed, field, per: costPerWork(claimed, field), rep };
      })
      // Only reps who claimed something: a row of zeros per field day reads as a saving, when it is a
      // territory that needed no trip. Nobody claimed at all → nothing to say, and the section drops.
      .filter((row) => row.claimed > 0)
      .sort((a, b) => b.claimed - a.claimed || nameOf(ctx, a.rep).localeCompare(nameOf(ctx, b.rep)));
    if (rows.length === 0) return null;
    return {
      align: ["left", "right", "right", "right", "right", "right"],
      columns: [ctx.isRep ? "Who" : "Rep", "Field days", "Field visits", "Outstation claimed", "Per field day", "Per visit"],
      metric: "cost-to-serve",
      note: ctx.isRep
        ? "What your outstation trips cost against the days and visits you worked."
        : "Outstation claimed (not rejected) against each rep's own field days and visits in the period. Only reps who claimed are listed — a rep with no trips is not a saving, they are a territory that needs none.",
      rows: rows.map((row) => [
        nameOf(ctx, row.rep),
        row.field.fieldDays,
        row.field.fieldVisits,
        whole(row.claimed),
        row.per.perFieldDay == null ? "—" : whole(row.per.perFieldDay),
        row.per.perVisit == null ? "—" : whole(row.per.perVisit),
      ]),
      title: ctx.isRep ? "What your field work cost" : "What the field work cost",
    };
  }

  // Line and company: per area, every pound of field spend against the sales it sits beside.
  const awarenessByArea = new Map<string, number>();
  for (const activity of ctx.facts.awareness ?? []) {
    if (activity.bucket !== "committed") continue;
    const key = `${(activity.line ?? "").toLowerCase()}|${activity.areaCode}`;
    awarenessByArea.set(key, (awarenessByArea.get(key) ?? 0) + activity.cost);
  }
  const withLine = ctx.multiLine;
  const rows = input.areas
    .map((area) => {
      const awareness = awarenessByArea.get(`${(area.lineLabel ?? "").toLowerCase()}|${area.areaCode ?? ""}`) ?? 0;
      const spend = num(area.marketingCommitted) + num(area.outstationClaimed) + awareness;
      return { area, awareness, per: spendPerThousand(spend, num(area.allProducts.sales)), spend };
    })
    .filter((row) => row.spend > 0)
    .sort((a, b) => (b.per ?? -1) - (a.per ?? -1));
  if (rows.length === 0) return null;
  return {
    align: withLine
      ? ["left", "left", "right", "right", "right", "right", "right"]
      : ["left", "right", "right", "right", "right", "right"],
    columns: ["Area", ...(withLine ? ["Line"] : []), "Sales", "Marketing", "Outstation", "Awareness", "Spend per EGP 1,000 sold"],
    metric: "cost-to-serve",
    note: "Marketing committed, outstation claimed and approved awareness activities in each area, per EGP 1,000 of the area's sales — highest first. A cost, not a score: a new area can cost more per pound while it is being built.",
    rows: rows.map((row) => [
      row.area.area,
      ...(withLine ? [row.area.lineLabel ?? "—"] : []),
      whole(row.area.allProducts.sales),
      whole(num(row.area.marketingCommitted)),
      whole(num(row.area.outstationClaimed)),
      whole(row.awareness),
      row.per == null ? "no sales" : whole(row.per),
    ]),
    title: "What the field work cost",
  };
}

// ─────────────────────────────────────────────────────────────── the rep's own voice ──

/**
 * The sections that existed before this change, re-worded for a medical rep reading his own pack.
 *
 * The FIGURES never change — only the title and the note, which were written for a manager reading
 * about a territory ("the achievement beside a rep's name is his AREA's…") and read to a rep as
 * somebody else's report about him. A section not listed keeps its words.
 */
const REP_WORDS: Partial<Record<ReviewMetricId, { title: string; note?: string }>> = {
  achievement: {
    note: "Sales against target in the area you work in. Achievement is the sales divided by the target — the same figure the Monthly Closing prints.",
    title: "Your area's sales",
  },
  "channel-split": {
    note: "Through distributors, through stores, or as direct orders — the three add up to all your area's sales.",
    title: "How your sales reached the market",
  },
  "coverage-frequency": {
    note: "How many different customers you visited, AM · PM · Pharmacies apart, and how many regular visits each got on average.",
    title: "Customers you reached",
  },
  "customer-concentration": { title: "Your biggest customers" },
  "brick-spread": { title: "Where your sales came from" },
  "customers-per-month": {
    note: "Different customers you visited each month. A doctor seen in two months counts once in each month.",
    title: "Customers each month",
  },
  "marketing-committed": {
    note: "The marketing requests you raised yourself and the outstation you claimed. Requests others raised for your doctors are listed in \"Marketing requests for your area\" and are not counted here. Spend per point is what each point of achievement cost — lower is better.",
    title: "What your area cost",
  },
  "marketing-vs-trend": {
    note: "Marketing committed in your area, beside whether its sales rose or fell.",
    title: "Marketing and your sales",
  },
  "month-by-month": {
    note: "Each month's sales against its target, and the visits made in it.",
    title: "Month by month",
  },
  "per-product": {
    note: "Each product's sales against its target in your area.",
    title: "Your products",
  },
  "rep-rows": {
    note: "Your visits beside your area's achievement. Targets are set per area, so the achievement is the area's.",
    title: "You and your area",
  },
  "visits-split": {
    note: "Your field visits, AM · PM · Pharmacies apart — a pharmacy visit is never counted among the PM doctors.",
    title: "Your visits",
  },
  "vs-previous-window": { title: "Compared with before" },
};

/** The double-visit section a rep receives is about his area's visits a manager joined. */
const REP_DOUBLE_VISIT_WORDS = {
  note: "Your visits that a manager joined, in your area.",
  title: "Visits a manager joined",
};

export function plainForRep(section: PackSection): PackSection {
  if (section.metric === "double-visits") return { ...section, ...REP_DOUBLE_VISIT_WORDS };
  const words = REP_WORDS[section.metric];
  if (!words) return section;
  // The plainer words replace the note, never the pharmacy rule it carried (withPharmacyNote).
  const pharmacyRule = words.note && section.note.endsWith(PHARMACY_PACK_NOTE) ? ` ${PHARMACY_PACK_NOTE}` : "";
  return { ...section, note: words.note ? `${words.note}${pharmacyRule}` : section.note, title: words.title };
}
