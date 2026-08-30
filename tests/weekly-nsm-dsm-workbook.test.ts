import { strict as assert } from "node:assert";

import { conserveRound, dateHeadline, orderedProducts, scopeWho } from "../src/lib/sales/weekly/nsm-dsm-workbook.ts";

// The NSM/DSM workbook's two rules that a reader can catch with their own eyes, and that no
// screenshot review would reliably catch: a column that does not add up, and a date header that
// does not say what it means.

export function runWeeklyNsmDsmWorkbookTests() {
  // ── conserveRound: the printed column must add to the total printed beside it ───────────────
  //
  // Rounding each cell independently is what left 43 rows of the review build one unit short. The
  // guarantee here is exact: the rounded values sum to the rounded total, always.
  const halves = [0.5, 0.5, 0.5, 0.5];
  assert.equal(
    conserveRound(halves).reduce((sum, value) => sum + value, 0),
    2,
    "four halves must print as a column adding to 2, not 0 and not 4",
  );

  const messy = [10.4, 10.4, 10.4, 10.4, 10.4];
  const roundedMessy = conserveRound(messy);
  assert.equal(roundedMessy.reduce((sum, value) => sum + value, 0), 52);
  // Every printed cell stays within one unit of its true value — the remainder is spread, never
  // dumped on one row, which is what makes the sheet defensible cell by cell.
  roundedMessy.forEach((value, index) => assert.ok(Math.abs(value - messy[index]) < 1));

  // An explicit target is how a REGION's rounding is made independent of rows outside that region,
  // so a district reads identically in the DSM's book and the NSM's.
  const region = [3.3, 3.3, 3.4];
  assert.equal(conserveRound(region, 10).reduce((sum, value) => sum + value, 0), 10);
  // A target BELOW the sum of the floors must be honoured too (a region whose exact total rounds
  // down); this is the direction that silently over-printed before the second loop existed.
  assert.equal(conserveRound([2.9, 2.9, 2.9], 8).reduce((sum, value) => sum + value, 0), 8);
  // Degenerate inputs must not throw or invent units.
  assert.deepEqual(conserveRound([]), []);
  assert.deepEqual(conserveRound([0, 0, 0]), [0, 0, 0]);
  assert.equal(conserveRound([1, 2, 3]).join(","), "1,2,3");

  // ── dateHeadline: every date named, and a reason the second one is there ────────────────────
  //
  // "August 2026 · to 29 Aug · POS to 18 Aug" was the shorthand the owner could not read
  // (2026-08-30). Both dates must still appear — his rule is that if there is more than one, all
  // are named — but the caveat has to say WHY, because the distributor that stopped early can be
  // most of the line, and a reader who misses that reads a short month as a bad month.
  const uploads = [
    { name: "overseas", weeks: [1, 3, 4], latest: "2026-08-29", value: 754_434 },
    { name: "Ibn Sina-Sato", weeks: [1, 3, 4], latest: "2026-08-29", value: 31_894 },
    { name: "POS Purchasing Sales", weeks: [2, 3, 4], latest: "2026-08-25", value: 44_408 },
  ];
  const headline = dateHeadline("August 2026", uploads, [1, 2, 3, 4]);

  assert.ok(headline.big.includes("August 2026"), "the period must be named");
  assert.ok(headline.big.includes("sales up to 29 Aug"), "the latest date must read as English");
  assert.ok(headline.big.includes("POS only up to 25 Aug"), "a distributor that stopped early must be named");

  const notes = headline.notes.join(" | ");
  // The share is stated, so the reader can weigh the gap rather than guess at it.
  assert.ok(/POS is \d+% of this line and stops on 25 Aug, not 29 Aug/.test(notes), notes);
  // At a SMALL share the sentence must not claim most of the report is short — that phrasing was
  // written when POS was 66% of the line and stayed on the page at 5%, where it was simply false.
  assert.ok(!notes.includes("most of this report is short"), notes);

  // A week nobody sent must be named as the ZERO the reader will actually see, and the reader must
  // be told where those sales went — not merely that a sheet is missing.
  // Both names must appear against W2; the order between them is not meaningful, so do not pin it.
  assert.ok(/W2 reads 0 for [^,]*Overseas/.test(notes), notes);
  assert.ok(/W2 reads 0 for [^,]*Ibn Sina-Sato/.test(notes), notes);
  // A LATE FIRST SHEET is the same defect as a gap in the middle. POS starts at W2, so its W1 reads
  // 0 and its W2 carries it. This was invisible until POS re-uploaded starting at week 2.
  assert.ok(notes.includes("W1 reads 0 for POS"), notes);
  assert.ok(notes.includes("those sales sit in the week after"), notes);

  // ── the big-share case still warns ──────────────────────────────────────────────────────────
  const dominant = dateHeadline("August 2026", [
    { name: "overseas", weeks: [1, 3, 4], latest: "2026-08-29", value: 754_434 },
    { name: "POS Purchasing Sales", weeks: [2, 3], latest: "2026-08-18", value: 1_510_564 },
  ], [1, 2, 3, 4]);
  assert.ok(
    dominant.notes.some((note) => note.includes("most of this report is short")),
    "a distributor that is most of the line and stopped early must say so plainly",
  );

  // ── one date is not two ─────────────────────────────────────────────────────────────────────
  // When every distributor reported to the same day there is no second date and no freshness
  // caveat. A workbook that warns about a gap it does not have teaches the reader to ignore the
  // warning on the day it matters.
  const aligned = dateHeadline("August 2026", [
    { name: "overseas", weeks: [1, 2, 3, 4], latest: "2026-08-29", value: 100 },
    { name: "Ibn Sina-Sato", weeks: [1, 2, 3, 4], latest: "2026-08-29", value: 50 },
  ], [1, 2, 3, 4]);
  assert.equal(aligned.big, "August 2026   ·   sales up to 29 Aug");
  assert.deepEqual(aligned.notes, []);

  // No uploads at all must degrade to the bare period rather than throwing on an empty scope.
  assert.deepEqual(dateHeadline("August 2026", [], []), { big: "August 2026", notes: [] });

  // ── orderedProducts: column N is the same product in every book ─────────────────────────────
  //
  // Ranking the product columns by the value present in the ROWS made the axis depend on which
  // slice of the line was exported: built against live August production, the national Pedia book
  // read "... Ivyronc, Guamusin" while the Upper Egypt district book read "... Guamusin, Ivyronc".
  // Both were correct sheets; read side by side they were a trap, because nothing on either page
  // says the axis moved. The axis is now the dashboard's stable product universe, which is scoped
  // by week and distributor only and so is identical for both requests.
  const cell = (productCode: string, productName: string, salesValue: number) =>
    ({ productCode, productName, salesValue }) as unknown as Parameters<typeof orderedProducts>[0][number];

  const AXIS = ["GU001", "IV001", "LA001", "LA002"];
  // The national book: Ivyronc outsells Guamusin.
  const national = [cell("IV001", "Ivyronc", 80_000), cell("GU001", "Guamusin", 20_000)];
  // The district book: the SAME two products, the other way round by value.
  const district = [cell("IV001", "Ivyronc", 5_000), cell("GU001", "Guamusin", 44_000)];

  assert.deepEqual(
    orderedProducts(national, AXIS).map((product) => product.code),
    orderedProducts(district, AXIS).map((product) => product.code),
    "the district book and the national book must order their product columns identically",
  );
  assert.deepEqual(orderedProducts(national, AXIS).map((product) => product.code), ["GU001", "IV001"]);

  // Without an axis the old behaviour stands - value order - so a caller that has only one book to
  // build is unaffected, and the two books above disagree, which is what the axis exists to stop.
  assert.notDeepEqual(
    orderedProducts(national).map((product) => product.code),
    orderedProducts(district).map((product) => product.code),
  );

  // A product missing from the axis must still appear, ranked after everything the axis names -
  // never dropped. A dropped column is a silently missing product, the worst outcome of the three.
  const withStranger = [...national, cell("ZZ999", "Newly mapped SKU", 999_999)];
  const ordered = orderedProducts(withStranger, AXIS).map((product) => product.code);
  assert.deepEqual(ordered, ["GU001", "IV001", "ZZ999"], "an off-axis product sorts last, never away");

  // ── scopeWho: the role is never printed twice ───────────────────────────────────────────────
  //
  // A named holder reads as "name - role, scope". A VACANT seat has no name, and putting the role
  // string in the name's slot printed "National Sales Manager - National Sales Manager, all
  // regions" on the masthead of every book built without a manager index. The role stated twice
  // reads as a defect in the report itself, which is exactly what a manager should not be
  // wondering about while looking at his own numbers.
  assert.equal(
    scopeWho("Ahmed Hassan", "National Sales Manager", "all regions"),
    "Ahmed Hassan - National Sales Manager, all regions",
  );
  assert.equal(
    scopeWho(null, "National Sales Manager", "all regions"),
    "National Sales Manager, all regions",
    "a vacant seat must state the role once, not twice",
  );
  assert.equal(scopeWho("   ", "District Manager", "Upper Egypt only"), "District Manager, Upper Egypt only");
  // A directory that stores the ROLE as the person's name is the same defect arriving by another
  // route, and it must collapse the same way.
  assert.equal(
    scopeWho("District Manager", "District Manager", "Upper Egypt only"),
    "District Manager, Upper Egypt only",
  );
}
