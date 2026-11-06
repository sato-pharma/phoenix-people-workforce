import type { VisitCountBucket } from "@/lib/crm/visit-count-buckets";
import { normalizeArabicPharmacyName } from "@/lib/pharmacy-master/pharmacy-matching";

/**
 * Phoenix CRM — a PHARMACY CALL, with no I/O.
 *
 * Until now a pharmacy did not exist in Phoenix CRM as anything a rep could visit: it was a NAME he
 * typed as stock feedback ON a doctor's visit (`src/lib/phoenix-crm/day-detail.ts`). Measured on
 * production for September 2026, Delta (1) made 444 pharmacy calls — 15% of everything they did —
 * and Phoenix carried none of them, which is why a started team's Pharmacies figure has to be worded
 * "not recorded in Phoenix" rather than printed as 0 (`src/lib/crm/visit-count-buckets.ts`).
 *
 * This module is the one place that says what a pharmacy call IS, so that no surface re-derives it.
 * Everything in it is the owner's own ruling, and three of the four exist to REMOVE something a
 * reader would otherwise add by analogy with a doctor.
 *
 * ── 1. A PHARMACY IS A THIRD LIST, NEVER A ROW INSIDE AM OR PM ────────────────────────────────────
 * The AM · PM · Pharmacies golden rule (owner, 2026-09-21) is structural here rather than derived:
 * the customer's own `list_type` carries `Pharmacy`, the vendor's own spelling (`LIST_TYPES` in
 * `src/lib/crm/list-types.ts`), the spelling the retired iReports360 scraper imported each rep's
 * pharmacies under.
 *
 * 🔴 EVERY READER OF `list_type` WAS A BINARY — `row.list_type === "AM" ? "AM" : "PM"` — and there
 * were **26 of them across 17 files** when the pharmacies were imported (25 inside
 * `src/lib/phoenix-crm`; `server/plan-history.ts` carried two on ONE line). Every one filed a
 * pharmacy among the DOCTORS, and **widening the `PhoenixCrmListType` union catches none of
 * them** — they all narrow to `"AM" | "PM"` and keep compiling, so the typechecker stays green
 * while the count is wrong.
 *
 * All 26 are converted, each with its own decision rather than one sweep:
 *   · {@link parseListType} where the value is a LABEL and the surface shows all three lists —
 *     the rep's list, a visit row, a customer's timeline, today's stops, what the field heard.
 *   · {@link doctorListType} where it feeds a PLAN, a capacity, a coverage or frequency figure,
 *     a grade target — and there the caller DROPS the row, because a pharmacy is in no KPI.
 * `tests/phoenix-crm-pharmacy-calls.test.ts` now holds the count at zero so it cannot come back.
 *
 * ── 2. A PHARMACY IS NEVER PLANNED ────────────────────────────────────────────────────────────────
 * Owner, 2026-10-02: *"the pharmacy is not added to the weekly plan. He can add any pharmacy, any
 * time … He don't plan it. We don't want extra."* This REVERSES his own earlier answer the same day
 * ("planned like doctors but never counted mixed with drs"), so a reader who finds that wording in a
 * hand-off note is reading the superseded half.
 *
 * It follows that there is no pharmacy row on a weekly plan, no pharmacy in the plan picker, and no
 * per-day cap for pharmacies — the cap he set that morning ("plan up to 10 pharmacies a day") was a
 * cap on PLANNING, and nothing is left for it to limit. Do not reintroduce it as a cap on visits:
 * that would be the "extra" he ruled out, and no number anywhere depends on it.
 *
 * ── 3. A PHARMACY CALL IS NEVER APPROVED ──────────────────────────────────────────────────────────
 * Owner, 2026-10-02: *"no approval for an unplanned pharmacy visit."* An off-plan DOCTOR visit waits
 * on his manager and then the SFE and counts in nothing until both agree
 * (`src/lib/phoenix-crm/unplanned-rules.ts`), because an unapproved visit would otherwise inflate a
 * figure somebody is judged on. A pharmacy call has no such figure (rule 4), so the approval would
 * protect nothing and cost the rep a step. It counts the moment it is saved.
 *
 * 🔴 This is the rule most likely to be "fixed" back, because the off-plan machinery is right next
 * door and a pharmacy call is, literally, a visit that is not on a plan. {@link visitApprovalKind}
 * exists so that the answer is given here rather than inferred there.
 *
 * 🔴 IT WAS WRITTEN HERE ON 2026-10-02 AND WIRED NOWHERE UNTIL 2026-10-03. The only way to a pharmacy
 * was Unplanned → Out of plan, which asked for a reason and raised an approval, and
 * `phoenix_crm_save_visit` filed every pharmacy visit `out_of_plan` — so not one rep ever saved one,
 * and a rep who checked a pharmacy in and named it on his doctor visits read "Not visited this month"
 * on it (Hassan, Pedia, El Mahalla). It is wired now: Add visit → Pharmacy visit goes straight to the
 * form, and the database files a pharmacy as planned whatever the plan says
 * (supabase/migrations/20261003175653_phoenix_crm_pharmacy_visit_logged_normally.sql).
 *
 * ── 3b. A PHARMACY NEEDS NO VALIDATION ────────────────────────────────────────────────────────────
 * Owner, 2026-10-03: *"Pharmacy don't need a validation. It is visit is logged normally."* A pending
 * pharmacy sits on Your list, never under To validate (`awaitsValidation` in list-request-rules.ts),
 * and its visits count at once — `phoenix_crm_countable_visits` answers `customer_validated` true for
 * every pharmacy. A doctor still counts only once he is validated.
 *
 * ── 3c. A PHARMACY NAMED ON A DOCTOR'S VISIT IS A VISIT TO THAT PHARMACY ──────────────────────────
 * Owner, 2026-10-03: *"consider this as a pharmacy visit and make it count everywhere"*. The pharmacy
 * he took feedback from is matched to his list by {@link linkNamedPharmacy}, and the database files a
 * pharmacy visit beside the doctor's (`linked_from_visit_id`), adding the pharmacy to his list when
 * none matches. One a day, like every customer: a pharmacy already visited that day gets no second.
 * Every pharmacy visit carries its pharmacy's name in `pharmacy_name`, so the day's Pharmacies figure
 * — distinct names, keyed by {@link pharmacyNameKey} — counts the doctor's mention and the pharmacy's
 * own visit once.
 *
 * ONE BOX CAN NAME TWO PHARMACIES. Owner, 2026-10-03: *"fix a doctor visit that names two pharmacies
 * in one box"* — "صيدليه التهامي، صيدليه الرحمه". {@link splitNamedPharmacies} reads each name in the
 * box, and every one is matched, filed and counted on its own; a pharmacy's OWN visit is always one
 * pharmacy ({@link pharmacyNamesOnVisit}).
 *
 * ── 3d. HE ADDS A PHARMACY HIMSELF, BY ITS NAME ───────────────────────────────────────────────────
 * Owner, 2026-10-03: *"he can add to his list pharmacies without approval normally … in pharmacy visit
 * … all his pharmacies to be listed and he can also add a pharmacy without any validation or without
 * any approval"*. Add a pharmacy — on the List, and on Add visit → Pharmacy visit — takes the NAME and
 * nothing else: no signboard photo, no location, no hours, no request. It is on his list the moment it
 * is saved (`phoenix_crm_add_pharmacy`), Pharmacy visit offers it at once, and its visits count in the
 * Pharmacies figure only — never inside AM or PM (rule 1). The name is matched EXACTLY
 * ({@link matchAddedPharmacy}), never by the half-match a doctor's box uses.
 *
 * ── 4. NO KPI READS A PHARMACY ────────────────────────────────────────────────────────────────────
 * Owner, 2026-10-02: *"we are not stuck to coverage of pharmacies … grab the reps' pharmacies from
 * iReports360 only as a database or as a reference, but no KPIs is counted on it."* So there is no
 * pharmacy coverage, frequency, monthly target, call rate or capacity, anywhere. The Pharmacies
 * figure of AM · PM · Pharmacies stays a PLAIN COUNT of calls made — never a rate, never a share of
 * a target, never a denominator.
 *
 * Pure: it imports one type and the Pharmacy Master's own name normalizer (no I/O, no permissions), so
 * a client component may ask it as freely as a server read.
 */

/** The three lists a Phoenix CRM customer can sit on. `Pharmacy` is the vendor's own spelling. */
export type PhoenixListType = "AM" | "PM" | "Pharmacy";

/** The `list_type` a pharmacy customer carries, in the database and in every payload. */
export const PHARMACY_LIST_TYPE = "Pharmacy" as const;

/** The lists a rep may put on a weekly plan. A pharmacy is deliberately not among them (rule 2). */
export const PLANNABLE_LIST_TYPES: ReadonlyArray<PhoenixListType> = ["AM", "PM"];

/**
 * The ONE parser for a stored `list_type`.
 *
 * It answers `PM` for anything it does not recognise, which is what every call site did before a
 * third list existed — so a row written by an older build still reads exactly as it used to. What it
 * will not do is swallow a pharmacy into PM.
 */
export function parseListType(value: unknown): PhoenixListType {
  if (value === "AM") return "AM";
  if (value === PHARMACY_LIST_TYPE) return PHARMACY_LIST_TYPE;
  return "PM";
}

export function isPharmacyListType(value: unknown): boolean {
  return parseListType(value) === PHARMACY_LIST_TYPE;
}

/** Whether a customer may be ticked on a weekly plan. False for a pharmacy, always (rule 2). */
export function isPlannableListType(value: unknown): boolean {
  return PLANNABLE_LIST_TYPES.includes(parseListType(value));
}

/**
 * The two halves of a rep's DAY — for a surface that measures doctors and accounts and must not see
 * a pharmacy at all: a plan, a capacity, a coverage or frequency figure, a grade target.
 *
 * It answers **null** for a pharmacy, and that is the whole point of it existing beside
 * {@link parseListType}. The binary it replaces answered `"PM"`, which is not a refusal but a wrong
 * answer — the pharmacy was counted, among the doctors, and nothing anywhere went red. A caller
 * handling `null` has to decide what to do with the row, which is the decision the binary hid.
 */
export function doctorListType(value: unknown): "AM" | "PM" | null {
  const listType = parseListType(value);
  return listType === PHARMACY_LIST_TYPE ? null : listType;
}

/** Which of the three figures a call to this customer belongs in. Never adds a pharmacy to AM or PM. */
export function visitCountBucketForListType(value: unknown): VisitCountBucket {
  const listType = parseListType(value);
  if (listType === PHARMACY_LIST_TYPE) return "Pharmacies";
  return listType;
}

/**
 * What a visit has to wait for before it counts.
 *
 *   none          — it counts the moment it is saved.
 *   manager_sfe   — his direct manager, then the SFE (the off-plan doctor visit).
 *   customer      — nothing of its own: it counts when the CUSTOMER is admitted (out of list).
 *
 * A pharmacy call is `none` whatever else is true of it — on a plan it cannot be on, off a plan it
 * was never on. That short-circuit is the whole point of asking here (rule 3).
 */
export type VisitApprovalKind = "none" | "manager_sfe" | "customer";

export function visitApprovalKind(input: {
  listType: unknown;
  /** The off-plan shape, when the visit is one. `null` for an ordinary planned visit. */
  unplannedKind?: "out_of_plan" | "out_of_list" | null;
}): VisitApprovalKind {
  if (isPharmacyListType(input.listType)) return "none";
  if (input.unplannedKind === "out_of_plan") return "manager_sfe";
  if (input.unplannedKind === "out_of_list") return "customer";
  return "none";
}

/**
 * The measures a pharmacy is kept out of (rule 4). Named rather than counted, so that adding a sixth
 * measure to the system is a decision about this list and not an oversight.
 */
export const KPIS_A_PHARMACY_IS_NEVER_IN = [
  "coverage",
  "frequency",
  "monthly_target",
  "call_rate",
  "capacity",
] as const;

export type PharmacyExcludedKpi = (typeof KPIS_A_PHARMACY_IS_NEVER_IN)[number];

/** False for every measure in {@link KPIS_A_PHARMACY_IS_NEVER_IN}. There is no exception to add. */
export function pharmacyCountsInKpi(_kpi: PharmacyExcludedKpi): false {
  return false;
}

/**
 * What the rep is told when he logs a pharmacy call. It names no approval and no plan, because there
 * is neither — and it says the one thing he might otherwise wonder about, which is whether it landed.
 */
export const PHARMACY_CALL_REP_NOTE = "Recorded. Pharmacy calls need no plan and no approval.";

/**
 * The key two spellings of ONE pharmacy share (rule 3c). The rep types the pharmacy he took feedback
 * from as free text — "ص.الفيومي", "صيدلية الفيومي", "صيدليه الفيومى" — and the list carries the
 * vendor's spelling, so a plain lower-case compare reads one pharmacy as three.
 *
 * The letters are folded by the Pharmacy Master's own normalizer (`normalizeArabicPharmacyName`:
 * diacritics, tatweel, the alef and ya forms, case, punctuation), never a second copy of it. On top of
 * that, only what this match needs: Arabic-Indic digits read as digits (that normalizer drops them),
 * ة read as ه and ؤ ئ as و ي, and the word "pharmacy" dropped wherever it stands — صيدلية, صيدليه, the
 * reps' "ص." and "ص", "pharmacy". Its wider stop words ("الجديدة", "د") are deliberately NOT dropped:
 * there they rank suggestions for a person to confirm, here a match files a visit with nobody looking,
 * and "النور" and "النور الجديدة" can be two pharmacies. What is left is compared, never shown.
 */
const PHARMACY_WORDS = new Set(["صيدليه", "ص", "pharmacy"]);

export function pharmacyNameKey(name: string): string {
  const digits = name.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  const tokens = normalizeArabicPharmacyName(digits)
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .split(" ")
    .filter(Boolean);
  const words = tokens.filter((token) => !PHARMACY_WORDS.has(token));
  // A name that is ONLY the word "pharmacy" keeps it, so it still has something to compare.
  return (words.length > 0 ? words : tokens).join("");
}

/** A pharmacy on the rep's list, as the match below needs it. */
export type ListedPharmacy = { customerId: string; name: string; status: string };

/**
 * What to do with the pharmacy a doctor's visit named (rule 3c):
 *
 *   existing — it is this pharmacy on his list: file a visit to it;
 *   new      — nothing on his list is it: add it to his list, then file the visit;
 *   none     — leave it as the doctor's feedback only. Said for a name that matches a pharmacy he
 *              DROPPED (the SFE archived it — adding it back by typing would undo that), and for a
 *              name that half-matches two or more pharmacies, where guessing would credit the wrong one.
 */
export type NamedPharmacyLink = { kind: "existing"; customerId: string } | { kind: "new" } | { kind: "none" };

/** Below this many letters a name is too short to be found INSIDE another one ("ال" is in everything). */
export const PHARMACY_NAME_KEY_MIN_FOR_PARTIAL = 4;

/** His list with each pharmacy's key beside it; a name with no key cannot match anything. */
function keyedPharmacies(listed: readonly ListedPharmacy[]): Array<ListedPharmacy & { key: string }> {
  return listed.map((pharmacy) => ({ ...pharmacy, key: pharmacyNameKey(pharmacy.name) })).filter((pharmacy) => pharmacy.key);
}

const byCustomerId = (left: ListedPharmacy, right: ListedPharmacy) => left.customerId.localeCompare(right.customerId);

/**
 * Which of several list rows with one name is THE pharmacy: two rows with one name are one pharmacy
 * imported twice, so the one he still has wins, active first, and the order is fixed so the same name
 * always lands on the same row. The doctor's box and Add a pharmacy both choose through this.
 */
function chooseListedPharmacy<T extends ListedPharmacy>(found: readonly T[]): T | undefined {
  const live = found.filter((pharmacy) => pharmacy.status !== "dropped").sort(byCustomerId);
  return live.find((pharmacy) => pharmacy.status === "active") ?? live[0];
}

export function linkNamedPharmacy(typed: string | null | undefined, listed: readonly ListedPharmacy[]): NamedPharmacyLink {
  const key = pharmacyNameKey(typed ?? "");
  if (!key) return { kind: "none" };
  const keyed = keyedPharmacies(listed);
  const pick = (found: readonly ListedPharmacy[]): NamedPharmacyLink => {
    const chosen = chooseListedPharmacy(found);
    return chosen ? { kind: "existing", customerId: chosen.customerId } : { kind: "none" };
  };

  const exact = keyed.filter((pharmacy) => pharmacy.key === key);
  if (exact.length > 0) return pick(exact);

  if (key.length >= PHARMACY_NAME_KEY_MIN_FOR_PARTIAL) {
    const near = keyed.filter(
      (pharmacy) => pharmacy.key.length >= PHARMACY_NAME_KEY_MIN_FOR_PARTIAL && (pharmacy.key.includes(key) || key.includes(pharmacy.key)),
    );
    if (near.length === 1) return pick(near);
    if (near.length > 1) return { kind: "none" };
  }
  return { kind: "new" };
}

/** The most pharmacies one box files visits for — the database's own cap (`limit 5`). */
export const MAX_NAMED_PHARMACIES = 5;

/**
 * What separates two pharmacies in the box: the Arabic and Latin comma and semicolon, a new line, and
 * a "و" ("and") standing between TWO mentions of the word pharmacy — "صيدلية التهامي وصيدلية الرحمه".
 * 🔴 NEVER "/" — the reps' "ص/ناصر" IS the word pharmacy — never "-", which names a branch
 * ("صيدلية العطار - الفرع التاني"), and never "+" or "&", which sit inside one pharmacy's own name. A "و"
 * with no pharmacy word before it is part of the name: "مخزن وصيدلية الشفاء" is one place, never a
 * pharmacy called "مخزن" added to his list.
 */
const NAMED_PHARMACY_SEPARATOR = /[،,؛;\r\n]+|(?<=(?:صيدلي|(?:^|\s)ص[./\s])[^،,؛;\r\n]*?)\s+و\s*(?=صيدلي|ص[./\s])/u;

/**
 * Each pharmacy the box names (rule 3c), in the order he typed them. All three two-name boxes measured
 * on 2026-10-03 used the Arabic comma: "صيدليه التهامي، صيدليه الرحمه", "صيدليه الوكيل ،صيدليه
 * الكوانيني", "كوانيني ،الوكيل". A part that is only the word pharmacy names none, and a second spelling
 * of a pharmacy already named is the same pharmacy. Every name is returned — the day counts each one;
 * only the filing stops at {@link MAX_NAMED_PHARMACIES}, after the names that match nothing are left out.
 */
export function splitNamedPharmacies(text: string | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of String(text ?? "").split(NAMED_PHARMACY_SEPARATOR)) {
    const name = part.trim();
    const key = pharmacyNameKey(name);
    if (!key || PHARMACY_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * The pharmacies one visit puts in the day's Pharmacies figure: a pharmacy's own visit is that ONE
 * pharmacy, under its own name; a doctor's or account's visit, each one its box names. The day screen
 * (`todayPharmacies`) and the manager's calendar cell both read it, so the cell and the day agree.
 */
export function pharmacyNamesOnVisit(listType: unknown, pharmacyName: string | null | undefined): string[] {
  if (isPharmacyListType(listType)) {
    const name = String(pharmacyName ?? "").trim();
    return name ? [name] : [];
  }
  return splitNamedPharmacies(pharmacyName);
}

/** One name from the box, and which pharmacy on his list it is. */
export type NamedPharmacyMatch = { name: string; link: NamedPharmacyLink };

/**
 * Every pharmacy the box names, matched on its own by {@link linkNamedPharmacy}. A name that matches
 * nothing he may visit is left out, and two names that land on ONE pharmacy on his list file it once.
 * The first {@link MAX_NAMED_PHARMACIES} that DO match are filed — counted after the left-out ones, so a
 * name that matches nothing never takes a later name's place.
 */
export function linkNamedPharmacies(text: string | null | undefined, listed: readonly ListedPharmacy[]): NamedPharmacyMatch[] {
  const matches: NamedPharmacyMatch[] = [];
  const linked = new Set<string>();
  for (const name of splitNamedPharmacies(text)) {
    if (matches.length === MAX_NAMED_PHARMACIES) break;
    const link = linkNamedPharmacy(name, listed);
    if (link.kind === "none") continue;
    if (link.kind === "existing") {
      if (linked.has(link.customerId)) continue;
      linked.add(link.customerId);
    }
    matches.push({ name, link });
  }
  return matches;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line he reads once a doctor's visit is saved, about the pharmacies it named: each one that got a
 * visit, and which of them joined his list. Nothing when none did — a pharmacy already visited that day
 * keeps the one visit it has.
 */
export function linkedPharmaciesNote(filed: ReadonlyArray<{ name: string; created: boolean }>): string | null {
  if (filed.length === 0) return null;
  const names = filed.map((pharmacy) => pharmacy.name);
  const added = filed.filter((pharmacy) => pharmacy.created).map((pharmacy) => pharmacy.name);
  if (filed.length === 1) {
    return added.length === 1
      ? `${names[0]} is logged as a pharmacy visit too, and added to your list.`
      : `${names[0]} is logged as a pharmacy visit too.`;
  }
  const logged = `${joinNames(names)} are logged as pharmacy visits too.`;
  if (added.length === 0) return logged;
  return `${logged} ${joinNames(added)} ${added.length === 1 ? "is" : "are"} added to your list.`;
}

/**
 * The longest name Add a pharmacy takes (rule 3d). The same 120 as a visit's `pharmacy_name`
 * (entry-rules.ts `PHARMACY_NAME_MAX`, pinned equal by the test), because a pharmacy's own visit is
 * named after it — a longer name would be refused on its first visit, not here.
 */
export const ADDED_PHARMACY_NAME_MAX = 120;

/**
 * A typed pharmacy name with its spacing tidied: trimmed, every run of spaces one space. The ONE copy
 * the length check, the stored name and the List's grouping key (`normalizePharmacyName`) all read —
 * `phoenix_crm_add_pharmacy` repeats it in SQL, so a name this passes the database takes.
 */
export function collapsePharmacyName(name: string | null | undefined): string {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

/** Why a name typed on Add a pharmacy cannot be saved, or null when it can (rule 3d). */
export function addedPharmacyNameProblem(name: string | null | undefined): string | null {
  const text = collapsePharmacyName(name);
  if (!text) return "Write the pharmacy's name.";
  if (text.length > ADDED_PHARMACY_NAME_MAX) return `Keep the name to ${ADDED_PHARMACY_NAME_MAX} characters.`;
  const key = pharmacyNameKey(text);
  // "صيدلية" or "ص." alone names no pharmacy: the key keeps the word only when nothing else is there.
  if (!key || PHARMACY_WORDS.has(key)) return "Write the pharmacy's own name, not only the word pharmacy.";
  return null;
}

/**
 * What Add a pharmacy does with the name he typed (rule 3d):
 *
 *   existing — it is on his list already, so it is opened, never added a second time;
 *   archived — he dropped it and it was archived: bringing it back is asked from the Archive, as for
 *              any customer, because adding it again by typing would undo that decision (rule 3c);
 *   new      — it is added.
 *
 * By its key, EXACTLY. A doctor's box half-matches because he typed it in passing; here he is naming the
 * pharmacy he wants, and opening "النور الجديدة" because he typed "النور" would hand him one he did not
 * ask for.
 */
export type AddedPharmacyMatch =
  | { kind: "existing"; customerId: string; name: string }
  | { kind: "archived"; customerId: string; name: string }
  | { kind: "new" };

export function matchAddedPharmacy(typed: string | null | undefined, listed: readonly ListedPharmacy[]): AddedPharmacyMatch {
  const key = pharmacyNameKey(typed ?? "");
  if (!key) return { kind: "new" };
  // The same row `linkNamedPharmacy` would choose, so a pharmacy is opened where its visits are filed.
  const same = keyedPharmacies(listed).filter((pharmacy) => pharmacy.key === key);
  const chosen = chooseListedPharmacy(same);
  if (chosen) return { kind: "existing", customerId: chosen.customerId, name: chosen.name };
  const archived = [...same].sort(byCustomerId)[0];
  return archived ? { kind: "archived", customerId: archived.customerId, name: archived.name } : { kind: "new" };
}

/** What he reads once Add a pharmacy is saved. */
export function addedPharmacyNote(added: { customerName: string; created: boolean }): string {
  return added.created
    ? `${added.customerName} is on your list. No approval: its visits count in Pharmacies, never in AM or PM.`
    : `${added.customerName} is already on your list.`;
}
