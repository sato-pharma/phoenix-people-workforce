import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConcentration, type ReviewSalesDetail } from "@/lib/business-review/concentration";
import { buildSalesReviewPack, type PackInput } from "@/lib/business-review/pack/model";
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
    assert.ok(
      !/params\.get\("line"\)|params\.get\("seat"\)|params\.get\("dm"\)/.test(route),
      `${ROUTE}: the scope must never be read from the request — a line or seat parameter would let ` +
        `anyone export any district by editing a URL.`,
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
    for (const file of ["src/lib/business-review/pack/pdf.ts", "src/lib/business-review/pack/workbook.ts"]) {
      const source = stripComments(readFileSync(file, "utf8"));
      assert.ok(
        !/loadBusinessReview|buildConcentration|buildSpecialtyMix/.test(source),
        `${file}: a renderer must READ the pack model, never derive a figure. Two files exported a ` +
          `minute apart would otherwise disagree in front of the reader's own manager.`,
      );
    }
    assert.ok(model.includes("note:"), `${MODEL}: sections must carry their note.`);
  }
}
