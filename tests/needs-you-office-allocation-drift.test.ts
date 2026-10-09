import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { officeAllocationDriftItems, needsYouAdapters } from "../src/lib/needs-you/sources.ts";
import { needsYouDestinations, needsYouSourceIds, needsYouSourceLabels } from "../src/lib/needs-you/types.ts";
import type { OfficeAllocationDriftReport } from "../src/lib/sales/office-allocation-drift.ts";

/**
 * THE OFFICE-ALLOCATION BOARD ROW.
 *
 * WHY IT EXISTS. The Office channel carries no geography, so the owner's golden rule spreads it by
 * each area's share of the line's non-Office VALUE — and those shares are computed once, when the
 * Office file is committed, then written into the rows. Nothing re-runs them. A distributor book
 * that lands or is re-mapped AFTER that commit therefore moves the base underneath a spread already
 * frozen into the rows, and until this row existed nothing in the product said so: measured on
 * production 2026-10-09, August 2026 CNS had 3,698 of its 109,719 Office units (3.37%) in the wrong
 * area across 43 areas while every screen read clean.
 *
 * 🔴 AND IT CANNOT BE CAUGHT BY THE PUBLICATION DRIFT CHECK, BY CONSTRUCTION — today's side is
 * today's shares applied to the line's OWN stored total, so both sides hold identical units per
 * line and the published-closing check compares exactly that one scalar. The assertions below pin
 * that the row says so out loud, because a reader who does not know it will "reconcile" the two.
 */
export function runNeedsYouOfficeAllocationDriftTests() {
  const now = new Date("2026-10-09T18:00:00Z");

  /** August's real shape, reduced: one line, a cause, and areas that disagree. */
  const drifted: OfficeAllocationDriftReport = {
    period: "2026-08",
    officeCommittedAt: "2026-09-10T17:15:54.278Z",
    baseTouchedAfterCommit: [
      // Deliberately newest-first, which is the order the producer returns.
      { distributorCode: "EP-PHS", distributorName: "EPDA-Pharmacies", updatedAt: "2026-09-14T08:00:00.000Z" },
      { distributorCode: "IS", distributorName: "Ibn sina", updatedAt: "2026-09-13T20:47:00.000Z" },
    ],
    lines: [
      {
        lineCode: "CNS",
        officeUnits: 109_719,
        unitsThatWouldMove: 3_697.58,
        percentOfOfficeUnits: 3.3700000000000001,
        areas: [
          { lineCode: "CNS", areaCode: "Sohag1", storedUnits: 5_000, todaysUnits: 3_901, unitsDelta: -1_099 },
          { lineCode: "CNS", areaCode: "Sohag2", storedUnits: 4_000, todaysUnits: 5_050, unitsDelta: 1_050 },
        ],
      },
    ],
    unitsThatWouldMove: 3_697.58,
    lineUnitTotalsAgree: true,
    drifted: true,
  };

  // ── An OPEN month: his decision, so the `yours` lane.
  const open = officeAllocationDriftItems([drifted], ["2026-07"], now);
  assert.equal(open.length, 1, "one drifted line produces exactly one row");
  const row = open[0]!;
  assert.equal(row.sourceId, "office-allocation-drift");
  assert.equal(row.lane, "yours", "an unpublished month's stale spread is a decision only he can make");
  assert.equal(row.kind, "flag");
  assert.equal(row.key, "office-allocation-drift:2026-08:CNS", "the key is stable per period and line");

  // The label carries the three figures that make it actionable, and spells them out.
  assert.match(row.label, /3,698 of 109,719 Office units/, `the label states the movement: ${row.label}`);
  assert.match(row.label, /3\.37%/, `the label states the share: ${row.label}`);
  assert.match(row.label, /^CNS 2026-08/, `the label opens with the line and month: ${row.label}`);
  assert.ok(!row.label.includes("…") && !row.label.includes("..."), "no ellipsis — the owner's standing rule");

  // Areas IS the count, the same meaning the published-closing drift row gives it.
  assert.equal(row.count, 2, "the count is how many areas hold a difference");

  // THE AGE IS WHEN IT WENT STALE, not when the Office book was committed — the commit was correct
  // when it was written, and `baseTouchedAfterCommit` arrives newest-first.
  assert.equal(row.oldestAt, "2026-09-13T20:47:00.000Z", "the age runs from the FIRST base move after the commit");
  assert.equal(row.ageDays, 25, "25 days stale, measured from that first move");
  assert.equal(row.overdue, false, "there is no upstream SLA for this, so nothing is overdue");

  // The cause is named, in NAMES — the owner's standing rule — and both of them.
  assert.ok(row.note, "the row must carry a note");
  assert.match(row.note!, /EPDA-Pharmacies/, `the note names the cause: ${row.note}`);
  assert.match(row.note!, /Ibn sina/, `the note names every cause, not just the newest: ${row.note}`);
  assert.ok(
    !/\bEP-PHS\b/.test(row.note!),
    `the note must print names, never distributor codes: ${row.note}`,
  );

  // The blind spot is stated, or a reader reconciles this against the publication check and
  // concludes one of them is broken.
  assert.match(
    row.note!,
    /same units for the line/,
    `the note must say the published-closing check cannot see this: ${row.note}`,
  );
  assert.match(
    row.note!,
    /check-office-allocation-drift\.ts/,
    `the note must name the script that answers for other months: ${row.note}`,
  );

  // NO EGP, EVER — the report carries units only and the row must not invent money.
  assert.ok(!/EGP/i.test(row.label + " " + row.note!), "no EGP figure reaches this board");

  // ── A PUBLISHED month: the spread still disagrees, but re-committing it would restate an
  // announced figure (his 2026-09-07 rule), so it is not waiting on him.
  const published = officeAllocationDriftItems([drifted], ["2026-07", "2026-08"], now);
  assert.equal(published.length, 1, "a published month still produces the row");
  assert.equal(
    published[0]?.lane,
    "worth-knowing",
    "a published month drops out of `yours` — the fix is ruled out, so it is not his decision",
  );
  assert.match(
    published[0]?.note ?? "",
    /published, so re-committing its Office book would restate an announced figure/,
    `the published row must say why it is not actionable: ${published[0]?.note}`,
  );

  // ── A cause-free drift: the customer map moved, not an upload. The row must not claim a book did.
  const noCause: OfficeAllocationDriftReport = { ...drifted, baseTouchedAfterCommit: [] };
  const [mapMove] = officeAllocationDriftItems([noCause], [], now);
  assert.match(
    mapMove?.note ?? "",
    /came from the customer map rather than an upload/,
    `with no batch written after the commit the note must say so: ${mapMove?.note}`,
  );
  assert.equal(mapMove?.oldestAt, null, "with no base move there is no instant it went stale");
  assert.equal(mapMove?.ageDays, null, "and therefore no age is invented");

  // ── A clean month produces NOTHING. `drifted` is the one boolean to branch on.
  const clean: OfficeAllocationDriftReport = {
    period: "2026-09",
    officeCommittedAt: "2026-10-09T17:10:51.400Z",
    baseTouchedAfterCommit: [],
    lines: [],
    unitsThatWouldMove: 0,
    lineUnitTotalsAgree: true,
    drifted: false,
  };
  assert.deepEqual(officeAllocationDriftItems([clean], [], now), [], "a spread that matches the rule is no row");

  // ── Share-arithmetic noise is not a movement: under half a unit rounds to zero and is dropped.
  const noise: OfficeAllocationDriftReport = {
    ...drifted,
    lines: [{ ...drifted.lines[0]!, unitsThatWouldMove: 0.4, percentOfOfficeUnits: 0.0004 }],
    unitsThatWouldMove: 0.4,
  };
  assert.deepEqual(
    officeAllocationDriftItems([noise], [], now),
    [],
    "0.4 of a unit is the share arithmetic, not a drift worth a row",
  );

  // ── REGISTRATION. The id, its adapter, its label and its destination must all exist together;
  // `needs-you-never-under-reports` pairs ids with adapters, and this pins the rest.
  assert.ok(
    needsYouSourceIds.includes("office-allocation-drift"),
    "the source id must be registered, or the board never fans out to it",
  );
  assert.ok(
    needsYouAdapters.some((adapter) => adapter.id === "office-allocation-drift"),
    "an id with no adapter renders amber for ever",
  );
  assert.equal(
    needsYouSourceLabels["office-allocation-drift"],
    "Office allocation that no longer matches the rule",
    "the amber row and the every-source band print this label",
  );

  // 🔴 THE DESTINATION IS THE IMPORT WIZARD, NOT THE CLOSING SCREEN. Re-committing the Office book
  // is the only action anywhere that recomputes those shares; the closing screen cannot do it, and a
  // row that linked there would send him to a page with no way to answer it.
  assert.equal(needsYouDestinations["office-allocation-drift"].href, "/sales/import");
  assert.equal(needsYouDestinations["office-allocation-drift"].screen, "Sales Import");
  assert.equal(row.href, "/sales/import", "the item carries that same href");

  // ── THE ADAPTER IS OWNER-ONLY AND READS ONE PERIOD. Source-read rather than executed, because
  // running it needs production; the two things worth pinning are both visible in the source.
  const source = readFileSync("src/lib/needs-you/sources.ts", "utf8");
  const start = source.indexOf("const officeAllocationDrift: NeedsYouAdapter");
  assert.ok(start > 0, "the adapter must exist under that name");
  const end = source.indexOf("export const needsYouAdapters", start);
  const adapter = source.slice(start, end > start ? end : undefined);
  assert.match(
    adapter,
    /ownerOnlyQueue\(/,
    "the adapter asks its own permission — every other viewer gets a true zero, not a refusal",
  );
  // TWO periods, bounded — the live one and the latest published one. All nine periods with an
  // Office batch would be ~18 s against an 8-second budget.
  assert.match(
    adapter,
    /periods\.find\(\(period\) => publishedPeriods\.includes\(period\)\)/,
    "it reads the latest PUBLISHED period too, or a stale spread already serving stays invisible",
  );
  assert.match(
    adapter,
    /\[\.\.\.new Set\(wanted\)\]/,
    "and it de-duplicates, or a month that is both the latest and the latest published renders twice",
  );
}
