import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { employeeSeatDriftItems } from "../src/lib/needs-you/seat-drift-items.ts";
import { needsYouDestinations, needsYouSourceIds, needsYouSourceLabels } from "../src/lib/needs-you/types.ts";
import type { EmployeeSeatDrift } from "../src/lib/org/employee-seat-drift.ts";

/**
 * THE ORGANOGRAM SEAT-DRIFT BOARD ROW.
 *
 * WHY IT EXISTS. `public.au_v_employee_seat_drift` compares `employees.area_id`, `region_code` and
 * `manager_hr_id` against the seat each active person holds, and it had been flagging a real
 * mismatch for two days with nothing reading it: a medical rep hired into the Behira 1 rep seat on
 * 2026-10-08 had her `area_id` edited on the 13th to Behira 2, another rep's area. The weekly and
 * monthly plan has no rep picker — it auto-assigns from the area on the EMPLOYEE record — so she
 * disappeared from her own area's plan, and it surfaced on the 15th only because her district
 * manager noticed a name that was not there.
 *
 * The three things pinned below are the three the row can lose silently: a drifted person must
 * produce a row, a clean view must produce none (an empty board here is a TRUE zero, and the
 * adapter's read throws rather than returning an empty array on failure), and the row must name
 * the person rather than print an HR id at him.
 */
export function runNeedsYouSeatDriftTests() {
  /** The 2026-10-15 case, as the loader hands it over. */
  const shahd: EmployeeSeatDrift = {
    hrId: "B-204",
    name: "Shahd Mohamed Elsayed Ghoneim",
    seat: "the Behira 1 Medical Representative seat",
    facts: [{ kind: "area", employeeValue: "Behira 2", seatValue: "Behira 1" }],
  };

  // ── 1. A DRIFTED ROW PRODUCES AN ITEM.
  const items = employeeSeatDriftItems([shahd]);
  assert.equal(items.length, 1, "one drifted person produces exactly one row");
  const row = items[0]!;
  assert.equal(row.sourceId, "organogram-seat-drift");
  assert.equal(row.kind, "flag");
  assert.equal(
    row.lane,
    "yours",
    "this is HR data integrity — the Super Admin's own, never a manager's queue",
  );
  assert.equal(row.key, "organogram-seat-drift:b-204", "the key is stable, one per person");
  assert.equal(row.count, null, "a person is not a quantity — the same reading a month gets");
  assert.equal(row.oldestAt, null, "the view compares two current values and cannot say when they parted");
  assert.equal(row.ageDays, null, "so no age is invented from the last edit to the row");
  assert.equal(row.overdue, false, "there is no upstream SLA on a record correction");
  assert.equal(row.externalUrl, null);

  // The label says WHO, WHICH SEAT and WHICH FACT — the three things that make it actionable.
  assert.match(row.label, /^Shahd Mohamed Elsayed Ghoneim: /, `the row opens with the person: ${row.label}`);
  assert.match(row.label, /Behira 1 Medical Representative seat/, `it names the seat: ${row.label}`);
  assert.match(row.label, /disagree about the area$/, `it names the fact that disagrees: ${row.label}`);
  assert.ok(!row.label.includes("…") && !row.label.includes("..."), "no ellipsis — the owner's standing rule");

  // BOTH SIDES, SIDE BY SIDE. A row that says only "the area is wrong" sends him to the screen to
  // find out what it says now, which is the lookup nobody does.
  assert.ok(row.note, "the row must carry a note");
  assert.match(
    row.note!,
    /the record says Behira 2 and the seat says Behira 1/,
    `the note puts the two values side by side: ${row.note}`,
  );
  // The consequence that made this source necessary.
  assert.match(
    row.note!,
    /no rep picker/,
    `an area drift costs the person their own area's plan, and the note says so: ${row.note}`,
  );
  // 🔴 AND IT PROPOSES NO AUTOMATIC REPAIR. Which side is right is a judgement — on 2026-10-15 the
  // SEAT was right and the record was mis-typed; after a real transfer it is the other way round.
  assert.match(
    row.note!,
    /Neither side is right by default/,
    `the note refuses to pick a side for him: ${row.note}`,
  );

  // The link opens that one person's record on Employee Master.
  assert.equal(row.href, "/employees?edit=B-204", "the row opens the record that can be corrected");

  // ── 2. A CLEAN VIEW PRODUCES NONE. Production read 0 drifted rows of 97 seated actives on the
  // day this shipped, so the empty state is the normal one and it must be an empty lane, never a
  // row saying everything is fine.
  assert.deepEqual(employeeSeatDriftItems([]), [], "a clean view produces no rows at all");
  assert.deepEqual(
    employeeSeatDriftItems([{ ...shahd, facts: [] }]),
    [],
    "and a person with nothing disagreeing produces none either",
  );

  // ── 3. THE ROW NAMES THE PERSON, NEVER AN ID. The owner's standing rule, and the reason
  // `NeedsYouItem` has no `hrId` field at all. The id travels in the href and nowhere else.
  assert.deepEqual(row.people, ["Shahd Mohamed Elsayed Ghoneim"], "the person is named in `people`");
  for (const [field, text] of [["label", row.label], ["note", row.note ?? ""], ["people", row.people.join(" ")]] as const) {
    assert.ok(
      !/\bB-204\b/i.test(text),
      `the ${field} prints an HR id: ${text}`,
    );
  }

  // Every fact is named, and a missing side reads as "holds no X" rather than as a gap — four of
  // the six rows corrected on 2026-10-12 had no area on file at all, which is a worse state than
  // holding the wrong one and must not render as the same sentence.
  const many = employeeSeatDriftItems([
    {
      hrId: "B-77",
      name: "Norhan Samir Selim Ramla",
      seat: "the Assuit 2 Medical Representative seat",
      facts: [
        { kind: "area", employeeValue: null, seatValue: "Assuit 2" },
        { kind: "region", employeeValue: "Delta (1)", seatValue: "Upper Egypt (2)" },
        { kind: "manager", employeeValue: "Hany Saad Mohamed Omar", seatValue: "Sameh Shabaan El Hoseiny El Hoseiny" },
      ],
    },
  ]);
  const wide = many[0]!;
  assert.match(
    wide.label,
    /disagree about the area, the region and the manager$/,
    `three facts are listed in one sentence, not three rows: ${wide.label}`,
  );
  assert.equal(many.length, 1, "one person is one row however many facts disagree");
  assert.match(
    wide.note!,
    /the record holds no area and the seat says Assuit 2/,
    `an absent value says so rather than printing a blank: ${wide.note}`,
  );
  assert.match(wide.note!, /the seat says Sameh Shabaan El Hoseiny El Hoseiny/, "the manager is a NAME, not an HR id");

  // ── THE WIRING. Read as TEXT, never imported: `needs-you/sources.ts` reaches ~30 service modules
  // and one of them heads to `getSupabaseAdmin`, which is what would take this gate offline.
  assert.ok(
    needsYouSourceIds.includes("organogram-seat-drift"),
    "the source must be in the closed union, or the board carries no entry for it",
  );
  assert.equal(
    needsYouSourceLabels["organogram-seat-drift"],
    "Employee records that disagree with the organogram",
    "the amber row and the every-source band print a label a person would say",
  );
  assert.equal(
    needsYouDestinations["organogram-seat-drift"].href,
    "/employees",
    "Employee Master is where the record half of the disagreement is corrected",
  );
  assert.equal(needsYouDestinations["organogram-seat-drift"].screen, "Employee Master");

  const source = readFileSync("src/lib/needs-you/sources.ts", "utf8");
  const registry = source.indexOf("export const needsYouAdapters");
  assert.match(
    source.slice(registry > 0 ? registry : 0),
    /^ {2}organogramSeatDrift,$/m,
    "an id with no adapter renders amber for ever — the adapter must be listed in the registry",
  );
  const adapter = source.slice(
    source.indexOf("const organogramSeatDrift: NeedsYouAdapter"),
    registry > 0 ? registry : source.length,
  );
  assert.ok(adapter.length > 0, "the adapter must exist in sources.ts");
  assert.match(
    adapter,
    /ownerOnlyQueue\(/,
    "it is the Super Admin's lane alone — every other viewer gets a true zero, not a row",
  );
  assert.ok(
    !/cost:\s*"heavy"/.test(adapter),
    "the view is one pass over 97 rows (3.228 ms on production, 2026-10-15) — it belongs in the light lane",
  );
  assert.match(
    adapter,
    /if \(drifts\.length === 0\) return EMPTY;/,
    "a clean view is a TRUE zero, and the read above it throws rather than returning an empty array",
  );

  // 🔴 NO SEAT AT ALL IS NOT DRIFT, AND NOTHING MAY WIDEN IT TO THAT. Sixteen Head Office people
  // hold no seat by design; the view omits them because it starts from the seated and joins
  // outward. A source that asked "who has no seat" would put all sixteen on the board on every
  // load, for ever.
  const loader = readFileSync("src/lib/org/employee-seat-drift.ts", "utf8");
  assert.match(
    loader,
    /\.or\("area_id_drifted\.is\.true,region_code_drifted\.is\.true,manager_drifted\.is\.true"\)/,
    "the read selects on the three drift booleans and on nothing else",
  );
  assert.ok(
    !/is\.null|employment_status|seat_id\.is\./.test(loader.replace(/\/\*[\s\S]*?\*\//g, "")),
    "a seatless person is not drift — the view omits them deliberately and this read must not go looking",
  );
}
