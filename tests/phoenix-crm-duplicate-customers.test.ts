import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { customerIdSlices, groupSameRepDuplicates, oneRowPerDoctor } from "../src/lib/phoenix-crm/server/duplicate-customers.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * One doctor, two rows on one rep's list — the SFE's housekeeping page (owner, 2026-10-02).
 *
 * The rules worth having are all about restraint: match a spelling, never a rhyme; never show it
 * to the rep; never let it act.
 */

type Row = { kind: "PM"; name: string; source: "phoenix_crm"; sourceId: string; speciality: string | null };

const row = (name: string, sourceId: string, speciality: string | null = null): Row => ({
  kind: "PM",
  name,
  source: "phoenix_crm",
  sourceId,
  speciality,
});

export function runPhoenixCrmDuplicateCustomerTests() {
  // ── The name bar: a spelling, never a rhyme ──────────────────────────────────────────────────
  // 🔴 EVERY PAIR BELOW IS REAL PRODUCTION DATA, read 2026-10-02. The engine's `identityNameKey`
  //    folds through `placeNameKey`, which is built for a pharmacy signboard and treats emphatic
  //    consonants as interchangeable — on people it collapsed these four pairs of DIFFERENT
  //    doctors into one, and this page would have invited the SFE to delete one of each.
  for (const [left, right] of [
    ["محمود اسماعيل", "محمد اسماعيل"],
    ["محمود هجرس", "محمد هجرس"],
    ["محمد سعيد", "محمد سعد"],
    ["محمد جمال", "محمد جميل"],
  ]) {
    const found = groupSameRepDuplicates([row(left!, "1"), row(right!, "2")]);
    assert.equal(
      found.size,
      0,
      `"${left}" and "${right}" are two different doctors on one list — grouping them asks the SFE to delete a real customer`,
    );
  }

  // 🔴 AND THE VARIANT THAT MATTERS IS STILL CAUGHT. ى versus ي at the end of a name is the same
  //    name typed twice, and raw text misses it — which is why the bar is `normalizeContactName`
  //    rather than the string itself.
  assert.equal(
    groupSameRepDuplicates([row("احمد شلبى", "1"), row("احمد شلبي", "2")]).size,
    1,
    "احمد شلبى and احمد شلبي are one doctor spelled two ways",
  );
  assert.equal(
    groupSameRepDuplicates([row("عادل المليسي", "1"), row("عادل المليسي", "2")]).size,
    1,
    "the identical name twice on one list is the plainest case there is",
  );

  // ── A one-word name is never evidence ────────────────────────────────────────────────────────
  // Two doctors named Mohamed on one list is ordinary; one doctor typed twice under a single word
  // is not, and the engine's own `isLinkableName` is what says so.
  assert.equal(groupSameRepDuplicates([row("محمد", "1"), row("محمد", "2")]).size, 0, "a one-word name is not evidence");

  // ── A speciality conflict ends it, and ends it for the WHOLE group ───────────────────────────
  assert.equal(
    groupSameRepDuplicates([row("احمد شلبي", "1", "Pediatrics"), row("احمد شلبي", "2", "Dermatology")]).size,
    0,
    "one name and two specialities is two people, which on one rep's list is ordinary",
  );
  assert.equal(
    groupSameRepDuplicates([row("احمد شلبي", "1", "Pediatrics"), row("احمد شلبي", "2", null)]).size,
    1,
    "a missing speciality is not a disagreement — unknown must not behave like a conflict",
  );
  // Three rows where the third disagrees is a pair plus a stranger, and naming the stranger on a
  // page that invites someone to remove a row is the harm this rule exists to prevent.
  assert.equal(
    groupSameRepDuplicates([
      row("احمد شلبي", "1", "Pediatrics"),
      row("احمد شلبي", "2", "Pediatrics"),
      row("احمد شلبي", "3", "Dermatology"),
    ]).size,
    0,
    "a conflict anywhere in the group drops the whole group, never just the row that clashes",
  );

  // A lone row is not a duplicate, however it is spelled.
  assert.equal(groupSameRepDuplicates([row("احمد شلبي", "1")]).size, 0, "one row is not a duplicate");

  // ── It is housekeeping, and it never reaches the rep ─────────────────────────────────────────
  const service = stripComments(readFileSync("src/lib/phoenix-crm/server/duplicate-customers.ts", "utf8"));
  // 🔴 ITS OWN PREDICATE SINCE 2026-10-02. It borrowed the integrity board's until the owner split the
  //    board that day (the position cases became the Super Admin's alone) — and a clerical double-entry
  //    must never inherit a rule written for evidence of dishonesty, in either direction.
  assert.match(
    service,
    /export function canReadDuplicateCustomers\(viewer: PhoenixCrmViewer\): boolean \{\s*return viewer\.isSuperAdmin \|\| viewer\.isSfeManager;\s*\}/,
    "the list is the Super Admin's and the SFE Manager's, in a predicate of its own",
  );
  assert.match(service, /if \(!canReadDuplicateCustomers\(viewer\)\)/, "and the service gates on it");
  assert.doesNotMatch(service, /canReadIntegrityBoard|integrity-board/, "it no longer borrows the integrity board's gate");
  assert.doesNotMatch(
    service,
    /identityNameKey/,
    "the place-name folding must not come back — it is what grouped four pairs of different doctors",
  );

  const page = stripComments(readFileSync("app/(admin)/admin/phoenix-crm/duplicates/page.tsx", "utf8"));
  assert.match(page, /canReadDuplicateCustomers\(viewer\)/, "the page gates on the same predicate as the service");
  assert.match(page, /redirect\("\/admin"\)/, "and refuses by redirect, so the page never describes itself to someone who may not read it");
  // 🔴 NOTHING ON IT ACTS. Removing a duplicate is the district manager's then SFE's two-step
  //    request; a button here would be a third way into a decision the owner gave to those seats.
  assert.doesNotMatch(page, /<button|<form|onClick|action=\{/, "the page reads only — no button, no form, no write");
  // Wording: this is a typing mistake, not a suspicion, and a rep must never be filed under one.
  // The imports are machinery, not words a reader sees, so they are removed first. (Until 2026-10-02
  // the page borrowed the integrity board's gate and its name was removed here too; it has its own.)
  const wording = page
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("import "))
    .join("\n");
  assert.doesNotMatch(
    wording,
    /integrity|violation|suspicio|fraud|cheat|caught/i,
    "a clerical double-entry must never be worded as an integrity case",
  );

  // ── The reads are faster and see exactly what they saw (Phoenix CRM performance audit, 2026-10-16) ──
  //
  // 🔴 THE SIXTEEN SLICES COVER THE WHOLE uuid SPACE, ONCE, IN ORDER. The company's lists are read as
  // sixteen keyset walks side by side; a gap between two slices would hide a doctor's second row, an
  // overlap would invent one, and an out-of-order slice would change which row a group lists first.
  const slices = customerIdSlices();
  assert.equal(slices.length, 16, "one slice per leading hex digit");
  assert.equal(slices[0]?.from, null, "the first slice is open below");
  assert.equal(slices[15]?.below, null, "and the last open above");
  for (let index = 1; index < slices.length; index += 1) {
    assert.equal(slices[index]?.from, slices[index - 1]?.below, `slice ${index} starts exactly where slice ${index - 1} stops`);
    assert.ok(String(slices[index - 1]?.from ?? "") < String(slices[index]?.from), "the slices ascend, so laid end to end they are id order");
  }
  for (const slice of slices) {
    for (const bound of [slice.from, slice.below]) {
      if (bound !== null) assert.match(bound, /^[0-9a-f]0000000-0000-0000-0000-000000000000$/, "every cut is a lowercase uuid, as Postgres orders them");
    }
  }
  assert.match(service, /mapWithConcurrency\(customerIdSlices\(\), SLICES_AT_ONCE,/, "the slices are read a few at a time and kept in their order");
  assert.match(service, /fetchAllRowsKeyset<Row>\(/, "each slice is keyset-paged — never an offset walk over a table the field app writes to");
  assert.doesNotMatch(service, /\.range\(/, "no offset page remains");
  assert.match(service, /return slices\.flat\(\);/, "the slices are laid end to end in their own order");

  // The keep rule's three counts are the database's own now — the same rows, counted once.
  assert.match(
    service,
    /callPhoenixCrm<[^(]*>\("phoenix_crm_customer_merge_counts", \{\s*p_customer_ids: \[\.\.\.new Set\(ids\)\],?\s*\}\)/,
    "the merge counts are one aggregate call, never every visit row fetched to be added up",
  );
  // SQL comments removed first: the header explains the is_test decision in words.
  const counts = readFileSync("supabase/migrations/20261016180401_phoenix_crm_customer_merge_counts.sql", "utf8").replace(/--.*$/gm, "");
  assert.match(counts, /returns jsonb/, "one object, never a set of rows the 1,000-row cap could cut");
  assert.match(counts, /from public\.phoenix_crm_places p\s+where p\.customer_id = any \(p_customer_ids\)\s+and p\.status = 'active'/, "active places only, as the row read asked");
  assert.match(counts, /from public\.phoenix_crm_visits v\s+where v\.customer_id = any \(p_customer_ids\)\s+group by/, "every visit, as the row read counted — no narrowing it never had");
  assert.match(counts, /from public\.phoenix_crm_customer_moves m\s+where m\.customer_id = any \(p_customer_ids\)\s+group by/, "every move");
  assert.doesNotMatch(counts, /is_test/, "no is_test narrowing — the row reads never had one, so adding it would change a keeper");

  // ── A manager's picker shows a doctor once (owner, 2026-10-28: "Merge and hide") ─────────────────
  // 🔴 REAL SHAPE: احمد الصواف on one test seat, an active row of 12 Oct beside a not-validated copy of
  //    19 Oct — the With my manager list showed him twice. The fold hides; it never drops a row.
  const listed = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    seat_id: "seat-1",
    name,
    list_type: "PM",
    status: "pending",
    speciality: null as string | null,
    created_at: "2026-10-19T21:35:00Z",
    ...extra,
  });
  const ids = (rows: { id: string }[]) => rows.map((one) => one.id).sort();
  assert.deepEqual(
    ids(oneRowPerDoctor([listed("b", "احمد الصواف"), listed("a", "احمد الصواف", { status: "active", created_at: "2026-10-12T09:00:00Z" })])),
    ["a"],
    "an active row beside a not-validated copy: the active one is shown, once",
  );
  assert.deepEqual(
    ids(oneRowPerDoctor([listed("z", "احمد الصواف", { status: "active", created_at: "2026-10-20T09:00:00Z" }), listed("y", "احمد الصواف", { created_at: "2026-10-01T09:00:00Z" })])),
    ["z"],
    "active wins even over an older not-validated row",
  );
  assert.deepEqual(
    ids(oneRowPerDoctor([listed("x", "عادل المليسي", { created_at: "2026-10-20T09:00:00Z" }), listed("w", "عادل المليسي", { created_at: "2026-10-10T09:00:00Z" })])),
    ["w"],
    "two not-validated copies: the older is shown",
  );
  assert.deepEqual(
    ids(oneRowPerDoctor([listed("1", "احمد شلبي", { speciality: "Pediatrics" }), listed("2", "احمد شلبي", { speciality: "Dermatology" })])),
    ["1", "2"],
    "two specialities are two doctors — both stay",
  );
  assert.deepEqual(
    ids(oneRowPerDoctor([listed("1", "احمد شلبي", { list_type: "AM" }), listed("2", "احمد شلبي", { list_type: "PM" })])),
    ["1", "2"],
    "AM and PM never fold — the hospital row and the clinic row are both his",
  );
  assert.deepEqual(
    ids(oneRowPerDoctor([listed("1", "احمد شلبي"), listed("2", "احمد شلبي", { seat_id: "seat-2" })])),
    ["1", "2"],
    "two reps each holding the doctor is two lists — both stay",
  );
  assert.deepEqual(ids(oneRowPerDoctor([listed("1", "محمد"), listed("2", "محمد")])), ["1", "2"], "a one-word name is never evidence — both stay");
  const managerCustomers = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-customers.ts", "utf8"));
  assert.match(
    managerCustomers,
    /async function loadRepListCustomers[\s\S]*?\.select\("[^"]*\bcreated_at\b[^"]*"\)[\s\S]*?return oneRowPerDoctor\(rows\);\r?\n\}/,
    "the one loader behind the area list, My single visits and the name match folds each doctor to one row",
  );
}
