import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import {
  MILESTONE_CARD_GEOMETRY,
  MILESTONE_CARD_LAYOUT_SCRIPT,
  milestoneCardHtml,
  milestoneCardPageSizeMm,
  milestoneCardSvg,
  type MilestoneCardInput,
} from "@/lib/milestones/card";
import {
  cardDisplayName,
  cardFirstName,
  daysBetween,
  formatMilestoneSpec,
  isFirstDaySpec,
  milestoneCitation,
  milestoneDate,
  milestoneEyebrow,
  milestoneFileName,
  milestoneStripLabel,
  milestoneTileNumeral,
  milestoneTileUnit,
  milestonesBetween,
  ordinalDayWords,
  parseMilestoneSpec,
  parsePlainDate,
  FIRST_DAY_SPEC,
  MILESTONE_SWEEP,
  MilestoneSpecError,
  type PlainDate,
} from "@/lib/milestones/periods";
import { polishPortrait } from "@/lib/milestones/portrait";
import { permissionResources } from "@/lib/auth/permissions";

/**
 * The milestone card — the four things that break it silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE DATE. Every date here is a calendar date, and the one way to get it wrong is to let a
 *    `Date` in. "2026-08-24" parsed as an instant is midnight UTC, which on a machine west of UTC
 *    prints as the 23rd — a card celebrating the wrong day, on some servers, some of the time.
 *
 * 2. THE ARABIC MARK'S RIGHT EDGE. Arabic begins on the right, so a mark bled off that edge loses
 *    the س and the ف. It is laid TO the trim and never past it, and this is measured on the
 *    emitted SVG rather than read off the constant.
 *
 * 3. THE LAYOUT PASS. It fits the name and wraps the citation, and it runs as a STRING in a
 *    browser — so nothing in the TypeScript build can see a syntax error in it, and a card would
 *    print with the name at its unfitted 42pt and the citation on one enormous line. It is
 *    compiled here, and the ids it reaches for are checked against the ids the SVG actually emits.
 *
 * 4. THE PERMISSION. `milestones` must be in BOTH the `PermissionResource` union and the
 *    `permissionResources` array. In one but not the other, the resource is silently permitted to
 *    every role — which on this module means every employee can print any colleague's photograph.
 *
 * VERIFIED ON THE EMITTED ARTIFACT, not on the source (AGENTS.md §2.1) — the assertions below read
 * the generated SVG and HTML strings, never the file that produced them.
 */
export async function runMilestoneCardTests() {
  // ── 1. The date ─────────────────────────────────────────────────────────────────────────────

  assert.deepEqual(parsePlainDate("2026-08-24"), { year: 2026, month: 8, day: 24 });
  assert.deepEqual(parsePlainDate("2026-08-24T00:00:00+00:00"), { year: 2026, month: 8, day: 24 });
  assert.equal(parsePlainDate("2026-02-30"), null, "a day that does not exist is not a date");
  assert.equal(parsePlainDate(""), null);
  assert.equal(parsePlainDate(null), null);

  const yasmeen: PlainDate = { year: 2026, month: 8, day: 24 };
  assert.deepEqual(
    milestoneDate(yasmeen, { count: 1, unit: "month" }),
    { year: 2026, month: 9, day: 24 },
    "the first month of a 24 August hire falls on 24 September",
  );
  assert.deepEqual(milestoneDate(yasmeen, { count: 1, unit: "year" }), { year: 2027, month: 8, day: 24 });

  // Month arithmetic CLAMPS. 31 January + 1 month is the end of February, never the 3rd of March.
  assert.deepEqual(
    milestoneDate({ year: 2026, month: 1, day: 31 }, { count: 1, unit: "month" }),
    { year: 2026, month: 2, day: 28 },
  );
  assert.deepEqual(
    milestoneDate({ year: 2028, month: 1, day: 31 }, { count: 1, unit: "month" }),
    { year: 2028, month: 2, day: 29 },
    "a leap year gets the 29th",
  );
  assert.deepEqual(
    milestoneDate({ year: 2024, month: 2, day: 29 }, { count: 1, unit: "year" }),
    { year: 2025, month: 2, day: 28 },
    "somebody hired on a leap day still has a first anniversary",
  );
  assert.deepEqual(
    milestoneDate({ year: 2026, month: 12, day: 15 }, { count: 1, unit: "month" }),
    { year: 2027, month: 1, day: 15 },
    "December rolls the year",
  );
  assert.deepEqual(
    milestoneDate({ year: 2026, month: 9, day: 23 }, { count: 100, unit: "day" }),
    { year: 2027, month: 1, day: 1 },
    "a hundred days counts through the civil calendar",
  );

  // Cairo runs DST. A day difference must not notice.
  assert.equal(
    daysBetween({ year: 2026, month: 4, day: 20 }, { year: 2026, month: 5, day: 20 }),
    30,
    "a clock change is not a missing day",
  );
  assert.equal(daysBetween({ year: 2026, month: 9, day: 24 }, { year: 2026, month: 9, day: 23 }), -1);
  assert.equal(daysBetween(yasmeen, yasmeen), 0);

  const due = milestonesBetween(yasmeen, { year: 2026, month: 9, day: 1 }, { year: 2026, month: 10, day: 31 });
  assert.equal(due.length, 1, "only the first month falls in that window");
  assert.deepEqual(due[0].spec, { count: 1, unit: "month" });

  // ── 2. Reading a period the way the owner types one ──────────────────────────────────────────

  assert.deepEqual(parseMilestoneSpec("1m"), { count: 1, unit: "month" });
  assert.deepEqual(parseMilestoneSpec("6 months"), { count: 6, unit: "month" });
  assert.deepEqual(parseMilestoneSpec("1y"), { count: 1, unit: "year" });
  assert.deepEqual(parseMilestoneSpec("3 years"), { count: 3, unit: "year" });
  assert.deepEqual(parseMilestoneSpec("100 days"), { count: 100, unit: "day" });
  assert.deepEqual(parseMilestoneSpec("18"), { count: 18, unit: "month" }, "a bare number means months");
  assert.throws(() => parseMilestoneSpec("soon"), MilestoneSpecError);
  assert.throws(() => parseMilestoneSpec("0m"), MilestoneSpecError);
  assert.throws(() => parseMilestoneSpec("900 years"), MilestoneSpecError);

  // ── 3. The words ────────────────────────────────────────────────────────────────────────────

  assert.equal(ordinalDayWords(1), "first");
  assert.equal(ordinalDayWords(24), "twenty-fourth");
  assert.equal(ordinalDayWords(25), "twenty-fifth");
  assert.equal(ordinalDayWords(30), "thirtieth");
  assert.equal(ordinalDayWords(31), "thirty-first");

  assert.equal(milestoneEyebrow({ count: 1, unit: "month" }), "one month at Sato Pharma");
  assert.equal(milestoneEyebrow({ count: 3, unit: "year" }), "three years at Sato Pharma");
  assert.equal(milestoneTileNumeral({ count: 1, unit: "month" }), "01");
  assert.equal(milestoneTileNumeral({ count: 10, unit: "year" }), "10");
  assert.equal(milestoneStripLabel({ count: 1, unit: "year" }), "First year");
  assert.equal(milestoneStripLabel({ count: 100, unit: "day" }), "100 days");

  // ── 3a. The first day as a member of the family ──────────────────────────────────────────────
  //
  // 🔴 THE FIRST DAY IS `0d`, AND THE WHOLE MILESTONE TURNS ON THAT ZERO. `1d` is the day AFTER the
  // hire date — somebody's second morning — so a first-day card built from `1d` would celebrate the
  // wrong day for every person in the company, and nothing on the sheet would show it.
  assert.deepEqual(parseMilestoneSpec("0d"), { count: 0, unit: "day" });
  assert.deepEqual(parseMilestoneSpec("0 days"), { count: 0, unit: "day" });
  assert.deepEqual(parseMilestoneSpec(FIRST_DAY_SPEC), { count: 0, unit: "day" });
  assert.equal(formatMilestoneSpec(FIRST_DAY_SPEC), "0d", "the spec string the ledger stores");
  assert.ok(isFirstDaySpec(FIRST_DAY_SPEC));
  assert.ok(!isFirstDaySpec({ count: 1, unit: "day" }), "one day is the day AFTER the hire date");

  // Zero is DAYS only — a zero month or a zero year is a typo, never an occasion.
  assert.throws(() => parseMilestoneSpec("0y"), MilestoneSpecError);
  assert.throws(() => parseMilestoneSpec("0"), MilestoneSpecError, "a bare 0 means 0 months");

  const joinedOn: PlainDate = { year: 2026, month: 9, day: 30 };
  assert.deepEqual(milestoneDate(joinedOn, FIRST_DAY_SPEC), joinedOn, "the first day IS the hire date");
  assert.deepEqual(
    milestoneDate(joinedOn, { count: 1, unit: "day" }),
    { year: 2026, month: 10, day: 1 },
    "1d is the day after — the trap this milestone must never fall into",
  );

  // The seal reads "01 DAY", never "00": the zero lives in the arithmetic, not on the sheet.
  assert.equal(milestoneTileNumeral(FIRST_DAY_SPEC), "01");
  assert.equal(milestoneTileUnit(FIRST_DAY_SPEC), "day");
  assert.equal(milestoneEyebrow(FIRST_DAY_SPEC), "first day at Sato Pharma");
  assert.equal(milestoneStripLabel(FIRST_DAY_SPEC), "First day");

  const firstDayCitation = milestoneCitation({
    firstName: "Ahmed",
    spec: FIRST_DAY_SPEC,
    on: joinedOn,
  });
  assert.match(firstDayCitation, /^On the thirtieth of September 2026, Ahmed joins Sato Pharma/);
  assert.match(firstDayCitation, /first day as a member of the family/);
  assert.doesNotMatch(
    firstDayCitation,
    /completes/,
    "nothing has been completed on the first day — the sentence says what the day IS",
  );

  // It is SWEPT, which is how a new joiner reaches the due list and the reminder before starting.
  assert.ok(
    MILESTONE_SWEEP.some((spec) => isFirstDaySpec(spec)),
    "the first day must be in the sweep, or a new joiner never surfaces",
  );
  assert.deepEqual(
    milestonesBetween(joinedOn, joinedOn, { year: 2026, month: 10, day: 5 }).map((hit) =>
      formatMilestoneSpec(hit.spec),
    ),
    ["0d"],
    "the week somebody starts holds exactly one milestone — their first day",
  );

  // The ledger's own CHECK constraint (20260923212006_milestone_card_prints_and_notice_marks): a
  // spec string the database refuses is a card that prints and is then never recorded.
  assert.match(formatMilestoneSpec(FIRST_DAY_SPEC), /^(b[0-9]{1,3}|[0-9]{1,5}[dmy])$/);

  // And the picker offers it, first, or nobody can ask for one.
  assert.ok(
    readFileSync(join(process.cwd(), "src/components/milestones/milestones-workspace.tsx"), "utf8")
      .includes('{ value: "0d", label: "First day" }'),
    "the workspace period picker must offer the first day",
  );

  const citation = milestoneCitation({
    firstName: "Yasmeen",
    spec: { count: 1, unit: "month" },
    on: { year: 2026, month: 9, day: 24 },
  });
  assert.match(citation, /^On the twenty-fourth of September 2026, Yasmeen completes one month/);

  // NO PRONOUNS, deliberately: the card must not depend on the gender column being right.
  for (const sentence of [
    citation,
    milestoneCitation({ firstName: "Omar", spec: { count: 1, unit: "year" }, on: yasmeen }),
    milestoneCitation({ firstName: "Omar", spec: { count: 100, unit: "day" }, on: yasmeen }),
    firstDayCitation,
  ]) {
    assert.doesNotMatch(
      sentence,
      /\b(he|she|him|her|his|hers|they|them|their|theirs)\b/i,
      `the citation must name nobody's gender: ${sentence}`,
    );
  }

  // The name on the card is what a colleague would say, never a five-part legal name.
  assert.equal(cardDisplayName("Yasmeen Khaled Elsafory"), "Yasmeen Khaled Elsafory");
  assert.equal(cardDisplayName("Ahmed Mohamed Sayed Abdel Rahman"), "Ahmed Mohamed Rahman");
  assert.equal(cardDisplayName("Ahmed Mohamed Sayed Abdel Rahman", "Ahmed Sayed"), "Ahmed Sayed");
  assert.equal(cardFirstName("Yasmeen Khaled Elsafory"), "Yasmeen");
  assert.equal(cardFirstName("Yasmeen Khaled Elsafory", "Yasso"), "Yasso");

  // A file name carries a NAME, never an HR id (AGENTS.md §4).
  const fileName = milestoneFileName("Yasmeen Khaled Elsafory", { count: 1, unit: "month" }, {
    year: 2026,
    month: 9,
    day: 24,
  });
  assert.equal(fileName, "Yasmeen-Khaled-Elsafory-1m-2026-09-24.pdf");

  // ── 4. The emitted card ─────────────────────────────────────────────────────────────────────

  const input: MilestoneCardInput = {
    displayName: "Yasmeen Khaled Elsafory",
    roleLine: "HR Generalist  ·  Head Office  ·  Cairo",
    employeeId: "HR-009",
    hireDate: yasmeen,
    spec: { count: 1, unit: "month" },
    on: { year: 2026, month: 9, day: 24 },
    citation,
    photoDataUri: null,
    initials: "YE",
  };

  const svg = milestoneCardSvg(input);
  const { pageWidthPt, colours } = MILESTONE_CARD_GEOMETRY;

  // The Arabic mark's ink is laid TO the trim and never past it. Measured on the emitted element.
  const watermark = /<image[^>]*opacity="0\.095"[^>]*>/.exec(svg)?.[0];
  assert.ok(watermark, "the Arabic wordmark is on the card");
  const wmX = Number(/ x="([-\d.]+)"/.exec(watermark)?.[1]);
  const wmW = Number(/ width="([\d.]+)"/.exec(watermark)?.[1]);
  assert.ok(Number.isFinite(wmX) && Number.isFinite(wmW), "the wordmark has a measurable box");
  assert.ok(wmX > 0, "the wordmark does not start off the left edge");
  assert.ok(
    wmX + wmW <= pageWidthPt,
    `the wordmark's RIGHT edge must stay inside the trim — Arabic begins there (${wmX + wmW} > ${pageWidthPt})`,
  );
  assert.ok(pageWidthPt - (wmX + wmW) >= 12, "and it keeps real air, not a hairline, from the trim");

  // The masses and both seams are present, and the Phoenix orange appears only where it belongs:
  // the seam lead-in, the tile numeral and the mirrored tick. Three, never a fourth.
  assert.ok(svg.includes(`height="76" fill="${colours.navy}"`), "the head band is navy");
  assert.equal(
    svg.split(colours.orange).length - 1,
    3,
    "Phoenix orange is the secondary: the lead-in, the numeral and the mirrored tick — nothing else",
  );
  assert.ok(svg.includes(`fill="${colours.brand}"`), "the brand-blue seam is drawn");

  // 🔒 THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.
  assert.doesNotMatch(svg, /\brx=|\bry=|border-radius:\s*[^0]/, "no rounded corners on the card");
  // 🔒 No circles as furniture. A seal is a square tile.
  assert.doesNotMatch(svg, /<circle|<ellipse/, "seals are square tiles, never discs");

  // The monogram plate stands in for a missing photograph rather than leaving a hole.
  assert.ok(svg.includes(">YE</text>"), "no photograph prints the initials");

  // The strip prints BOTH dates, so a reader can see the arithmetic.
  assert.ok(svg.includes("24 August 2026"), "the strip shows the day they joined");
  assert.ok(svg.includes("24 September 2026"), "and the milestone itself");
  assert.ok(svg.includes(">HR-009</text>"), "and the employee id, which is the one code on the page");

  // 🔴 OWNER RULE: never truncate with an ellipsis.
  assert.doesNotMatch(svg, /…|\.\.\./, "nothing on the card is cut off with an ellipsis");

  // ── 5. The variants ─────────────────────────────────────────────────────────────────────────

  const trim = milestoneCardPageSizeMm("trim");
  assert.ok(Math.abs(trim.width - 210) < 0.1 && Math.abs(trim.height - 297) < 0.1, "trim is A4");
  const bleed = milestoneCardPageSizeMm("bleed");
  assert.ok(
    Math.abs(bleed.width - 216) < 0.1 && Math.abs(bleed.height - 303) < 0.1,
    "bleed is A4 plus 3mm on every edge",
  );
  assert.deepEqual(milestoneCardPageSizeMm("safe"), trim, "the safe sheet is still A4 — the ARTWORK shrinks");

  const safeSvg = milestoneCardSvg(input, "safe");
  assert.match(safeSvg, /<g transform="translate\([\d.]+ [\d.]+\) scale\(0\.92\)">/, "the safe sheet scales the artwork");
  const bleedSvg = milestoneCardSvg(input, "bleed");
  assert.match(bleedSvg, /<g transform="translate\([-\d.]+ [-\d.]+\) scale\(1\.0[0-9]+\)">/, "the bleed sheet scales past the trim");
  assert.ok(bleedSvg.includes('fill="#000"'), "and carries crop marks");

  // ── 6. The layout pass ──────────────────────────────────────────────────────────────────────

  // It is a string that runs in a browser, so nothing in the build can see a syntax error in it.
  assert.doesNotThrow(
    () => new Function(`return ${MILESTONE_CARD_LAYOUT_SCRIPT};`),
    "the layout script must be valid JavaScript",
  );

  // The ids it reaches for must be the ids the SVG emits, or the pass throws at print time.
  for (const id of ["card-name", "card-name-rule", "card-citation"]) {
    assert.ok(svg.includes(`id="${id}"`), `the card emits #${id}`);
    assert.ok(MILESTONE_CARD_LAYOUT_SCRIPT.includes(`'${id}'`), `the layout pass reaches for #${id}`);
  }
  assert.ok(
    MILESTONE_CARD_LAYOUT_SCRIPT.includes("document.fonts.ready"),
    "it waits for Pinyon Script — an unloaded webfont measures at the fallback's metrics",
  );
  assert.ok(
    !MILESTONE_CARD_LAYOUT_SCRIPT.includes("</"),
    "no `</` sequence, or inlining it in a <script> tag closes the tag early — card.ts promises this",
  );

  // The preview inlines it; the print path does not, because it evaluates it itself and needs to
  // know the pass finished.
  const previewHtml = milestoneCardHtml(input, { autoLayout: true });
  assert.ok(previewHtml.includes("<script>"), "the preview lays itself out");
  const printHtml = milestoneCardHtml(input);
  assert.ok(!printHtml.includes("<script>"), "the print path does not");
  assert.ok(printHtml.includes("@page { size: 595.276pt 841.89pt"), "and prints at A4 exactly");
  assert.ok(
    printHtml.includes('font-family: "Pinyon Script"') && printHtml.includes("data:font/woff2;base64,"),
    "Pinyon Script is embedded, not linked — setContent has no origin to resolve a path against",
  );

  // ── 7. The permission ───────────────────────────────────────────────────────────────────────

  // In the union but not the array is silently permitted to EVERY role. The union is checked by
  // the compiler the moment the string is written here; the array is checked at runtime.
  assert.ok(
    permissionResources.includes("milestones"),
    "`milestones` must be in permissionResources — a resource in the union alone is open to every role",
  );

  // The routes are the boundary. The page and the sidebar are not.
  const root = process.cwd();
  const dueRoute = readFileSync(join(root, "app", "api", "milestones", "due", "route.ts"), "utf8");
  const cardRoute = readFileSync(join(root, "app", "api", "milestones", "card", "route.ts"), "utf8");
  assert.ok(
    dueRoute.includes('assertPermission(access, "milestones", "read")'),
    "the due list asserts milestones:read server-side",
  );
  assert.ok(
    cardRoute.includes('assertPermission(access, "milestones", "export")'),
    "the card asserts milestones:export server-side",
  );
  assert.ok(
    cardRoute.includes('scope: "export:milestones:card"'),
    "and the PDF path is rate-limited — Chromium is not cheap",
  );

  // ── 8. The screen ───────────────────────────────────────────────────────────────────────────

  // 🔒 THE FITS-THE-SCREEN GOLDEN RULE. `overflow-x-auto` over a min-width IS the bug, so the due
  // list is table-fixed over a colgroup on desktop and cards on a phone.
  const workspace = readFileSync(
    join(root, "src", "components", "milestones", "milestones-workspace.tsx"),
    "utf8",
  );
  assert.ok(!workspace.includes("overflow-x-auto"), "nothing on the milestones screen scrolls sideways");
  assert.ok(workspace.includes("table-fixed") && workspace.includes("<colgroup>"), "the due list is a fixed table");
  assert.ok(workspace.includes("sm:hidden"), "and it becomes cards on a phone");
  assert.doesNotMatch(
    workspace.replace(/rounded-none/g, ""),
    /\brounded-/,
    "🔒 the square-edge rule: no rounded corners on the milestones screen",
  );
  assert.ok(!workspace.includes("truncate"), "🔴 no ellipsis — a long Egyptian name wraps");

  // ── 9. The picker, and the fields that arrive filled in ─────────────────────────────────────

  // 🔴 THE DUE LIST IS NOT THE ROSTER. The owner asked to "type a name and it appears to me", and
  // a screen that can only make a card for somebody in the next thirty days cannot answer that.
  // The name box therefore reads `candidates` — the whole active roster — and NOT `entries`.
  assert.ok(
    workspace.includes("SearchableSelect"),
    "the person is chosen through the house searchable select, not a bare <select> — sibling pages' identity (AGENTS.md §4)",
  );
  assert.ok(
    /candidates\.map\(/.test(workspace),
    "the name box lists the active roster (`candidates`), so anybody can be chosen — not only the thirty-day due list",
  );

  // 🔴 NOTHING IS ASKED FOR THAT THE SYSTEM ALREADY KNOWS (owner, 2026-09-23: "it shows it and I
  // have the option then to edit it but don't let me from scratch"). The screen computes the date
  // and the sentence itself, which is only possible because it imports the arithmetic.
  assert.ok(
    workspace.includes("milestoneDate") && workspace.includes("milestoneCitation"),
    "the screen works the date and the sentence out itself — a blank field is the bug this fixes",
  );
  assert.ok(
    !/placeholder=\{selected \? selected\.displayName/.test(workspace),
    "the name is a VALUE, not a placeholder — a placeholder is an empty field wearing a hint",
  );
  assert.ok(
    /citationEdit !== null/.test(workspace),
    "and a sentence he has typed in stops following the name and the date, so his own wording survives",
  );
  // The three fields hold the OVERRIDE, not the value — which is what lets them be derived during
  // render instead of written into state by an effect. `react-hooks/set-state-in-effect` refuses
  // the effect-shaped version, and it costs a wasted render and a ref that duplicates this state.
  assert.ok(
    !/useEffect\([^)]*setDateEdit|useEffect\([^)]*setNameEdit/.test(workspace),
    "the worked-out values are derived during render, never written into state by an effect",
  );

  // ── 10. Both outputs, and the frame that shows them ─────────────────────────────────────────

  // PDF and PNG, from ONE laid-out page. The picture's resolution comes from the viewport, so the
  // viewport must be set BEFORE the screenshot — a screenshot taken without one is a thumbnail of
  // the corner of the sheet, and it fails by merely looking disappointing.
  const render = readFileSync(join(root, "src", "lib", "milestones", "render.ts"), "utf8");
  assert.ok(
    render.includes("renderMilestoneCardImage"),
    "the card can be taken as a picture as well as as paper (owner, 2026-09-23)",
  );
  const viewportAt = render.indexOf("setViewport");
  const shotAt = render.indexOf("page.screenshot");
  assert.ok(viewportAt > 0 && shotAt > viewportAt, "the viewport is sized before the picture is taken, never after");
  assert.ok(
    /deviceScaleFactor: IMAGE_SCALE/.test(render) && /const IMAGE_SCALE = [4-9]/.test(render),
    "and it is taken at 4× or better — 384 DPI, so the picture can be printed and not only sent",
  );
  assert.ok(
    cardRoute.includes('"image/png"'),
    "the route serves it as a PNG — flat colour, hairlines and type are what JPEG damages most",
  );
  const pngSpec = parseMilestoneSpec("1m");
  const pngOn: PlainDate = { year: 2026, month: 9, day: 25 };
  assert.equal(milestoneFileName("Yasmeen Khaled Elsafory", pngSpec, pngOn, "png"), "Yasmeen-Khaled-Elsafory-1m-2026-09-25.png");
  assert.ok(
    milestoneFileName("Yasmeen Khaled Elsafory", pngSpec, pngOn).endsWith(".pdf"),
    "and the default is still the PDF — adding the picture must not rename every existing download",
  );

  // 🔴 THE PREVIEW IS FRAMED FROM A `blob:` URL, AND THE BASE CSP HAS NO `frame-src`. Framing then
  // falls back to `default-src 'self'`, Chrome refuses the frame, and it paints "This content is
  // blocked. Contact the site owner to fix the issue." — which reads like an ad blocker and sends
  // you looking anywhere but at a header. The owner hit exactly that on 2026-09-23.
  const nextConfig = readFileSync(join(root, "next.config.ts"), "utf8");
  // To the end of the LINE, not to the first `;` — the directive being asserted on begins with a
  // semicolon inside a string literal, so `[^;]*` stops just short of the thing it is looking for.
  const milestoneCsp = /const milestonePreviewCsp =.*/.exec(nextConfig);
  assert.ok(milestoneCsp, "next.config.ts must declare a CSP for the milestones page");
  assert.match(
    milestoneCsp[0],
    /frame-src [^"]*blob:/,
    "milestonePreviewCsp must allow blob: in frame-src, or the card preview is a blank refusal",
  );
  assert.ok(
    nextConfig.includes('source: "/milestones"') && nextConfig.includes('source: "/hr/milestones"'),
    "and it is applied to BOTH spellings — /hr is rewritten onto the admin page after headers match",
  );
  // 🔴 THE FRAME NEVER MOVES; THE PICTURE INSIDE IT DOES, AND THE PICTURE CAN BE HANDED IN.
  // Two owner instructions from 2026-09-23, and they fail in the same silent way: the box on screen
  // shows one crop and the printer produces another, or a card is printed with the wrong face on it.
  //
  // The geometry is asserted for real, not read out of the source. `focus` is a fraction of the
  // SLACK in each axis, which is exactly what CSS `object-position: <x>% <y>%` does over
  // `object-fit: cover` — that identity is the only reason the browser preview and sharp's cut agree
  // without a conversion between them, so if the two branches of `cutPortrait` ever stop meeting,
  // the drag becomes a lie and nothing else in the suite would notice.
  const stripe = await sharp({
    create: { width: 400, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: await sharp({ create: { width: 400, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp({ create: { width: 400, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(), top: 900, left: 0 },
    ])
    .png()
    .toBuffer();

  const topCut = await polishPortrait(stripe, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 0 } });
  const bottomCut = await polishPortrait(stripe, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 1 } });
  assert.ok(topCut, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.ok(bottomCut, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.equal(topCut.width, 320, "320x400 is the portrait module's floor, so that is what comes back");
  assert.equal(topCut.height, 400, "the portrait window is 4:5 whatever the source shape is");

  // Read the whole window's colour balance rather than one pixel: the polish lays a vignette over
  // the frame, which darkens an edge sample far enough to make a pixel test flap. The vignette is
  // grey, so it moves every channel together and the BALANCE between them survives it.
  const topStats = await sharp(topCut.buffer).stats();
  const bottomStats = await sharp(bottomCut.buffer).stats();
  assert.ok(
    topStats.channels[0].mean - topStats.channels[2].mean > 10,
    "focus y=0 pulls the TOP of the photograph into the window — the red band comes with it",
  );
  assert.ok(
    bottomStats.channels[2].mean - bottomStats.channels[0].mean > 10,
    "focus y=1 pulls the BOTTOM in — the blue band. If these two agree, dragging does nothing.",
  );

  // A focus handed back in reproduces the FRAMING it described. Not the same bytes — one path is a
  // single cover pass and the other a resize then an extract, so they round a pixel apart — but the
  // window lands in the same place, which is what the box on screen is promising.
  const chosen = await polishPortrait(stripe, { width: 320, defocus: 0, grain: 0 });
  assert.ok(chosen, "polishPortrait must succeed on a synthetic in-memory PNG");
  const again = await polishPortrait(stripe, { width: 320, defocus: 0, grain: 0, focus: chosen.focus });
  assert.ok(again, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.ok(chosen.focus.y >= 0 && chosen.focus.y <= 1, "the reported focus is a fraction, never a pixel offset");
  assert.equal(again.focus.y, chosen.focus.y, "feeding the reported focus back describes the same window");

  // 🔴 AT ZOOM 1 THE PICTURE CAN ONLY EVER SLIDE ONE WAY, AND THAT IS NOT A BUG TO BE
  // ARGUED WITH — it is what "scaled to exactly cover" means: one axis overhangs, the other is
  // already shown edge to edge with nothing beyond it to pull in. The owner hit exactly this and
  // asked for better on 2026-09-23 ("I need dragging up, down, left, right, and any place I
  // want"). A zoom past 1 is the only thing that puts slack in BOTH axes, so this asserts the
  // stuck axis really does come unstuck — measured, because a drag that does nothing reads as
  // broken and nothing else in the suite would ever notice it.
  const wide = await sharp({
    create: { width: 1000, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: await sharp({ create: { width: 1000, height: 60, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp({ create: { width: 1000, height: 60, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(), top: 340, left: 0 },
      // Side bands too, so left and right are distinguishable as well as top and bottom. Without
      // them the middle of this source is uniform white and a horizontal move is a real no-op.
      { input: await sharp({ create: { width: 60, height: 400, channels: 3, background: { r: 0, g: 200, b: 0 } } }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp({ create: { width: 60, height: 400, channels: 3, background: { r: 200, g: 0, b: 200 } } }).png().toBuffer(), top: 0, left: 940 },
    ])
    .png()
    .toBuffer();

  // 1000x400 against a 4:5 window is far WIDER than the frame, so at zoom 1 the full height is
  // already shown: y=0 and y=1 must be the same picture, however hard anybody drags.
  const flatTop = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 0 } });
  const flatBottom = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 1 } });
  assert.ok(flatTop, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.ok(flatBottom, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.equal(
    Buffer.compare(flatTop.buffer, flatBottom.buffer),
    0,
    "at zoom 1 a wide photograph has NO vertical slack — dragging up or down is geometrically a no-op",
  );

  const zoomTop = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 0, zoom: 2 } });
  const zoomBottom = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 1, zoom: 2 } });
  assert.ok(zoomTop, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.ok(zoomBottom, "polishPortrait must succeed on a synthetic in-memory PNG");
  const zoomTopStats = await sharp(zoomTop.buffer).stats();
  const zoomBottomStats = await sharp(zoomBottom.buffer).stats();
  assert.ok(
    zoomTopStats.channels[0].mean - zoomTopStats.channels[2].mean > 10,
    "🔴 zoomed in, UP now reaches the top of the photograph — this is the owner's whole request",
  );
  assert.ok(
    zoomBottomStats.channels[2].mean - zoomBottomStats.channels[0].mean > 10,
    "and DOWN reaches the bottom. If these agree, the picture is still stuck in one axis.",
  );
  const zoomLeft = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 0, y: 0.5, zoom: 2 } });
  const zoomRight = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 1, y: 0.5, zoom: 2 } });
  assert.ok(zoomLeft, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.ok(zoomRight, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.notEqual(
    Buffer.compare(zoomLeft.buffer, zoomRight.buffer),
    0,
    "and left and right still move too — all four directions at once, which is what was asked for",
  );
  const overZoomed = await polishPortrait(wide, { width: 320, defocus: 0, grain: 0, focus: { x: 0.5, y: 0.5, zoom: 99 } });
  assert.ok(overZoomed, "polishPortrait must succeed on a synthetic in-memory PNG");
  assert.equal(
    overZoomed.focus.zoom,
    4,
    "the zoom is capped, so a photograph cannot be blown up past what it can carry",
  );

  assert.ok(
    workspace.includes("coverFill(natural, focusValue.zoom)") && workspace.includes("fillOffset(fill.w"),
    "the drag box sizes the picture as a multiple of the frame and offsets it by a fraction of itself — the server's own arithmetic",
  );
  // 🔴 A PICTURE MUST NEVER BE STRETCHED OUT OF ITS OWN PROPORTIONS. The multiples above
  // carry them once the picture has loaded, but until it does its shape is not known, both
  // multiples are 1, and a bare width/height of 100% squashes it to the frame. The owner saw
  // exactly that on 2026-09-23 ("the size you made the photo is stretched upon its normal"), so
  // the cover fit stays on it: a no-op once loaded, and the only thing holding its shape before.
  assert.ok(
    /object-cover/.test(workspace.slice(workspace.indexOf("onPointerDown={startDrag}"))),
    "🔴 the framing picture keeps `object-cover`, or it is drawn stretched until it loads",
  );
  // 🔴 AND RESIZING IS A PRESS, NOT A DEFAULT. "I want this resize is option but the photo
  // is as it is, I press on an option to make it resize if needed" (the owner, same day).
  assert.ok(
    workspace.includes("setResizing(true)") && workspace.includes("Resize it"),
    "the size control is opened by hand — a card nobody resizes prints at the picture's own size",
  );
  assert.match(
    workspace,
    /const \[resizing, setResizing\] = useState\(false\)/,
    "and it starts CLOSED, so nothing is resized unless somebody asks for it",
  );
  assert.match(
    workspace,
    /CENTRE: Focus = \{ x: 0\.5, y: 0\.5, zoom: 1 \}/,
    "the size it opens at is 1 — exactly cover, the crop this card has always printed",
  );
  assert.ok(
    workspace.includes("FRAME_RATIO") && workspace.includes('"4 / 5"'),
    "the box itself stays pinned to the card's 4:5: the frame is fixed, only the picture moves",
  );

  // 🔴 A HANDED-IN PHOTOGRAPH IS FOR THIS CARD AND NOTHING ELSE. Most people never put one
  // on Phoenix ("if someone is not putting the photo, from where I will get his photo" — the owner,
  // 2026-09-23), so a card has to be printable from a picture brought in from outside. It must never
  // become a back door that writes the employee record, which is HR's act on HR's own screen.
  const service = readFileSync(join(root, "src", "lib", "milestones", "service.ts"), "utf8");
  assert.ok(
    /photoUpload\?: Buffer \| null/.test(service),
    "the card service takes a handed-in photograph",
  );
  // Photo resolution now lives in ONE place (loadMilestonePhotoBytes), so the card, the framing
  // focus and every caller agree on which picture is used. Order: a handed-in upload wins, then the
  // uploaded record photo, then — the 2026-09-30 fix — the bundled static photo the portal already
  // shows (an account whose portal photo was a static file used to export a card with NO picture).
  assert.ok(
    service.includes("loadMilestonePhotoBytes") &&
      service.includes("if (upload) return upload;") &&
      service.includes("readStaticProfilePhoto"),
    "an upload wins, then the uploaded record photo, then the bundled static photo — one resolver, so portal and card finally agree",
  );
  assert.match(
    /import \{([^}]*)\} from "@\/lib\/employees\/employee-photo";/.exec(service)?.[1] ?? "",
    /^\s*streamEmployeePhoto,?\s*$/,
    "and the ONLY thing it may do to the photo store is READ it — a card is printed, never filed",
  );
  assert.ok(
    cardRoute.includes("MAX_UPLOAD_BYTES") && /data:image\//.test(cardRoute),
    "the route takes it as a capped image data URI — sharp judges the bytes, the cap judges the weight",
  );
  assert.ok(
    workspace.includes("setUpload(null)") && workspace.includes("resetFields"),
    "🔴 and picking a different NAME drops it — one person's face on another person's printed card cannot be taken back",
  );

  // 🔴 THE FRAMING BOX PREVIEWS WHATEVER THE CARD WILL CUT — including the bundled static photo.
  // The card resolves uploaded → uploaded record → bundled static, so the box must fall back the
  // same way; gating it on `hasPhoto` alone went dark for a static-photo employee whose card still
  // prints their face, and the preview then lied about the picture.
  assert.ok(
    workspace.includes("employeeProfileImageForHrId(selectedHrId)"),
    "the framing box falls back to the bundled static photo, matching what the card prints",
  );
}
