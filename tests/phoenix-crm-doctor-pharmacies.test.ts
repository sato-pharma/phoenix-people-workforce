import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseProductAvailability, PRODUCT_AVAILABILITY_MAX } from "../src/lib/phoenix-crm/entry-rules.ts";
import { groupCustomerPharmacies, normalizePharmacyName, type PharmacyFeedback } from "../src/lib/phoenix-crm/server/list.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — the pharmacies a doctor's feedback came from.
//
// Owner, 2026-09-24, after the visit form began recording which pharmacy the rep took feedback from:
// "link doctors to their pharmacies next", and — asked how — "Both". So each doctor carries BOTH an
// auto-derived list of the pharmacies his own visits named, AND one the rep can pin as primary
// (primary_pharmacy_name on the customer row, set by phoenix_crm_set_primary_pharmacy).
//
// The derived list is the delicate half, because it is silent when it goes wrong — the screen keeps
// rendering and the pharmacies quietly split or merge. groupCustomerPharmacies is the pure core of
// loadCustomerPharmacies (the database read only shapes rows and calls it), so the grouping is pinned
// here without a database:
//
//   1. two spellings of one pharmacy that differ only in case or spacing are ONE pharmacy;
//   2. the display name and each product's Has/Doesn't-have answer are the MOST RECENT visit's;
//   3. the list is most-recent-first, and each doctor keeps his own pharmacies;
//   4. isPrimary is never decided here — the caller, which knows the pin, sets it.
// ─────────────────────────────────────────────────────────────────────────────

const LIST = "src/lib/phoenix-crm/server/list.ts";
const DOCTOR_A = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const DOCTOR_B = "1c7f8b63-4d2e-5f90-ab3c-6d7e8f9a0b1c";

function feedback(over: Partial<PharmacyFeedback>): PharmacyFeedback {
  return { customerId: DOCTOR_A, pharmacyName: "El Ezaby", productAvailability: {}, capturedAt: "2026-09-01T09:00:00.000Z", ...over };
}

// ── The reduced read (2026-10-16 performance audit) ─────────────────────────────────────────────
// A visit as phoenix_crm_visits holds it, and as PostgREST hands captured_at back: UTC, trailing zeros
// trimmed, no fraction at all on a whole second — which is why `.` and `+` can meet in a comparison.
type StoredVisit = { id: string; customerId: string; pharmacyName: string; productAvailability: unknown; capturedAt: string };

/** mulberry32 — a fixed seed, so a failure names a history that can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function postgrestInstant(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-09-01T09:00:00.500Z
  const [whole, fraction] = iso.slice(0, -1).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}${trimmed ? `.${trimmed}` : ""}+00:00`;
}

/** A territory's history with every collision the reduction must survive. */
function generatedHistory(seed: number, size: number): StoredVisit[] {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const doctors = [DOCTOR_A, DOCTOR_B, "2d8f9c74-5e3f-4a01-bc4d-7e8f9a0b1c2d"];
  // Spellings that fold into one pharmacy, a blank one, and products that clean to one name.
  const names = ["El Ezaby", "el ezaby", "El  Ezaby", "Seif", "seif ", "Roshdy", "   "];
  const products = ["Lacto Advanced", " Lacto Advanced", "Lacto Basic", "Panadol", "Brufen", "123"];
  const answers = ["has", "missing", "maybe", 7];
  const base = Date.UTC(2026, 2, 1, 9, 0, 0);
  const ids = new Set<string>();
  const visits: StoredVisit[] = [];
  while (visits.length < size) {
    const id = `00000000-0000-4000-8000-${Math.floor(random() * 0xffffffffffff).toString(16).padStart(12, "0")}`;
    if (ids.has(id)) continue;
    ids.add(id);
    // A few hundred seconds over seven months, with fractions: many visits share a second.
    const ms = base + Math.floor(random() * 400) * 1_000 * 3_600 * 12 + pick([0, 0, 500, 123, 999, 0]) + pick([0, 0, 1_000]);
    let productAvailability: unknown = {};
    const shape = random();
    if (shape < 0.05) productAvailability = ["has"]; // not an object: no answers at all
    else if (shape < 0.08) {
      // Over the cap: the parser keeps only the first answers, decided in TypeScript.
      const over: Record<string, string> = {};
      for (let index = 0; index < PRODUCT_AVAILABILITY_MAX + 3; index += 1) over[`Product ${index}`] = pick(["has", "missing"]);
      productAvailability = over;
    } else {
      const answered: Record<string, unknown> = {};
      for (const product of products) if (random() < 0.4) answered[product] = pick(answers);
      productAvailability = answered;
    }
    visits.push({ id, customerId: pick(doctors), pharmacyName: pick(names), productAvailability, capturedAt: postgrestInstant(ms) });
  }
  return visits;
}

const byId = (left: StoredVisit, right: StoredVisit) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * phoenix_crm_customer_pharmacy_feedback's rule, replayed in TypeScript over the same stored rows: per
 * stored name and per answered product key (rows within the cap), the rows of the earliest and latest
 * second; every row over the cap; each name's whole count on its newest row. In id order.
 */
function reducedLikeTheDatabase(visits: readonly StoredVisit[], productMax: number): Array<StoredVisit & { visits: number }> {
  const second = (visit: StoredVisit) => visit.capturedAt.slice(0, 19);
  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const keyCount = (visit: StoredVisit) => (isObject(visit.productAvailability) ? Object.keys(visit.productAvailability).length : 0);
  const answered = (visit: StoredVisit) =>
    isObject(visit.productAvailability) && keyCount(visit) <= productMax
      ? Object.entries(visit.productAvailability)
          .filter(([, value]) => value === "has" || value === "missing")
          .map(([key]) => key)
      : [];
  const nameKey = (visit: StoredVisit) => `${visit.customerId}\u0000${visit.pharmacyName}`;
  const names = new Map<string, { first: string; last: string; count: number; newest: StoredVisit }>();
  const bounds = new Map<string, { first: string; last: string }>();
  for (const visit of visits) {
    const at = second(visit);
    const name = names.get(nameKey(visit));
    if (!name) names.set(nameKey(visit), { first: at, last: at, count: 1, newest: visit });
    else {
      name.count += 1;
      if (at < name.first) name.first = at;
      if (at > name.last) name.last = at;
      const time = Date.parse(visit.capturedAt);
      const newest = Date.parse(name.newest.capturedAt);
      if (time > newest || (time === newest && visit.id > name.newest.id)) name.newest = visit;
    }
    for (const key of answered(visit)) {
      const bound = bounds.get(`${nameKey(visit)}\u0000${key}`);
      if (!bound) bounds.set(`${nameKey(visit)}\u0000${key}`, { first: at, last: at });
      else {
        if (at < bound.first) bound.first = at;
        if (at > bound.last) bound.last = at;
      }
    }
  }
  return visits
    .filter((visit) => {
      const at = second(visit);
      const name = names.get(nameKey(visit));
      if (name && (at === name.first || at === name.last)) return true;
      if (keyCount(visit) > productMax) return true;
      return answered(visit).some((key) => {
        const bound = bounds.get(`${nameKey(visit)}\u0000${key}`);
        return Boolean(bound) && (at === bound?.first || at === bound?.last);
      });
    })
    .sort(byId)
    .map((visit) => ({ ...visit, visits: names.get(nameKey(visit))?.newest === visit ? (names.get(nameKey(visit))?.count ?? 0) : 0 }));
}

/** loadCustomerPharmacies's own shaping of a read row, then the grouping. */
function cardsFrom(rows: ReadonlyArray<StoredVisit & { visits?: number }>) {
  const shaped: PharmacyFeedback[] = [];
  for (const row of rows) {
    const name = typeof row.pharmacyName === "string" && row.pharmacyName.trim() ? row.pharmacyName.trim() : null;
    if (!name) continue;
    shaped.push({
      customerId: row.customerId,
      pharmacyName: name,
      productAvailability: parseProductAvailability(row.productAvailability),
      capturedAt: row.capturedAt,
      visits: row.visits === undefined ? 1 : row.visits,
    });
  }
  return groupCustomerPharmacies(shaped);
}

export function runPhoenixCrmDoctorPharmaciesTests() {
  // ── normalizePharmacyName folds case and collapses whitespace ─────────────────
  assert.equal(normalizePharmacyName("El Ezaby"), "el ezaby");
  assert.equal(normalizePharmacyName("  El   Ezaby  "), "el ezaby", "leading, trailing and repeated spaces collapse");
  assert.equal(normalizePharmacyName("EL EZABY"), normalizePharmacyName("el ezaby"), "case does not make a second pharmacy");

  // ── 1 + 2: case/spacing variants are one pharmacy; the latest visit wins ───────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "el ezaby", productAvailability: { "Lacto Advanced": "has" }, capturedAt: "2026-09-01T09:00:00.000Z" }),
      feedback({ pharmacyName: "El  Ezaby", productAvailability: { "Lacto Advanced": "missing" }, capturedAt: "2026-09-10T09:00:00.000Z" }),
    ]);
    const pharmacies = grouped.get(DOCTOR_A) ?? [];
    assert.equal(pharmacies.length, 1, "two spellings that differ only in case and spacing are one pharmacy");
    const [pharmacy] = pharmacies;
    assert.equal(pharmacy.name, "El  Ezaby", "the display name is the most recent visit's spelling");
    assert.equal(pharmacy.visits, 2, "both visits are counted");
    assert.equal(pharmacy.lastFeedbackAt, "2026-09-10T09:00:00.000Z", "the last feedback is the latest visit's");
    assert.deepEqual(
      pharmacy.products,
      [{ product: "Lacto Advanced", answer: "missing" }],
      "the later visit's Has/Doesn't-have answer overwrites the earlier one",
    );
    assert.equal(pharmacy.isPrimary, false, "the pure grouping never decides the primary — the caller does");
  }

  // ── input order does not matter: it sorts by capturedAt before folding ────────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "El Ezaby", productAvailability: { "Lacto Advanced": "missing" }, capturedAt: "2026-09-10T09:00:00.000Z" }),
      feedback({ pharmacyName: "el ezaby", productAvailability: { "Lacto Advanced": "has" }, capturedAt: "2026-09-01T09:00:00.000Z" }),
    ]);
    const [pharmacy] = grouped.get(DOCTOR_A) ?? [];
    assert.equal(pharmacy?.name, "El Ezaby", "the newest spelling wins even when it arrives first");
    assert.deepEqual(pharmacy?.products, [{ product: "Lacto Advanced", answer: "missing" }], "the newest answer wins whatever the input order");
  }

  // ── 3: most-recent-first, and each doctor keeps his own pharmacies ────────────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "Seif", capturedAt: "2026-09-02T09:00:00.000Z" }),
      feedback({ pharmacyName: "El Ezaby", capturedAt: "2026-09-20T09:00:00.000Z" }),
      feedback({ customerId: DOCTOR_B, pharmacyName: "Roshdy", capturedAt: "2026-09-05T09:00:00.000Z" }),
    ]);
    const a = grouped.get(DOCTOR_A) ?? [];
    assert.deepEqual(a.map((p) => p.name), ["El Ezaby", "Seif"], "one doctor's pharmacies are most-recent-first");
    const b = grouped.get(DOCTOR_B) ?? [];
    assert.deepEqual(b.map((p) => p.name), ["Roshdy"], "another doctor's pharmacy is his alone, not mixed in");
  }

  // ── a blank pharmacy name is not a pharmacy ───────────────────────────────────
  {
    const grouped = groupCustomerPharmacies([feedback({ pharmacyName: "   " })]);
    assert.equal(grouped.has(DOCTOR_A), false, "a whitespace-only pharmacy name yields no pharmacy");
  }

  // ── the write path is a service-role SECURITY DEFINER RPC, not a table write ──
  const list = stripComments(readFileSync(LIST, "utf8"));
  assert.match(list, /callPhoenixCrm(?:<\w+>)?\(\s*"phoenix_crm_set_primary_pharmacy"/, "the primary pin goes through the seat-locked database function");

  // ── A row may stand for several visits: the count is the sum, nothing else moves ─────────────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "el ezaby", productAvailability: { Panadol: "has" }, capturedAt: "2026-09-01T09:00:00.000Z", visits: 0 }),
      feedback({ pharmacyName: "El Ezaby", productAvailability: { Panadol: "missing" }, capturedAt: "2026-09-10T09:00:00.000Z", visits: 7 }),
    ]);
    const [pharmacy] = grouped.get(DOCTOR_A) ?? [];
    assert.equal(pharmacy?.visits, 7, "a weighted row adds its weight, a zero-weight row adds nothing");
    assert.equal(pharmacy?.name, "El Ezaby");
    assert.deepEqual(pharmacy?.products, [{ product: "Panadol", answer: "missing" }]);
  }

  // ── 🔴 THE REDUCED READ GIVES EVERY CARD THE WHOLE HISTORY GAVE (2026-10-16) ────────────────────
  // loadCustomerPharmacies stopped reading a territory's whole pharmacy history: the database keeps the
  // earliest and latest SECOND per stored name and per answered product (plus every row over the answer
  // cap) and carries each name's count on its newest row. Replayed here against the full grouping on
  // generated histories full of what can go wrong — spellings that fold together, blank names, a key
  // that cleans to another, invalid answers, non-object feedback, rows over the cap, many visits in one
  // second, and fractions that make the string order disagree with time inside a second.
  for (const seed of [1, 7, 42, 2026, 31337]) {
    const history = generatedHistory(seed, 2_000);
    const full = cardsFrom([...history].sort(byId));
    const reducedRows = reducedLikeTheDatabase(history, PRODUCT_AVAILABILITY_MAX);
    const reduced = cardsFrom(reducedRows);
    assert.deepEqual(Object.fromEntries(reduced), Object.fromEntries(full), `seed ${seed}: every card — name, last feedback, count, answers and order — matches the whole history`);
    assert.ok(reducedRows.length < history.length / 2, `seed ${seed}: the read carries ${reducedRows.length} of ${history.length} rows — the reduction must actually reduce`);
  }

  // ── …and the List reads it that way, with the cap the parser applies ─────────────────────────
  {
    const start = list.indexOf("export async function loadCustomerPharmacies(");
    assert.ok(start >= 0, "loadCustomerPharmacies is still there");
    const body = list.slice(start, list.indexOf("\n}\n", start));
    assert.match(body, /\.rpc\("phoenix_crm_customer_pharmacy_feedback", \{/, "the List reads the reduced rows from the database function");
    assert.match(body, /p_product_max: PRODUCT_AVAILABILITY_MAX,/, "with the parser's own answer cap, so the rows over it come back whole");
    assert.match(body, /cursorColumn: "id"/, "in id order, the order the whole-history read delivered");
    assert.match(body, /if \(!isMissingFunction\(error\)\) throw error;/, "falling back to the whole history only while the function is not applied");
    assert.match(list, /aggregate\.visits \+= row\.visits \?\? 1;/, "the grouping adds each row's weight");

    const sql = stripSqlComments(readFileSync("supabase/migrations/20261016180201_phoenix_crm_customer_pharmacy_feedback.sql", "utf8").replace(/\r\n/g, "\n"));
    assert.match(sql, /where v\.seat_id = p_seat_id\s+and v\.is_test = p_is_test\s+and v\.pharmacy_name is not null/, "the same visits the List always read");
    assert.match(sql, /date_trunc\('second', v\.captured_at\) as at_second/, "whole seconds, because inside one the string order can disagree with time");
    assert.match(sql, /where f\.key_count > p_product_max/, "every row over the cap comes back whole");
    assert.match(sql, /order by f\.customer_id, f\.pharmacy_name, f\.captured_at desc, f\.id desc/, "the count rides on each name's newest row");
    assert.match(sql, /order by f\.id;\n\$\$;/, "in id order");
    assert.match(sql, /\n\s*security definer\n\s*set search_path to 'public'\n/, "SECURITY DEFINER with its search path pinned");
    assert.match(
      sql,
      /revoke execute on function public\.phoenix_crm_customer_pharmacy_feedback\(text, boolean, integer\) from public, anon, authenticated;\ngrant execute on function public\.phoenix_crm_customer_pharmacy_feedback\(text, boolean, integer\) to service_role;/,
      "the service role alone may run it",
    );
  }
}
