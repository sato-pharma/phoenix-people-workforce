import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MILESTONE_GROUP_GEOMETRY,
  MILESTONE_GROUP_LAYOUT_SCRIPT,
  milestoneGroupCardHtml,
  milestoneGroupCardSvg,
  milestoneGroupGrid,
  milestoneGroupPageSizeMm,
  type MilestoneGroupCardInput,
} from "@/lib/milestones/group-card";
import {
  milestoneGroupCitation,
  milestoneGroupEyebrow,
  milestoneGroupFileName,
  milestoneGroupFooterRight,
  milestoneGroupHeadline,
  milestoneGroupTile,
  resolveMilestoneGroupOccasion,
  MILESTONE_GROUP_MAX,
  MilestoneGroupOccasionError,
  type MilestoneGroupRow,
} from "@/lib/milestones/group";
import { parsePlainDate, type PlainDate } from "@/lib/milestones/periods";
import { findAccessRegistryEntry } from "@/lib/security/access-registry";

/**
 * The group milestone picture — the five things that break it silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE OCCASION. A picture carries ONE seal, one eyebrow and one sentence. Taking the first
 *    ticked row's occasion for everybody would print a statement that is false about the rest, and
 *    nothing on the sheet would show it. So a mixed tick list is refused, in words — and the button
 *    decides from the SAME function, so it can never be enabled for a set the route refuses.
 *
 * 2. THE GRID. Faces are sized from the row width, then cut down if the rows would not fit the
 *    band — and BOTH budgets have to subtract the outer keyline, which sits outside the photograph.
 *    A keyline crossing the rule above the grid, or touching its neighbour's, is invisible in the
 *    source and obvious on the sheet. Asserted for every count from two to the ceiling.
 *
 * 3. THE ARABIC MARK'S RIGHT EDGE. Arabic begins on the right, so a mark bled off that edge loses
 *    the س and the ف. Measured on the EMITTED SVG, never read off the constant.
 *
 * 4. THE LAYOUT PASS. It fits every name to its own frame. Fitting only the first would leave the
 *    rest at full size across their neighbours, and the first one's report would come back valid —
 *    so the renderer counts the reports, and the ids it reaches for must be the ids the SVG emits.
 *
 * 5. NOBODY IS SILENTLY LEFT OFF. The batch skips a record it cannot build; a group picture is asked
 *    for so that everybody is ON it, so the service refuses instead, and no handed-in photograph may
 *    travel — a face beside the wrong name cannot be taken back once the picture is sent.
 *
 * VERIFIED ON THE EMITTED ARTIFACT, not on the source (AGENTS.md §2.1), wherever an artifact exists.
 */

const root = process.cwd();

function date(iso: string): PlainDate {
  const parsed = parsePlainDate(iso);
  assert.ok(parsed, `${iso} is a calendar date`);
  return parsed;
}

function row(periodSpec: string, iso: string, displayName: string): MilestoneGroupRow {
  return { periodSpec, on: date(iso), displayName };
}

/** A picture with `count` faces, half of them without a photograph, for the geometry assertions. */
function sampleInput(count: number): MilestoneGroupCardInput {
  return {
    tile: { numeral: "05", unit: "years" },
    eyebrow: "five years at Sato Pharma",
    headline: "30 September 2026",
    citation:
      "On the thirtieth of September 2026, five colleagues each complete five years with Sato Pharma — five years of work, of trust, and of belonging.",
    footerRight: "30 . 09 . 2026",
    members: Array.from({ length: count }, (_, index) => ({
      displayName: `Mohamed Abd El Rahman Number ${index + 1}`,
      subLine: "Senior Regulatory Affairs Specialist",
      // Half carry a (tiny, valid) picture and half the monogram plate, so both branches are drawn.
      photoDataUri:
        index % 2 === 0
          ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
          : null,
      initials: "MA",
    })),
  };
}

export async function runMilestoneGroupCardTests() {
  // ── 1 ── THE OCCASION RULE ──────────────────────────────────────────────────────────────────────

  const fiveYears = resolveMilestoneGroupOccasion([
    row("5y", "2026-09-30", "Yasmeen Khaled Elsafory"),
    row("5y", "2026-09-30", "Adel El Sayed"),
  ]);
  assert.deepEqual(
    fiveYears,
    { kind: "service", spec: { count: 5, unit: "year" } },
    "two rows on the same service milestone share one occasion",
  );

  const sameBirthday = resolveMilestoneGroupOccasion([
    row("b4", "2026-09-30", "Adel El Sayed"),
    row("b4", "2026-10-02", "Nour Hassan"),
  ]);
  assert.deepEqual(
    sameBirthday,
    { kind: "birthday", ordinal: 4 },
    "the same birthday at Sato Pharma shares one occasion even on two different days",
  );

  // 🔴 THE CASE A SAME-ORDINAL RULE WOULD HAVE REFUSED, and the likeliest one of all: several people
  // born on one day have several different tenures, so their Sato-birthday ordinals differ. The DAY
  // is then the occasion, and the seal carries it.
  const oneDay = resolveMilestoneGroupOccasion([
    row("b2", "2026-09-30", "Adel El Sayed"),
    row("b5", "2026-09-30", "Nour Hassan"),
    row("b9", "2026-09-30", "Omar Gawish"),
  ]);
  assert.deepEqual(
    oneDay,
    { kind: "sharedBirthday", on: date("2026-09-30") },
    "different birthdays at Sato Pharma on ONE day are one occasion",
  );
  assert.deepEqual(
    milestoneGroupTile(oneDay),
    { numeral: "30", unit: "Sep" },
    "and the seal carries the day and the three-letter month, the only thing every face shares",
  );

  for (const [rows, what] of [
    [[row("5y", "2026-09-30", "A"), row("1y", "2026-09-30", "B")], "two different service milestones"],
    [[row("5y", "2026-09-30", "A"), row("b4", "2026-09-30", "B")], "a milestone and a birthday"],
    [[row("b2", "2026-09-30", "A"), row("b5", "2026-10-14", "B")], "two birthdays on two days"],
    [[row("5y", "2026-09-30", "A")], "one person alone"],
  ] as const) {
    assert.throws(
      () => resolveMilestoneGroupOccasion(rows),
      MilestoneGroupOccasionError,
      `${what} cannot share one picture`,
    );
  }

  // The refusal NAMES what is mixed, in words, so the person ticking can fix it without guessing.
  try {
    resolveMilestoneGroupOccasion([row("5y", "2026-09-30", "A"), row("1y", "2026-09-30", "B")]);
    assert.fail("a mixed milestone set must be refused");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    assert.ok(message.includes("five years"), "the refusal names the milestones it found");
    assert.ok(message.includes("first year"), "both of them, not just the first");
    assert.ok(!message.includes("5y") && !message.includes("1y"), "in words, never in spec codes");
  }

  assert.throws(
    () =>
      resolveMilestoneGroupOccasion(
        Array.from({ length: MILESTONE_GROUP_MAX + 1 }, (_, i) => row("5y", "2026-09-30", `P${i}`)),
      ),
    MilestoneGroupOccasionError,
    `past ${MILESTONE_GROUP_MAX} faces the picture is refused rather than printed unrecognisable`,
  );

  // ── 2 ── THE WORDS ──────────────────────────────────────────────────────────────────────────────

  assert.equal(
    milestoneGroupHeadline([date("2026-09-30"), date("2026-09-30")]),
    "30 September 2026",
    "one day is one date",
  );
  assert.equal(
    milestoneGroupHeadline([date("2026-09-27"), date("2026-09-03")]),
    "3 – 27 September 2026",
    "a range inside one month prints the month once, earliest first",
  );
  assert.equal(
    milestoneGroupHeadline([date("2026-10-02"), date("2026-09-28")]),
    "28 September – 2 October 2026",
    "a range across two months prints the year once",
  );
  assert.equal(
    milestoneGroupHeadline([date("2027-01-03"), date("2026-12-27")]),
    "27 December 2026 – 3 January 2027",
    "a range across two years prints both",
  );
  assert.equal(
    milestoneGroupFooterRight([date("2026-09-30"), date("2026-09-30")]),
    "30 . 09 . 2026",
    "the base bar keeps the single card's dotted date when every face is on one day",
  );

  const serviceCitation = milestoneGroupCitation({
    occasion: fiveYears,
    count: 5,
    dates: [date("2026-09-30"), date("2026-09-30")],
  });
  assert.ok(serviceCitation.startsWith("On the thirtieth of September 2026,"), "the date is in words");
  assert.ok(serviceCitation.includes("five colleagues each complete five years"), "and so is the count");
  assert.ok(!serviceCitation.includes("…"), "no ellipsis, ever (owner rule)");
  for (const pronoun of [" his ", " her ", " he ", " she "]) {
    assert.ok(!serviceCitation.includes(pronoun), `no pronouns — ${pronoun.trim()} is not on this sheet`);
  }

  const birthdayCitation = milestoneGroupCitation({
    occasion: oneDay,
    count: 3,
    dates: [date("2026-09-30"), date("2026-09-30"), date("2026-09-30")],
  });
  assert.ok(
    birthdayCitation.includes("share a birthday at Sato Pharma"),
    "a shared birthday says so, and counts birthdays at Sato Pharma — never an age",
  );
  assert.ok(!/\bage\b|\byears old\b/i.test(birthdayCitation), "and never states an age");

  assert.equal(
    milestoneGroupEyebrow(fiveYears),
    "five years at Sato Pharma",
    "the eyebrow is the single card's own wording",
  );

  const fileName = milestoneGroupFileName(fiveYears, [date("2026-09-30")], 5, "png");
  assert.equal(fileName, "five-years-5-people-2026-09-30.png", "the file is named by the occasion");
  assert.ok(!/B-10|HR-\d/.test(fileName), "never an HR id (AGENTS.md §4: names, never codes)");

  // ── 3 ── THE GRID FITS THE BAND, AT EVERY SIZE ──────────────────────────────────────────────────

  const { gridTopPt, gridBottomPt, marginPt, pageWidthPt, pageHeightPt, photoRatio } =
    MILESTONE_GROUP_GEOMETRY;
  assert.ok(pageWidthPt > pageHeightPt, "the group sheet is LANDSCAPE — a row of faces reads across");

  for (let count = 2; count <= MILESTONE_GROUP_MAX; count += 1) {
    const grid = milestoneGroupGrid(count);
    assert.equal(grid.cells.length, count, `${count} faces get ${count} places`);
    assert.ok(grid.photoW > 0 && grid.photoH > 0, `${count}: a face has a real size`);
    assert.ok(
      Math.abs(grid.photoH / grid.photoW - photoRatio) < 0.001,
      `${count}: every portrait stays 4:5 — the shape every milestone photograph is cropped to`,
    );

    for (const [index, cell] of grid.cells.entries()) {
      // The OUTER KEYLINE, not the photograph, is what may not escape the band or the margins.
      const top = cell.y - grid.frame;
      const bottom = cell.y + grid.photoH + grid.captionH;
      const left = cell.x - grid.frame;
      const right = cell.x + grid.photoW + grid.frame;
      assert.ok(top >= gridTopPt - 0.01, `${count}/${index}: the keyline stays below the rule`);
      assert.ok(bottom <= gridBottomPt + 0.01, `${count}/${index}: the caption stays above the seam`);
      assert.ok(left >= marginPt - 0.01, `${count}/${index}: inside the left margin`);
      assert.ok(right <= pageWidthPt - marginPt + 0.01, `${count}/${index}: inside the right margin`);
    }

    // No two faces may overlap — including their keylines, which is the pair a gap equal to twice the
    // frame offset would leave touching.
    for (let a = 0; a < grid.cells.length; a += 1) {
      for (let b = a + 1; b < grid.cells.length; b += 1) {
        const one = grid.cells[a];
        const two = grid.cells[b];
        const apart =
          Math.abs(one.x - two.x) >= grid.photoW + 2 * grid.frame - 0.01 ||
          Math.abs(one.y - two.y) >= grid.photoH + grid.captionH - 0.01;
        assert.ok(apart, `${count}: face ${a} and face ${b} do not overlap`);
      }
    }
  }

  // ── 4 ── THE EMITTED SVG ────────────────────────────────────────────────────────────────────────

  const input = sampleInput(5);
  const svg = milestoneGroupCardSvg(input);

  assert.ok(
    svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="841.89pt" height="595.276pt"`),
    "the trim sheet is A4 turned, exactly",
  );
  const mm = milestoneGroupPageSizeMm("trim");
  assert.ok(Math.abs(mm.width - 297) < 0.5 && Math.abs(mm.height - 210) < 0.5, "297 × 210 mm");

  // 🔴 The Arabic wordmark's right edge, measured on the artifact. 16pt of air to the trim, never past
  // it — Arabic begins on the right, so a bled edge cuts the س and the ف off the two words.
  // Found by its opacity, not by a file name: the mark travels as a base64 data URI, so nothing in
  // the emitted element says which file it came from.
  const watermark = /<image[^>]*opacity="0\.085"[^>]*>/.exec(svg)?.[0];
  assert.ok(watermark, "the Arabic wordmark is on the sheet");
  const arabicX = Number(/x="([\d.]+)"/.exec(watermark)?.[1]);
  const arabicW = Number(/width="([\d.]+)"/.exec(watermark)?.[1]);
  assert.ok(Number.isFinite(arabicX) && Number.isFinite(arabicW), "with a real position and width");
  const arabicRight = arabicX + arabicW;
  assert.ok(
    Math.abs(arabicRight - (pageWidthPt - 16)) < 0.01,
    `the Arabic mark's right edge sits 16pt inside the trim, not at ${arabicRight}`,
  );

  // One fitted name and one fitted sub-line per face, each carrying its own frame and floor.
  assert.equal((svg.match(/data-gname/g) ?? []).length, 5, "five names, one per face");
  assert.equal((svg.match(/data-gsub/g) ?? []).length, 5, "five sub-lines, one per face");
  assert.equal((svg.match(/data-fit=/g) ?? []).length, 10, "every fitted element carries its frame");
  assert.equal((svg.match(/data-floor=/g) ?? []).length, 10, "and the size it stops shrinking at");

  // Every name prints in full. The type shrinks; it is never cut (owner rule: no ellipsis, ever).
  for (const member of input.members) {
    assert.ok(svg.includes(member.displayName), `${member.displayName} prints in full`);
  }
  assert.ok(!svg.includes("…"), "no ellipsis anywhere on the sheet");

  // The monogram plate is drawn for a face with no photograph, and nothing else is.
  //
  // The needle is the sample's WHOLE data URI, not a PNG signature: every PNG's base64 starts
  // `iVBORw0KGgo`, so the brand lockup and the Arabic mark would be counted as faces too.
  const samplePhoto = input.members[0].photoDataUri!;
  assert.equal(
    svg.split(`href="${samplePhoto}"`).length - 1,
    3,
    "three faces carry a photograph",
  );
  assert.equal(
    (svg.match(/class="name" x="[\d.]+" y="[\d.]+" font-size="[\d.]+" fill="#B9D8E9"/g) ?? []).length,
    2,
    "and two carry the monogram plate instead",
  );

  // Phoenix orange appears exactly three times, as it does on the single card: the head seam's
  // lead-in, the seal's numeral, and the base seam's mirrored tick.
  assert.equal((svg.match(/#F97316/g) ?? []).length, 3, "one warm ink, three times");

  // Brand-blue FILLS: four corner ticks per face at two rects each, plus the head seam and the base
  // seam that mirrors it. The eyebrow is brand blue too but is a `<text>`, so `/>` excludes it.
  assert.equal(
    (svg.match(/fill="#0879B8"\/>/g) ?? []).length,
    5 * 8 + 2,
    "four corner ticks per face (two rects each), plus the head seam and its mirror at the base",
  );

  // A group of one is not a group, and the artwork must not pretend otherwise: a 13th face has no
  // place, so the grid would have to invent one.
  assert.equal(milestoneGroupGrid(5).rows, 1, "up to five faces read as one row");
  assert.equal(milestoneGroupGrid(6).rows, 2, "six turn into two");
  assert.equal(milestoneGroupGrid(MILESTONE_GROUP_MAX).rows, 3, "the ceiling is three rows");

  // ── 5 ── THE LAYOUT PASS ────────────────────────────────────────────────────────────────────────

  assert.doesNotThrow(
    () => new Function(`return ${MILESTONE_GROUP_LAYOUT_SCRIPT};`),
    "the layout script must be valid JavaScript — a syntax error is otherwise invisible until print",
  );
  assert.ok(
    MILESTONE_GROUP_LAYOUT_SCRIPT.includes("document.fonts.ready"),
    "it waits for Pinyon Script — an unloaded webfont measures at the fallback's metrics",
  );
  assert.ok(
    !MILESTONE_GROUP_LAYOUT_SCRIPT.includes("</"),
    "no `</` sequence, or inlining it in a <script> closes the tag early — group-card.ts promises this",
  );
  for (const hook of ["[data-gname]", "[data-gsub]", "group-citation"]) {
    assert.ok(MILESTONE_GROUP_LAYOUT_SCRIPT.includes(hook), `the pass reaches for ${hook}`);
  }
  assert.ok(svg.includes('id="group-citation"'), "and the sheet emits #group-citation");

  const previewHtml = milestoneGroupCardHtml(input, { autoLayout: true });
  assert.ok(previewHtml.includes("<script>"), "the preview lays itself out");
  const printHtml = milestoneGroupCardHtml(input);
  assert.ok(!printHtml.includes("<script>"), "the print path does not — it evaluates the pass itself");
  assert.ok(printHtml.includes("@page { size: 841.89pt 595.276pt"), "and prints landscape A4 exactly");
  assert.ok(printHtml.includes("border-radius: 0"), "square corners — the owner's square-edge rule");

  // The renderer's guard is a COUNT of name reports, not a presence check: one valid report for the
  // first name would otherwise pass a picture whose other names printed across their neighbours.
  const render = readFileSync(join(root, "src", "lib", "milestones", "render.ts"), "utf8");
  assert.ok(
    render.includes("names.length !== faces"),
    "the group renderer counts the layout reports against the number of faces",
  );
  assert.ok(
    render.includes("deviceScaleFactor: IMAGE_SCALE"),
    "and the picture is taken at the card's own print resolution, not a screen's",
  );

  // ── 6 ── NOBODY IS SILENTLY LEFT OFF, AND NO PHOTOGRAPH IS HANDED IN ────────────────────────────

  const service = readFileSync(join(root, "src", "lib", "milestones", "service.ts"), "utf8");
  // Between two NAMED anchors, never a byte window — a fixed slice false-fails the moment the file
  // above it shifts by a line.
  const builderStart = service.indexOf("export async function buildMilestoneGroupCardInput");
  const builderEnd = service.indexOf("function jobTitleOf", builderStart);
  assert.ok(builderStart > 0 && builderEnd > builderStart, "the group builder is where this test looks");
  const groupBuilder = service.slice(builderStart, builderEnd);
  assert.ok(
    groupBuilder.includes("MilestoneGroupOccasionError") && groupBuilder.includes("throw"),
    "a face that cannot be built fails the whole picture — never a quietly shorter row of faces",
  );
  assert.ok(
    !groupBuilder.includes("photoUpload") && !groupBuilder.includes("photoFocus"),
    "no handed-in photograph and no framing reach the group: a face beside the wrong name cannot be taken back",
  );
  assert.ok(
    groupBuilder.includes("portraitWidth"),
    "and every portrait is decoded at the size its own tile needs — twelve at full size is ~180 MB in one page",
  );

  const route = readFileSync(join(root, "app", "api", "milestones", "group", "route.ts"), "utf8");
  assert.ok(
    route.includes('assertPermission(access, "milestones", "export")'),
    "the route asserts the publishing right server-side, not in the sidebar",
  );
  assert.ok(route.includes("assertSameOriginMutation"), "it is a mutation, so it is CSRF-guarded");
  assert.ok(
    route.includes("assertExportRateLimit"),
    "and both rendered paths spend an export allowance — Chromium is not cheap",
  );
  assert.ok(
    !route.includes("photoUpload"),
    "the route carries no handed-in photograph at all, so none can travel",
  );
  // Measured inside the handler, not over the imports — an import of `recordMilestonePrint` sits
  // above everything and would satisfy any ordering check by accident.
  const handler = route.slice(route.indexOf("export async function POST"));
  assert.ok(
    handler.indexOf("recordMilestonePrint") > handler.indexOf("const rendered ="),
    "the print log is written AFTER the render succeeds, so a failure leaves no phantom rows",
  );

  const entry = findAccessRegistryEntry("/api/milestones/group", "POST");
  assert.ok(entry, "the route is declared in the access registry");
  assert.deepEqual(
    entry.permission,
    { resource: "milestones", action: "export" },
    "declared on the same publishing right the route asserts",
  );
  assert.equal(entry.csrf.required, true, "and declared as a mutation, so CSRF is required of it");

  const workspace = readFileSync(
    join(root, "src", "components", "milestones", "milestones-workspace.tsx"),
    "utf8",
  );
  assert.ok(
    workspace.includes("resolveMilestoneGroupOccasion"),
    "the button decides from the DOMAIN's rule, so it can never disagree with the route about what is allowed",
  );
  assert.ok(
    workspace.includes("previewSheet"),
    "and the preview pane is told which sheet it is showing — a landscape picture scaled to the portrait width is cropped with no scrollbar",
  );
}
