import { strict as assert } from "node:assert";

import {
  comparableDistributors,
  conserveRound,
  dateHeadline,
  familyBlocks,
  shareTrend,
  orderedProducts,
  scopeWho,
  shareOut,
  trendMark,
  trendPair,
} from "../src/lib/sales/weekly/nsm-dsm-workbook.ts";

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

  // ── familyBlocks: a family is a MONEY line, and it keeps the line's column order ─────────────
  //
  // The owner reads by family ("how did Conviban do here"), but Conviban is four concentrations and
  // their units cannot be added - 100 mg and 25 mg are not the same object. So the block exists to
  // carry one money figure per family, and it must not reorder the columns while doing it: the
  // product axis is the LINE's, and a district's book has to read column-for-column against the
  // national one.
  const axis = [
    { code: "GUA", name: "Guamusin" },
    { code: "CV100", name: "Conviban 100 mg" },
    { code: "IVY", name: "Ivyronc" },
    { code: "CV25", name: "Conviban 25 mg" },
    { code: "CV50", name: "Conviban 50 mg" },
  ];
  const familyOf = new Map([
    ["CV100", "Conviban"],
    ["CV25", "Conviban"],
    ["CV50", "Conviban"],
    ["GUA", ""],
    ["IVY", ""],
  ]);
  const blocks = familyBlocks(axis, familyOf);
  // The one-product family sits FIRST on this axis on purpose: ranking families by size would put
  // Conviban ahead of it, so this assertion can only pass if the axis order is what is honoured.
  assert.deepEqual(
    blocks.map((block) => block.name),
    ["Guamusin", "Conviban", "Ivyronc"],
    "families appear where their FIRST product sits on the axis, never re-sorted by size",
  );
  // Conviban's three concentrations are split apart on the axis by Ivyronc, so this also proves a
  // family is COLLECTED rather than merely read off adjacent columns.
  assert.deepEqual(
    blocks[1].products.map((product) => product.code),
    ["CV100", "CV25", "CV50"],
    "the concentrations inside a family keep the axis order too",
  );
  // A product the master gave no family stands as its own family. Collecting them into one "Other"
  // bin would put a money total over unrelated products, which is the very thing families exist to
  // prevent.
  assert.equal(blocks[0].name, "Guamusin");
  assert.equal(blocks[0].products.length, 1);
  assert.equal(blocks[2].name, "Ivyronc");
  // Every product must survive the grouping - a family layout that drops a column is worse than no
  // family layout at all.
  assert.equal(
    blocks.reduce((sum, block) => sum + block.products.length, 0),
    axis.length,
  );

  // ── trendPair: a gap week must never become an arrow ─────────────────────────────────────────
  //
  // A week a distributor never sent reads 0 and its sales sit in the next week that did arrive.
  // Comparing W4 against a zeroed W3 would paint green on every row of the recovery week and red on
  // every row of the gap - a whole sheet of confident arrows pointing at a filing accident. So the
  // pair is drawn only from weeks that carry money across the whole sheet.
  assert.deepEqual(
    trendPair(new Map([[1, 100], [2, 120], [3, 0], [4, 90]])),
    { last: 4, prev: 2 },
    "W3 sent no sheet, so the comparison must skip it and reach back to W2",
  );
  assert.deepEqual(trendPair(new Map([[1, 100], [2, 120]])), { last: 2, prev: 1 });
  assert.equal(trendPair(new Map([[1, 100]])), null, "one live week cannot show a direction");
  assert.equal(trendPair(new Map([[1, 0], [2, 0]])), null);
  assert.equal(trendPair(new Map()), null);

  // ── trendMark: silence is a valid answer ────────────────────────────────────────────────────
  assert.equal(trendMark(120, 100)?.glyph, "\u25B2");
  assert.equal(trendMark(80, 100)?.glyph, "\u25BC");
  // A branch that sold nothing in EITHER week gets no arrow. A flat marker there reads as "steady",
  // which is a claim about a branch that did not trade at all.
  assert.equal(trendMark(0, 0), null);
  assert.equal(trendMark(100, 100), null, "identical weeks are not a direction");
  // First sale of the period is a rise, not a nothing.
  assert.equal(trendMark(50, 0)?.glyph, "\u25B2");
  assert.equal(trendMark(0, 50)?.glyph, "\u25BC");

  // ── shareOut: the family figures must add to the row total, negatives included ───────────────
  //
  // This is why conserveRound is not reused here. That one hands out whole UNITS and refuses to take
  // a cell below zero, which is right for units and wrong for money: a family carrying returns is
  // legitimately negative, and a branch whose whole month is returns has a negative total.
  assert.equal(shareOut([100.4, 200.4, 300.4], 601).reduce((sum, value) => sum + value, 0), 601);
  assert.equal(shareOut([-50.5, 200.2], 150).reduce((sum, value) => sum + value, 0), 150);
  assert.equal(shareOut([-10.4, -20.4], -31).reduce((sum, value) => sum + value, 0), -31);
  // The residue lands on the LARGEST family by absolute size, where a few EGP cannot be seen -
  // never on a small one, where it would be a visible fraction of that family.
  const shared = shareOut([1.5, 1000.5], 1002);
  assert.equal(shared[0], 2);
  assert.equal(shared[1], 1000);
  assert.deepEqual(shareOut([], 0), []);

  // ── comparableDistributors: the arrow may only compare like with like ───────────────────────
  //
  // This is the rule the first build lacked, and live data punished it immediately. Ibn Sina is 30%
  // of the CNS line and sent no sheet in W3, so W3 was low but NOT zero - the sheet-wide zero check
  // let it through, and the area tab then printed 47 rising arrows against 1 falling. Every one of
  // them was the missing sheet, not a rise. A distributor therefore counts toward the arrow only if
  // it reported in BOTH of the weeks being compared.
  const feed = [
    { distributorCode: "IBN", weekNumber: 4, salesValue: 900 },
    { distributorCode: "POS", weekNumber: 3, salesValue: 100 },
    { distributorCode: "POS", weekNumber: 4, salesValue: 150 },
    { distributorCode: "EGD", weekNumber: 3, salesValue: 80 },
  ];
  const both = comparableDistributors(feed, 4, 3);
  assert.deepEqual([...both], ["POS"], "only the distributor present in BOTH weeks may drive an arrow");
  assert.ok(!both.has("IBN"), "a distributor that skipped W3 must not make W4 look like growth");
  assert.ok(!both.has("EGD"), "a distributor that stopped after W3 must not make W4 look like decline");
  // A zero-value row is a distributor that did not really report; it must not qualify either.
  assert.deepEqual(
    [...comparableDistributors(
      [
        { distributorCode: "POS", weekNumber: 3, salesValue: 0 },
        { distributorCode: "POS", weekNumber: 4, salesValue: 150 },
      ],
      4,
      3,
    )],
    [],
  );
  assert.deepEqual([...comparableDistributors([], 4, 3)], []);

  // -- shareTrend: the arrow measures ground gained, not money -------------------------------------
  //
  // comparableDistributors alone did not fix the green wall, because a distributor can send a sheet
  // that is real but PARTIAL. Measured live: Ibn Sina priced 13 of 14 CNS products in W2 and W4 but
  // only 4 in W3, so it passed the presence test while its W3 money was a quarter of its own normal
  // week. Line-wide that made W4 (1,374,341) four times W3 (342,712), and four-times-everything is
  // not a fact about any one branch. Dividing by the line cancels whatever the two sheets shared and
  // leaves the only comparison a manager can act on: whose slice of the line grew.
  const line = { last: 1_374_341, prev: 342_712 };

  // Money up 3x, but the line went up 4x: this row LOST ground and must read red.
  assert.equal(
    shareTrend({ last: 300_000, prev: 100_000 }, line.last, line.prev)?.glyph,
    "▼",
    "tripling while the line quadruples is a loss of share, and must not print a green arrow",
  );
  // Money up 5x against the line's 4x: real gain.
  assert.equal(shareTrend({ last: 500_000, prev: 100_000 }, line.last, line.prev)?.glyph, "▲");
  // Money FELL, but the line fell harder: ground gained.
  assert.equal(shareTrend({ last: 50, prev: 100 }, 100, 1000)?.glyph, "▲");
  // Exactly proportional movement is no news at all, in either direction.
  assert.equal(shareTrend({ last: 400, prev: 100 }, 4000, 1000), null);
  // A line that carried nothing in one of the weeks cannot support any claim.
  assert.equal(shareTrend({ last: 10, prev: 0 }, 0, 100), null);
  assert.equal(shareTrend({ last: 10, prev: 0 }, 100, 0), null);
  // A row that traded in neither week stays silent rather than reading as a fall.
  assert.equal(shareTrend({ last: 0, prev: 0 }, 100, 100), null);
}
