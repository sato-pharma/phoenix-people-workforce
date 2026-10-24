/**
 * Phoenix CRM — a rep's ask for a visit with somebody, with no I/O.
 *
 * Owner, 2026-10-02. He picked "Double-visit asks reach DM: when a rep picks 'Arrange a double visit'
 * as a next step, his district manager sees the doctor and date. Nothing reads it today", and added,
 * in his own words: "the medical rep can request a double visit with his manager / product manager /
 * or request a chain visit to a certain dr". His rulings the same day:
 *
 *   - double            his manager — the territory's reviewer: its district manager, or where that
 *                       seat is vacant the next manager up (scope.ts `managerChain`, exactly as every
 *                       other decision of the territory is routed; Cairo Pedia's district seat is
 *                       vacant on purpose, so its asks reach the Pedia national sales manager);
 *   - product_manager   "one the rep picks": from the product managers of HIS line, by name. A product
 *                       manager holds no seat in the organogram — he is an APP ROLE, Product Manager or
 *                       Group Product Manager — and his products are the field-heard report's own rule
 *                       for them (`productManagersOfLine` below). On CNS ONLY the Marketing Manager is
 *                       offered too (the owner's CNS ruling, `VISIT_ASK_MARKETING_MANAGER_LINE_CODES`);
 *                       on Pedia and Anti Infective he never is;
 *   - chain             "his district manager and the next manager up (regional or national) visit the
 *                       doctor with him. Both are told." The district manager picks the day.
 *   - "He sees 'accepted, Tue 6 Oct' on his request, so they can meet." The ask is HIS request, so its
 *     status is his to see. The district manager's OWN double-visit plan stays hidden from him — this
 *     module never reads or writes it.
 *
 * And Golden Rule #1: the rep's app is easy. Nothing here asks him to type a word: the kind is a tap,
 * the product manager a name, the wished day optional — and the visit next step "Arrange a double visit"
 * raises the double ask by itself, once per visit, never costing him the visit he is saving.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { isIsoDay, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { managerChain, personKey, type OrgIndex } from "@/lib/phoenix-crm/scope";

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export type VisitAskKind = "double" | "product_manager" | "chain";

export const VISIT_ASK_KINDS: readonly VisitAskKind[] = ["double", "product_manager", "chain"];

export function isVisitAskKind(value: unknown): value is VisitAskKind {
  return value === "double" || value === "product_manager" || value === "chain";
}

/** waiting → accepted (with a day) or declined; a waiting ask the rep takes back is cancelled. */
export type VisitAskStatus = "waiting" | "accepted" | "declined" | "cancelled";

export function isVisitAskStatus(value: unknown): value is VisitAskStatus {
  return value === "waiting" || value === "accepted" || value === "declined" || value === "cancelled";
}

/** The choice on the customer's page, in the rep's own words. */
export const VISIT_ASK_CHOICE_LABELS: Record<VisitAskKind, string> = {
  double: "My manager",
  product_manager: "A product manager",
  chain: "Chain visit",
};

/** What the ask is, named on a card. */
export const VISIT_ASK_KIND_LABELS: Record<VisitAskKind, string> = {
  double: "Double visit",
  product_manager: "Visit with a product manager",
  chain: "Chain visit",
};

/** The visit next step that raises a double ask by itself (visit-outcome.ts `arrange_double`). */
export const VISIT_ASK_NEXT_STEP = "arrange_double";

/** Does a visit's next step raise an ask? Only "Arrange a double visit". */
export function raisesVisitAsk(nextStep: string | null | undefined): boolean {
  return nextStep === VISIT_ASK_NEXT_STEP;
}

/**
 * The app roles that are a product manager on EVERY line (owner, 2026-10-02: "one the rep picks: the rep
 * picks from the product managers of his line").
 */
export const VISIT_ASK_PRODUCT_MANAGER_ROLES = ["Product Manager", "Group Product Manager"] as const;

/** The Marketing Manager's app role — offered on the lines below, and on no other. */
export const VISIT_ASK_MARKETING_MANAGER_ROLE = "Marketing Manager";

/**
 * 🔒 THE CNS RULE — THE MARKETING MANAGER IS OFFERED ON CNS ONLY (owner, 2026-10-02, asked and answered):
 * "Hossam, for CNS only — CNS reps can pick Hossam Mohamed Reda for a product-manager visit. Pedia and
 * Anti Infective reps keep their own product managers only."
 *
 * CNS has no Product Manager or Group Product Manager, so until this the choice sat greyed for every CNS
 * rep. The rule is by APP ROLE and the organogram's line code, NEVER by person: on these lines, whoever
 * holds the Marketing Manager role — when his own product scope covers the line, the same
 * `productOwnerFamilies` test every product manager passes — is offered beside the line's product
 * managers. On every other line the Marketing Manager is never offered, whatever his scope covers.
 */
export const VISIT_ASK_MARKETING_MANAGER_LINE_CODES: ReadonlySet<string> = new Set(["cns"]);

/**
 * 🔒 THE TRAINING MANAGER IS OFFERED ON EVERY LINE (owner, 2026-10-24: "add training manager option in dv and
 * in everywhere it should be"). A rep of any line may pick her for a visit beside the product managers, and
 * the visit counts for both — "a visit for the rep and a visit for salma the training manager". She owns no
 * products, so the products test is not hers: the role alone offers her. She is stored where a product
 * manager is (`product_manager_hr_id`) and titled by her role, "Training Manager".
 */
export const VISIT_ASK_TRAINING_MANAGER_ROLE = "Training Manager";

/** Every app role an ask can be addressed to on SOME line — who reads and answers his own asks. */
export const VISIT_ASK_ASKABLE_ROLES = [...VISIT_ASK_PRODUCT_MANAGER_ROLES, VISIT_ASK_MARKETING_MANAGER_ROLE, VISIT_ASK_TRAINING_MANAGER_ROLE] as const;

/** The app roles a rep of this line may pick for a product manager's visit (`lineCode`: the seat's own). */
export function visitAskProductManagerRolesOfLine(lineCode: string | null | undefined): readonly string[] {
  const line = typeof lineCode === "string" ? lineCode.trim().toLowerCase() : "";
  return VISIT_ASK_MARKETING_MANAGER_LINE_CODES.has(line)
    ? VISIT_ASK_ASKABLE_ROLES
    : [...VISIT_ASK_PRODUCT_MANAGER_ROLES, VISIT_ASK_TRAINING_MANAGER_ROLE];
}

/** The heading over the companions offered beside the managers: "Product managers", or with her in it, both. */
export function companionGroupTitle(people: ReadonlyArray<{ title?: string | null }>): string {
  const training = people.some((person) => person.title === VISIT_ASK_TRAINING_MANAGER_ROLE);
  const product = people.some((person) => person.title !== VISIT_ASK_TRAINING_MANAGER_ROLE);
  if (training && !product) return "Training manager";
  return training ? "Product and training managers" : "Product managers";
}

/**
 * Whether this app role can be addressed by an ask on some line — and so reads, and answers, the asks
 * recorded as his: a product manager, a group product manager, and the Marketing Manager (CNS only).
 * Whether he is OFFERED on a given line is `visitAskProductManagerRolesOfLine`.
 */
export function isVisitAskAskableRole(role: unknown): boolean {
  return typeof role === "string" && (VISIT_ASK_ASKABLE_ROLES as readonly string[]).includes(role);
}

// ── The days ────────────────────────────────────────────────────────────────────────────────────

/**
 * How far ahead a day can be asked for, or picked: today and the 27 days after it — four field weeks.
 * `phoenix_crm_answer_visit_ask` holds the same number.
 */
export const VISIT_ASK_DAYS_AHEAD = 27;

export function visitAskLastDay(cairoToday: string): string {
  return addDaysIso(cairoToday, VISIT_ASK_DAYS_AHEAD);
}

/** One of the rep's field days: Saturday to Thursday, never a Friday (calendar.ts `planDayListTypes`). */
export function isVisitAskFieldDay(isoDay: string): boolean {
  return isIsoDay(isoDay) && weekdayOfIsoDay(isoDay) !== 5;
}

/**
 * The days the visit can be on: today and every field day of the next four weeks — never a Friday and
 * never a confirmed public holiday (server/plan-holidays.ts). The person asked picks one of these; the
 * rep may wish for one of them.
 */
export function visitAskDayChoices(cairoToday: string, holidays: ReadonlyMap<string, string>): string[] {
  const days: string[] = [];
  if (!isIsoDay(cairoToday)) return days;
  for (let offset = 0; offset <= VISIT_ASK_DAYS_AHEAD; offset += 1) {
    const day = addDaysIso(cairoToday, offset);
    if (isVisitAskFieldDay(day) && !holidays.has(day)) days.push(day);
  }
  return days;
}

/**
 * The day the rep would like, kept only when it can be a field day to come within four weeks. A WISH:
 * anything else is dropped, never refused — the visit next step carries the date its chip asked for,
 * and a date he set loosely must never cost him the visit he is saving.
 */
export function wishedVisitAskDay(value: unknown, cairoToday: string): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim();
  if (!isVisitAskFieldDay(day)) return null;
  if (day < cairoToday || day > visitAskLastDay(cairoToday)) return null;
  return day;
}

export type VisitAskDayRefusal = "bad_input" | "not_field_day" | "passed" | "too_far" | "holiday";

export type VisitAskDayResult = { ok: true; day: string } | { ok: false; kind: VisitAskDayRefusal; error: string };

/** The day the person asked picked, checked before the database is asked. */
export function resolveVisitAskDay(input: { day: unknown; cairoToday: string; holidays: ReadonlyMap<string, string> }): VisitAskDayResult {
  const day = typeof input.day === "string" ? input.day.trim() : "";
  if (!isIsoDay(day)) return { ok: false, kind: "bad_input", error: "Choose the day of the visit." };
  if (weekdayOfIsoDay(day) === 5) return { ok: false, kind: "not_field_day", error: "Friday is not a field day. Choose another day." };
  if (day < input.cairoToday) return { ok: false, kind: "passed", error: "This day has passed. Choose today or a day to come." };
  if (day > visitAskLastDay(input.cairoToday)) return { ok: false, kind: "too_far", error: "Choose a day in the next four weeks." };
  const holiday = input.holidays.get(day);
  if (holiday) return { ok: false, kind: "holiday", error: `This day is a public holiday (${holiday}). Choose another day.` };
  return { ok: true, day };
}

// ── Who is asked ────────────────────────────────────────────────────────────────────────────────

/** A product manager a rep may pick: an app role, never a seat in the organogram. */
export type VisitAskProductManager = { hrId: string; role: string };

/** Who answers the ask, and who is told about it. */
export type VisitAskAddressees = { askedHrId: string; toldHrId: string | null };

export type VisitAskAddresseeRefusal = "no_manager" | "no_senior" | "no_product_manager" | "not_line_product_manager";

export type VisitAskAddresseeResult = { ok: true; value: VisitAskAddressees } | { ok: false; kind: VisitAskAddresseeRefusal; error: string };

const NO_MANAGER = "Your territory has no manager above it in the organogram, so there is nobody to ask yet.";
const NO_SENIOR = "A chain visit needs your district manager and the manager above them, and your territory has only one manager above it.";
const NO_PRODUCT_MANAGER = "No product manager covers your line's products yet.";
const NOT_LINE_PRODUCT_MANAGER = "Choose one of your line's product managers. Reload the page.";

/**
 * Who an ask goes to — read from the organogram and the line's product managers, never from the phone:
 *
 *   double           the territory's reviewer: the nearest occupied manager seat above it, the district
 *                    manager, or the next manager up where that seat is vacant. Never the CEO, never the
 *                    rep's own seat (an acting district manager's own territory sits under his acting
 *                    seat) — `managerChain`, exactly as a plan or a list request is routed;
 *   chain            that same person, who answers and picks the day, and the next manager up the chain,
 *                    who is told. A territory with one manager above it has no chain visit to ask for;
 *   product_manager  the product manager the rep picked — one of his line's — who answers; the
 *                    territory's reviewer is told.
 */
export function resolveVisitAskAddressees(input: {
  org: OrgIndex;
  seatId: string;
  kind: VisitAskKind;
  /** Who asks: the rep (or the Super Admin trying it in the test world). Never asked himself. */
  repHrId: string | null | undefined;
  /** The product managers of the territory's line (`productManagersOfLine`). */
  productManagers: ReadonlyArray<VisitAskProductManager>;
  /** The product manager the rep picked, for a product manager's visit. */
  productManagerHrId?: unknown;
}): VisitAskAddresseeResult {
  const rep = personKey(input.repHrId);
  const chain = managerChain(input.org, input.seatId).filter((member) => member.hrId !== rep);
  const first = chain[0] ?? null;

  if (input.kind === "double") {
    if (!first) return { ok: false, kind: "no_manager", error: NO_MANAGER };
    return { ok: true, value: { askedHrId: first.hrId, toldHrId: null } };
  }

  if (input.kind === "chain") {
    if (!first) return { ok: false, kind: "no_manager", error: NO_MANAGER };
    const above = chain[1] ?? null;
    if (!above) return { ok: false, kind: "no_senior", error: NO_SENIOR };
    return { ok: true, value: { askedHrId: first.hrId, toldHrId: above.hrId } };
  }

  if (input.productManagers.length === 0) return { ok: false, kind: "no_product_manager", error: NO_PRODUCT_MANAGER };
  const picked = personKey(typeof input.productManagerHrId === "string" ? input.productManagerHrId : null);
  const manager = picked ? input.productManagers.find((entry) => personKey(entry.hrId) === picked) : undefined;
  if (!manager || !picked || picked === rep) return { ok: false, kind: "not_line_product_manager", error: NOT_LINE_PRODUCT_MANAGER };
  return { ok: true, value: { askedHrId: picked, toldHrId: first && first.hrId !== picked ? first.hrId : null } };
}

// ── The product managers of a line ──────────────────────────────────────────────────────────────

/**
 * One product manager and the products he owns, as product FAMILIES — a visit records the families
 * discussed, never a pack size. `families` null: no bound at all, every product.
 */
export type ProductManagerReach = { hrId: string; role: string; families: ReadonlyArray<string> | null };

function familyKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The product managers a rep of this line may pick: the field-heard report's own rule for a product
 * manager's products, turned round. His products are his own product list's families when he has one,
 * else the families of the lines his sales scope is bounded to, else every product
 * (server/insight-reports.ts `productOwnerFamilies`) — and he is one of a line's when his products
 * touch the families its reps detail (server/products.ts `lineProductsByFamily`). The roles offered are
 * the line's own (`visitAskProductManagerRolesOfLine`): the Marketing Manager on CNS only, by the same
 * products test. Each person once, in the order given.
 */
export function productManagersOfLine(
  managers: ReadonlyArray<ProductManagerReach>,
  lineFamilies: ReadonlyArray<string>,
  lineCode: string | null | undefined,
): VisitAskProductManager[] {
  const line = new Set(lineFamilies.map(familyKey).filter(Boolean));
  const roles = visitAskProductManagerRolesOfLine(lineCode);
  const seen = new Set<string>();
  const out: VisitAskProductManager[] = [];
  for (const manager of managers) {
    const hrId = personKey(manager.hrId);
    if (!hrId || seen.has(hrId) || !roles.includes(manager.role)) continue;
    const touches = manager.families === null || manager.families.some((family) => line.has(familyKey(family)));
    if (!touches) continue;
    seen.add(hrId);
    out.push({ hrId, role: manager.role });
  }
  return out;
}

// ── An ask in play ──────────────────────────────────────────────────────────────────────────────

/**
 * In play: waiting for its answer, or accepted for a day that has not passed. One ask in play per
 * territory, customer and kind — the same test `phoenix_crm_raise_visit_ask` makes under its lock.
 */
export function isVisitAskOpen(ask: { status: VisitAskStatus; visitOn: string | null }, cairoToday: string): boolean {
  if (ask.status === "waiting") return true;
  return ask.status === "accepted" && ask.visitOn !== null && ask.visitOn >= cairoToday;
}

/** Where a person stands on an ask: the one who answers it, the one told about it, or a reader. */
export type VisitAskPart = "asked" | "told" | "reader";

export function visitAskPartOf(ask: { askedHrId: string | null; toldHrId: string | null }, viewerHrId: string | null | undefined): VisitAskPart {
  const viewer = personKey(viewerHrId);
  if (viewer && personKey(ask.askedHrId) === viewer) return "asked";
  if (viewer && personKey(ask.toldHrId) === viewer) return "told";
  return "reader";
}

// ── How it reads ────────────────────────────────────────────────────────────────────────────────

/**
 * How the rep reads his own ask — the owner's words: "Waiting for Dina Hamdy", "Accepted, Tue 6 Oct",
 * "Declined". `visitOnText` is the screen's own day label for the day picked.
 */
export function visitAskStatusText(input: { status: VisitAskStatus; askedName: string; visitOnText: string | null }): string {
  if (input.status === "waiting") return `Waiting for ${input.askedName}`;
  if (input.status === "accepted") return input.visitOnText ? `Accepted, ${input.visitOnText}` : "Accepted";
  if (input.status === "declined") return "Declined";
  return "Cancelled";
}

/**
 * Who the visit is with, said to the rep: "Double visit with Dina Hamdy", "Visit with Rasha Sabry",
 * "Chain visit with Dina Hamdy and Ali Mohamed Ali".
 */
export function visitAskWithText(input: { kind: VisitAskKind; askedName: string; toldName: string | null }): string {
  if (input.kind === "double") return `Double visit with ${input.askedName}`;
  if (input.kind === "product_manager") return `Visit with ${input.askedName}`;
  return input.toldName ? `Chain visit with ${input.askedName} and ${input.toldName}` : `Chain visit with ${input.askedName}`;
}

/**
 * The same ask, said to a manager or a product manager reading it: to the person asked ("Double visit
 * with you"), to the person told ("Chain visit with Dina Hamdy and you — Dina Hamdy picks the day"), and
 * to a reader (as the rep reads it). A product manager's visit names the VISIT, never the person's title:
 * on CNS the person asked is the Marketing Manager (the owner's CNS ruling).
 */
export function visitAskInboxText(input: { kind: VisitAskKind; part: VisitAskPart; askedName: string; toldName: string | null }): string {
  const { kind, part, askedName, toldName } = input;
  if (part === "asked") {
    if (kind === "double") return "Double visit with you";
    if (kind === "product_manager") return "Product manager visit with you";
    return toldName ? `Chain visit with you and ${toldName}` : "Chain visit with you";
  }
  if (part === "told") {
    if (kind === "chain") return `Chain visit with ${askedName} and you — ${askedName} picks the day`;
    return `Product manager visit with ${askedName}`;
  }
  return visitAskWithText({ kind, askedName, toldName });
}
