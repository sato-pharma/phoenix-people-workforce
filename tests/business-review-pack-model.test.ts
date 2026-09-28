import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConcentration, type ReviewSalesDetail } from "@/lib/business-review/concentration";
import { buildSalesReviewPack, type PackCell, type PackInput } from "@/lib/business-review/pack/model";
import { packDocumentHtml } from "@/lib/business-review/pack/pdf";
import { buildSpecialtyMix } from "@/lib/business-review/specialty-mix";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Sales Review pack's model — what goes IN the file, before anything decides how to draw it.
 *
 * Two things this file guards, and neither is cosmetic:
 *
 *   1. EVERY HONESTY RULE THE SCREEN CARRIES TRAVELS WITH ITS SECTION. A pack is read away from the
 *      page, in a meeting, by somebody who cannot ask what a column means. The sentence that says
 *      an achievement is the AREA's, or that the months do not sum, has to be IN the file.
 *   2. A SECTION WITH NOTHING TO SAY IS DROPPED. A deck with a blank slide headed "Brick spread"
 *      tells a room the district sold through no bricks.
 */

const MODEL = "src/lib/business-review/pack/model.ts";
const ROUTE = "app/api/business-review/pack/route.ts";
const AUDIT = "src/lib/admin/audit.ts";

const area = (code: string, ach: number | null, sales: number) =>
  ({
    allProducts: { ach, graded: sales, sales, target: 1000 },
    area: `Area ${code}`,
    areaCode: code,
    customersTotal: 12,
    dm: "A District Manager",
  }) as unknown as PackInput["areas"][number];

const person = (name: string, areaCode: string | null, fieldVisits: number) =>
  ({
    areaCode,
    customers: 9,
    customersByMonth: { "2026-07": 5, "2026-08": 7 },
    fieldVisits,
    hrId: name,
    name,
    visitSplit: { am: 1, pharmacies: 1, pm: 2 },
  }) as unknown as PackInput["people"][number];

function input(overrides: Partial<PackInput> = {}): PackInput {
  return {
    areas: [area("CA1", 91.2, 500)],
    concentration: null,
    coverageNote: "Every figure covers Jul – Aug 2026.",
    dms: [],
    generatedAt: "2026-09-26T12:00:00.000Z",
    months: ["2026-07", "2026-08"],
    people: [person("A Rep", "CA1", 40)],
    selection: [],
    subject: { level: "district", line: "pedia", title: "Cairo district", windowLabel: "Jul – Aug 2026" },
    visitsAvailable: true,
    ...overrides,
  };
}

export function runBusinessReviewPackModelTests() {
  // ------------------------------------------------------------------ 1. nothing ticked, nothing in it
  {
    const pack = buildSalesReviewPack(input({ selection: [] }));
    assert.deepEqual(pack.sections, [], "an empty selection produces an empty pack, not a default one");
    assert.equal(pack.coverageNote, "Every figure covers Jul – Aug 2026.", "but the window still travels with it");
  }

  // ------------------------------------------------------------------ 2. the rep row's sentence
  {
    const pack = buildSalesReviewPack(input({ selection: ["rep-rows"] }));
    const section = pack.sections.find((s) => s.metric === "rep-rows");
    assert.ok(section, "rep-rows was ticked and produced a section");
    assert.deepEqual(
      section.columns[2],
      "Area achievement",
      "the column names whose achievement it is — a bare 'Achievement' beside a name reads as a personal score",
    );
    assert.match(
      section.note,
      /shared by everyone standing in it/,
      "and the note says so in the FILE, because a pack is read away from the page by somebody who cannot ask",
    );
    assert.match(section.note, /targets are set per area, never per rep/);
  }

  // ------------------------------------------------------------------ 3. the months that do not sum
  {
    const pack = buildSalesReviewPack(input({ selection: ["customers-per-month"] }));
    const section = pack.sections.find((s) => s.metric === "customers-per-month");
    assert.ok(section);
    assert.match(
      section.note,
      /do NOT add up to the window/,
      "a reader who adds the row across gets a different number and must be told why BEFORE he does",
    );
    // 5 + 7 = 12, and the window is 9. The row carries both, on purpose.
    assert.deepEqual(section.rows[0], ["A Rep", 9, 5, 7]);
  }

  // ------------------------------------------------------------------ 4. a section with nothing to say
  {
    const empty = buildSalesReviewPack(
      input({ people: [person("No Area", null, 0)], selection: ["rep-rows", "customers-per-month"] }),
    );
    assert.equal(
      empty.sections.find((section) => section.metric === "rep-rows"),
      undefined,
      "a person with no area has nothing to sit beside, so Rep by rep is absent rather than exported empty",
    );
    // He IS still in the customers table: the two sections answer different questions, and somebody
    // the attribution could not place still reached real customers. Dropping him there would lose
    // them. This is the distinction the first draft of this assertion collapsed.
    assert.ok(
      empty.sections.some((section) => section.metric === "customers-per-month"),
      "but he keeps his customers, which are real whether or not his area resolved",
    );

    const noVisits = buildSalesReviewPack(input({ selection: ["customers-per-month"], visitsAvailable: false }));
    assert.equal(
      noVisits.sections.length,
      0,
      "and when the CRM holds nothing for the window, the section is absent rather than a page of zeros",
    );
  }

  // ------------------------------------------------------------------ 5. concentration only when loaded
  {
    const withoutRead = buildSalesReviewPack(input({ selection: ["brick-spread", "channel-split"] }));
    assert.equal(withoutRead.sections.length, 0, "ticked but never loaded is not the same as loaded and empty");

    const rows: ReviewSalesDetail[] = [
      { areaCode: "CA1", brickId: "B1", brickName: "Tanta", channel: "distributor", clientCode: "C1", clientName: "One", period: "2026-07", value: 800 },
      { areaCode: "CA1", brickId: "B2", brickName: "Mahalla", channel: "wholesaler", clientCode: "C2", clientName: "Two", period: "2026-07", value: 200 },
    ];
    const loaded = buildSalesReviewPack(
      input({ concentration: buildConcentration(rows), selection: ["brick-spread", "channel-split"] }),
    );
    const bricks = loaded.sections.find((s) => s.metric === "brick-spread");
    const channels = loaded.sections.find((s) => s.metric === "channel-split");
    assert.ok(bricks && channels);
    assert.equal(bricks.rows.length, 2);
    assert.match(bricks.note, /Concentrated|Spread|Narrow|one brick/, "the spread reading travels with the table");
    assert.equal(channels.rows.length, 3, "all three channels, so the shares can be read against each other");
  }

  // ------------------------------------------------------------------ 6. the specialty note
  {
    const mix = buildSpecialtyMix([
      { contactCrmId: 1, speciality: "Pediatrics", visits: 3 },
      { contactCrmId: 2, speciality: "Pharmacy", visits: 1 },
    ]);
    const pack = buildSalesReviewPack(
      input({
        dms: [{ dm: "A District Manager", dmSeatId: "SEAT-1", specialityMix: mix }] as unknown as PackInput["dms"],
        selection: ["specialty-mix"],
      }),
    );
    const section = pack.sections.find((s) => s.metric === "specialty-mix");
    assert.ok(section);
    assert.match(section.title, /A District Manager/, "one section per district, named");
    assert.match(section.note, /2 customers/);
    for (const verdict of ["too many", "too few", "poor", "healthy"]) {
      assert.ok(!section.note.toLowerCase().includes(verdict), `the note must pass no verdict ("${verdict}")`);
    }
  }

  // ------------------------------------------------------------------ 7. the route trusts the session
  {
    const route = stripComments(readFileSync(ROUTE, "utf8"));
    assert.ok(
      route.includes("loadReviewPortalScope"),
      `${ROUTE}: the scope must be resolved from the SESSION. Without it the route has no idea who ` +
        `is asking.`,
    );
    // 🔴 THIS ASSERTION CHANGED ON 2026-09-26, AND THE PROTECTION GOT STRONGER, NOT WEAKER.
    //
    // It used to forbid the route reading `line` or `dm` from the request at all, which was exactly
    // right while a pack's SCOPE was also its LEVEL. The owner then ruled that everyone exports "as
    // he is filtered or as his scope" — a district manager one of his own areas or his whole region,
    // a Super Admin one line, or one line inside one region — so those parameters now exist on
    // purpose and forbidding them would forbid the feature.
    //
    // What must stay impossible is a PARAMETER WIDENING A SCOPE. So the rule moved from "do not read
    // it" to "read it only through the narrowing module": `territoriesInScope` is built from the
    // session alone and `resolveReviewFilter` can only remove from that list, so the widest any URL
    // can resolve to is the viewer's own scope. Pinned in full by business-review-scope-filter.
    assert.ok(
      route.includes("territoriesInScope(scope,") && route.includes("resolveReviewFilter("),
      `${ROUTE}: a filter from the request must pass through resolveReviewFilter, which can only ` +
        `narrow the list territoriesInScope built from the SESSION. Selecting data straight from a ` +
        `line or district parameter is how a URL becomes a scope.`,
    );
    assert.ok(
      !/loadReviewPortalScope\(\{[^}]*params\.get/.test(route),
      `${ROUTE}: no request value may reach loadReviewPortalScope — the scope is the session's alone.`,
    );
    assert.ok(
      !/getReviewDataset\(\s*review\s*,\s*params\.get/.test(route),
      `${ROUTE}: a dataset must never be chosen straight from a request parameter.`,
    );
    assert.ok(
      route.includes("narrowSelection"),
      `${ROUTE}: a selection from the request must be narrowed to what the RESOLVED level can ` +
        `answer, or a company link exports company sections to a district manager.`,
    );
    assert.ok(route.includes("writeAuditLog"), `${ROUTE}: this hands out a performance document about named people.`);

    // ...and the type it writes must be DECLARED in the union, or the row cannot be typed at all.
    // `AuditEntityType` is erased at runtime, so only a source read can pin this — the same reason
    // the hiring-documents, vacation-purge and weekly-planning suites each pin their own. CI caught
    // it here once (TS2820, "Did you mean 'business_review_export'?"); this is what catches the next
    // one, beside the assertion that requires the write in the first place.
    const entityType = /entityType:\s*"([a-z_]+)"/.exec(route)?.[1];
    assert.ok(entityType, `${ROUTE}: the audit row must name an entity type.`);
    assert.ok(
      stripComments(readFileSync(AUDIT, "utf8")).includes(`| "${entityType}"`),
      `${AUDIT}: AuditEntityType must declare "${entityType}". A pack that hands somebody a `  +
        `performance document about named people must not be the one thing that fails to log.`,
    );
  }

  // ------------------------------------------------------------------ 8. neither renderer computes
  {
    const model = stripComments(readFileSync(MODEL, "utf8"));
    for (const file of [
      "src/lib/business-review/pack/pdf.ts",
      "src/lib/business-review/pack/workbook.ts",
      "src/lib/business-review/pack/pptx.ts",
    ]) {
      const source = stripComments(readFileSync(file, "utf8"));
      assert.ok(
        !/loadBusinessReview|buildConcentration|buildSpecialtyMix/.test(source),
        `${file}: a renderer must READ the pack model, never derive a figure. Two files exported a ` +
          `minute apart would otherwise disagree in front of the reader's own manager.`,
      );
    }
    assert.ok(model.includes("note:"), `${MODEL}: sections must carry their note.`);
  }

  // ------------------------------------------------------------------ 9. the PDF renders Arabic, not tofu
  //
  // Brick names and many customer names are Arabic. The owner reported both a brick showing its CODE
  // and the Arabic reading wrong. The renderer must embed an Arabic face (no Chromium this runs on —
  // production, CI — installs one), reach it through the fallback stack, and mark cell direction so an
  // Arabic run orders and shapes correctly. `packDocumentHtml` is pure, so this needs no Chromium.
  {
    const rows: ReviewSalesDetail[] = [
      { areaCode: "CA1", brickId: "B215-2", brickName: "كوم حماده", channel: "distributor", clientCode: "C1", clientName: "مخزن القادسية", period: "2026-07", value: 800 },
      { areaCode: "CA1", brickId: "B2", brickName: "زفته", channel: "wholesaler", clientCode: "C2", clientName: "Two", period: "2026-07", value: 200 },
    ];
    const pack = buildSalesReviewPack(
      input({ concentration: buildConcentration(rows), selection: ["brick-spread", "customer-concentration"] }),
    );
    const html = packDocumentHtml(pack);
    assert.match(html, /@font-face\{font-family:"Amiri Quran"/, "an Arabic face is embedded so a name is never tofu on a font-less server");
    assert.match(html, /data:font\/ttf;base64,[A-Za-z0-9+/]{500,}/, "and the face is actually inlined, not just named");
    assert.ok(html.includes('dir="auto"'), "cells carry dir=auto so an Arabic run orders and shapes correctly");
    assert.match(html, /--text:[^;]*Amiri Quran/, "the text face falls back to the Arabic face for Arabic glyphs");
    assert.ok(html.includes("كوم حماده"), "the Arabic brick NAME travels into the file — never the code");
  }

  // ------------------------------------------------------------------ 10. the brick label is a NAME, never the code
  {
    const src = stripComments(readFileSync("src/lib/business-review/sources/closing-detail.ts", "utf8"));
    assert.match(src, /source_of_sales_bricks/, "brick names are resolved from the master, not invented");
    assert.match(src, /brick_name/, "and read the master's name column");
    assert.match(src, /brickNames\.get\(row\.brickId\)/, "the label prefers the resolved name over the id");
    assert.ok(
      !/brickName:\s*row\.brickId\s*\|\|\s*"No brick recorded"/.test(src),
      "closing-detail.ts: the brick label must not be the code alone — the owner's rule is names, never codes.",
    );
  }

  // ------------------------------------------------------------------ 11. a bar can never disagree with its row
  // The whole reason the charts are built in the MODEL: every bar is a figure the section's own table
  // also prints. A chart assembled in a renderer, or from a second query, is how a deck's picture comes
  // to contradict the table under it in front of a room.
  {
    const areas = [area("CA1", 131.1, 500), area("CA2", 88.4, 300), area("CA3", null, 0)];
    const pack = buildSalesReviewPack(input({ areas, selection: ["achievement"] }));
    const section = pack.sections.find((s) => s.metric === "achievement");
    assert.ok(section?.chart, "the areas section carries a chart");
    assert.equal(section.chart.unit, "pct");
    assert.deepEqual(
      section.chart.items.map((i) => i.value),
      [131.1, 88.4],
      "graded areas only, best first — an ungradeable area has no percentage, and a 0% bar would accuse it of failing",
    );
    // Annotated: `assert.ok(row, …)` narrows `row`, which makes its own inferred type self-referential
    // (TS7022). A local run cannot see that — `pnpm run test` strips types — so CI is the gate.
    const rows: PackCell[][] = section.rows;
    for (const item of section.chart.items) {
      const row = rows.find((r) => r[0] === item.label);
      assert.ok(row, `every bar is a row of this same table: ${item.label}`);
      assert.equal(row[2], `${(item.value as number).toFixed(1)}%`, "and carries that row's own figure");
    }
    assert.deepEqual(section.chart.reference, { label: "90% earner", value: 90 }, "read against the earner mark");
  }

  // ------------------------------------------------------------------ 12. a UNION is never charted
  // 🔴 Customers and visiting reps are unions across people — a doctor seen by two reps is ONE customer.
  // Bars of a summed union would double-count him, so that section deliberately has no chart. The rep
  // chart plots VISITS, which belong to one rep each and do add.
  {
    const pack = buildSalesReviewPack(input({ selection: ["customers-per-month", "rep-rows"] }));
    const months = pack.sections.find((s) => s.metric === "customers-per-month");
    assert.ok(months);
    assert.ok(!months.chart, "unique customers per month carries NO chart — the months are unions and do not sum");

    const reps = buildSalesReviewPack(
      input({
        people: [person("Rep A", "CA1", 40), person("Rep B", "CA1", 12)],
        selection: ["rep-rows"],
      }),
    ).sections.find((s) => s.metric === "rep-rows");
    assert.ok(reps?.chart);
    assert.equal(reps.chart.unit, "count");
    assert.equal(reps.chart.countSuffix, "visits");
    assert.deepEqual(reps.chart.items.map((i) => i.value), [40, 12], "the bars are his visits, busiest first");
    assert.ok(
      !reps.chart.items.some((i) => String(i.value).includes("%")),
      "never the percentage beside him — that one is his AREA's, shared with everyone standing in it",
    );
    assert.match(reps.chart.capNote ?? "", /AREA's/i, "and the chart says so on its own face");
  }

  // ------------------------------------------------------------------ 13. the cost chart is money, not a score
  // Spend per point is a measure where a LONGER bar is a WORSE result. Charted, a room reads the winner
  // as the longest bar and gets it exactly backwards, so the bars are total spend and the note says so.
  {
    const dms = [
      { allProducts: { ach: 80 }, dm: "DM One", marketingCost: 1000, outstationCost: 500 },
      { allProducts: { ach: 40 }, dm: "DM Two", marketingCost: 200, outstationCost: 0 },
    ] as unknown as PackInput["dms"];
    const section = buildSalesReviewPack(input({ dms, selection: ["marketing-committed"] })).sections.find(
      (s) => s.metric === "marketing-committed",
    );
    assert.ok(section?.chart);
    assert.equal(section.chart.countSuffix, "EGP");
    assert.deepEqual(
      section.chart.items.map((i) => i.value),
      [1500, 200],
      "marketing plus outstation, largest first — never spend per point",
    );
    assert.match(section.chart.capNote ?? "", /cost, never a score/i);
  }

  // ------------------------------------------------------------------ 14. no page runs under the plinth
  // 🔴 The failure this guards: a body row is not one fixed height. A wrapped name grows it by half
  // again, so paginating on a fixed COUNT put twelve wrapped rows on a page that holds ten and printed
  // the footer over the plinth — measured in Chromium at 831.8px on a 793.7px sheet, clipped. Rows are
  // packed by estimated height instead. This asserts the renderer still budgets rather than counts.
  {
    const src = stripComments(readFileSync("src/lib/business-review/pack/pdf.ts", "utf8"));
    assert.ok(
      !/const\s+(WIDE|NARROW)_PER_PAGE/.test(src),
      "pdf.ts: a fixed rows-per-page constant is the bug — pages are budgeted by height.",
    );
    assert.match(src, /function paginateByHeight/, "pdf.ts: rows are packed by their estimated height");
    assert.match(src, /rowHeightPx/, "and a row's height accounts for the lines it wraps to");
    assert.match(src, /TABLE_BOX_PX\s*=\s*481\.7/, "pdf.ts: the box is the table top to the FOOTER (689.1px), never the plinth at 771.");

    // A wide section whose every row wraps must split into more pages than one of short rows.
    const long = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        person(`Rep With A Very Long Four Part Egyptian Name Number ${i}`, "CA1", 500 - i),
      );
    const pack = buildSalesReviewPack(input({ people: long(24), selection: ["rep-rows"] }));
    const html = packDocumentHtml(pack);
    const perPage = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(
      (m) => (m[1].match(/<tr[ >]/g) ?? []).length,
    );
    assert.ok(perPage.length >= 3, `24 wrapping rows need at least 3 pages, got ${perPage.length}`);
    assert.ok(
      perPage.every((n) => n <= 10),
      `no page may carry more than ten wrapped rows — got ${perPage.join(",")}`,
    );
  }

  // ------------------------------------------------------------------ 15. a chart label is never cut
  // A bar label is anchored at the right of its column and runs LEFTWARD, so one too long does not wrap
  // or ellipsise — it runs off the viewBox and is silently clipped. That is how a real rep first printed
  // as "hamed Raffat Mohamed Elsherbiny". The owner's rule is no truncation, ever.
  {
    const src = stripComments(readFileSync("src/lib/business-review/pack/pdf.ts", "utf8"));
    assert.match(src, /const GLYPH = 0\.62/, "pdf.ts: the glyph estimate must cover the WORST advance (0.598 measured), not the average.");
    assert.match(src, /longestLabel/, "pdf.ts: the label column is sized to the longest label");
    assert.match(src, /labelFs/, "and below the cap the type shrinks rather than the name being cut");

    const people = [
      person("Mahmoud Mohamed Ahmed Ibrahim AlSlamony Extended", "CA1", 90),
      person("Short Name", "CA1", 10),
    ];
    const html = packDocumentHtml(buildSalesReviewPack(input({ people, selection: ["rep-rows"] })));
    assert.ok(
      html.includes("Mahmoud Mohamed Ahmed Ibrahim AlSlamony Extended"),
      "the whole name is in the file — never an ellipsis, never a cut",
    );
    const chartSvg = html.match(/<div class="chart">\s*<svg viewBox="0 0 ([\d.]+) [\d.]+"[\s\S]*?<\/svg>/);
    assert.ok(chartSvg, "the chart is inline SVG — vector, never a raster layer per page");
    const width = Number(chartSvg[1]);
    const label = chartSvg[0].match(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end" font-size="([\d.]+)"/);
    assert.ok(label, "the bar labels are anchored at the right of their own column");
    const labelEnd = Number(label[1]);
    const labelFs = Number(label[2]);
    assert.ok(labelEnd <= width * 0.47, `the label column stays inside the chart: ${labelEnd} of ${width}`);
    // 0.6 em is the real worst-case advance measured in Chromium for these names. The column must be
    // wide enough for the longest one AT THE SIZE IT IS DRAWN — by widening, or by shrinking the type.
    const longest = "Mahmoud Mohamed Ahmed Ibrahim AlSlamony Extended".length;
    assert.ok(
      longest * labelFs * 0.6 <= labelEnd + 1,
      `the longest name needs ${(longest * labelFs * 0.6).toFixed(0)} units at ${labelFs}pt but the column is ${labelEnd} — it would be clipped`,
    );
  }

  // ------------------------------------------------------------------ 16. the TABLE estimate uses the same real glyph
  // 🔴 The chart labels were corrected to 0.6 em but the row-height estimate was left at 0.5, so a
  // 31-character district-manager name was predicted to fit a 34.8-character column, wrapped anyway,
  // and the Cairo region pack's third page finished 3.8px past its footer. Both estimates read the
  // same measured advance now, or a multi-line pack silently overruns again.
  {
    const src = stripComments(readFileSync("src/lib/business-review/pack/pdf.ts", "utf8"));
    assert.match(
      src,
      /const CHAR_PX = 6\.88/,
      "pdf.ts: a table cell's glyph estimate must cover the worst advance (0.6 em), like the chart's.",
    );

    // The real shape that overran: seven columns, a line column, and full four-part manager names.
    const wide = Array.from({ length: 26 }, (_, i) =>
      ({
        allProducts: { ach: 90 - i, graded: 500, sales: 500, target: 1000 },
        area: `Cairo East ${i}`,
        areaCode: `CA${i}`,
        customersTotal: 12,
        dm: "Mina Farouk Nawar Rizkallah Ibra",
        lineLabel: "Anti-Infective",
      }) as unknown as PackInput["areas"][number],
    );
    const html = packDocumentHtml(buildSalesReviewPack(input({ areas: wide, selection: ["achievement"] })));
    assert.ok(html.includes("Anti-Infective"), "the seven-column layout is the one under test");
    const perPage = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((m) => (m[1].match(/<tr[ >]/g) ?? []).length);
    assert.ok(
      perPage.every((n) => n <= 10),
      `a page of wrapping seven-column rows holds at most ten — got ${perPage.join(",")}. ` +
        "At 0.5 em these 32-character manager names are predicted to fit one line and twelve are packed " +
        "onto a page; at the real 0.6 em they wrap and only eight do.",
    );
  }
}
