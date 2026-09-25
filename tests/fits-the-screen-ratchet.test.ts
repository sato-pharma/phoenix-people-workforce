import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule (AGENTS.md §4, THE FITS-THE-SCREEN GOLDEN RULE): "never a
// horizontal scroll, always mobile AND desktop friendly". The rule names its own
// anti-pattern in as many words:
//
//     "fit by MERGING columns, never shrinking type — `overflow-x-auto` over a
//      `min-width` IS the bug"
//
// This test counts that construct: every class that GRANTS a page permission to
// scroll SIDEWAYS. Four spellings do that —
//
//     overflow-x-auto   overflow-x-scroll   overflow-auto   overflow-scroll
//
// The last two are the shorthand, and they set BOTH axes, so they permit exactly
// the same sideways scroll as the explicit pair. Wherever one sits, the content
// underneath it was too wide and was allowed to overflow instead of being made
// to fit.
//
// WHY A RATCHET AND NOT A SWEEP
// Deleting the class does not fix the screen — it replaces a sideways scroll with
// a silent clip, which is worse for the reader. The real fix is per-screen layout
// work: `table-fixed` with a `<colgroup>`, merged columns, cards on a phone. There
// were 256 sites at the first count that looked at all four spellings, across 146
// files, and each one needs its own pass. So the count may FALL and may never RISE:
//
//   - new UI is held to the rule from the day it is written, and
//   - the existing 256 can be retired deliberately, screen by screen.
//
// The one exception to "may never rise" is WIDENING THE DETECTOR, which has happened
// once (174 -> 256) and is recorded below. That is not the count getting worse; it is
// the count stopping being wrong. Anything else that raises it is a regression.
//
// WHAT THIS CANNOT DO
// It cannot prove a screen fits. Only a browser can, by measuring
// `scrollWidth > clientWidth` over `main` at desktop and at 375px, which is what
// AGENTS.md asks for and what tests like weekly-sales-fits-the-screen.test.ts and
// multi-select-filter-fits.test.ts do for their own screens. This test catches the
// cheaper half — the construct that lets the overflow happen at all — across every
// screen at once, including the ones nobody has measured yet. The two are
// complements: a screen can pass this and still not fit.
//
// WHAT IS NOT COUNTED
// `overflow-hidden` / `overflow-x-hidden` / `overflow-clip` (which clip rather than
// scroll), `overflow-y-*` (vertical scrolling is normal and not what the rule is
// about), and any mention in a comment — comments are stripped before anything is
// measured, and the detector self-checks below enforce that rather than merely
// promising it. The no-ellipsis ratchet lost a full CI round to a comment describing
// the very rule it was obeying (#2571); the same mistake is not repeated here.
//
// A NOTE ON THE SHORTHAND, because most of what it catches is not a wide table
// The common shape is `max-h-[320px] overflow-auto` — a list meant to scroll
// VERTICALLY, written with the shorthand out of habit. Its author did not intend a
// sideways scroll, but the class grants one anyway, and the browser will use it the
// moment a single cell, chip or unbroken word is wider than the box. Those are the
// cheapest sites in this whole count to retire: `overflow-auto` -> `overflow-y-auto`
// is one token, changes nothing the author wanted, and removes the permission. Fix
// those first; the genuinely wide tables underneath the explicit `overflow-x-auto`
// are the ones that need `table-fixed` and a `<colgroup>`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-09-24 on origin/main, with comments stripped, over app/ and
 * src/components/. Lower this when screens are genuinely made to fit; never raise
 * it to make a red run go green.
 *
 * 209 sites across 128 files at first count — though that count, and every one down
 * to 174, saw only the `-x-` spellings; see the 174 -> 256 entry at the bottom. The
 * concentration is where the wide tables live: src/components/sales (41),
 * src/components/admin (40), src/components/employee-portal (25),
 * src/components/direct-orders (15).
 *
 * For whoever lowers this next: the fix that holds is the one AGENTS.md names —
 * `<table className="w-full table-fixed">` with a `<colgroup>`, fitting by MERGING
 * columns. Dropping `overflow-x-auto` on its own just moves the defect from a
 * scrollbar to a clip, and `shrink-0` on an inner element makes a `flex-wrap`
 * inert, so check the row actually wraps after the change rather than assuming it.
 *
 * 209 -> 175 on 2026-09-24: src/components/sales, 41 sites -> 7. Every wide sales table now uses
 * `table-fixed` with a percentage `<colgroup>`, which makes the overflow impossible BY
 * CONSTRUCTION — the columns divide the container's width, so no customer name, address or figure
 * can push the table sideways, and removing the wrapper cannot turn into a clip. Where the column
 * count was the problem it was fixed by MERGING, never by shrinking type: an id rides under the
 * name it belongs to (Brick ID under Brick, Area/Region into Territory, product code + normalized
 * name under Product), and the widest grids fold their detail columns below `md`/`lg` and bring
 * them back as sub-lines, so a phone loses nothing. Four `line-clamp-2` cuts went with it (the
 * no-ellipsis ratchet is 180 -> 175 in the same change).
 *
 * 175 -> 174 on 2026-09-24, from measuring the real pages in a browser rather than trusting the
 * count. Three of the fixes above were still WRONG on a phone and the ratchet could not see it: a
 * `table-fixed` table whose cell holds something that cannot shrink — a `whitespace-nowrap` button,
 * or a sort header whose flex item keeps its default `min-width: auto` — pushes the table past its
 * container, and an `overflow-hidden` wrapper CLIPS instead of scrolling, so `main` still measures
 * 375/375 and every check passes while the control is visibly cut. Customer Mapping and Closing
 * Corrections grew a mobile fold, the shared `SortButton` was taught to wrap, and the last site —
 * the import Dashboard's generic summary table — turned out to be no exemption at all (it was
 * mis-read as a distributor-driven sheet preview) and became desktop table + mobile cards.
 *
 * The 6 that remain in sales are deliberate and documented in place: the closing matrix
 * (owner ruling — "the matrix can NEVER fit; leave the scroll"), the two performance-review matrix
 * tables (one column per product / per month, with a frozen first column), and the territory tree's
 * desktop half (which has a `md:hidden` mobile tree beside it).
 *
 * 174 -> 256 on 2026-09-24, and this one is a RE-BASELINE, not a regression. Nothing got worse —
 * the detector got honest. It had only ever matched `overflow-x-auto` and `overflow-x-scroll`, so
 * the SHORTHAND `overflow-auto` / `overflow-scroll`, which set both axes and grant exactly the same
 * sideways scroll, were invisible to it. 82 sites had been sitting outside the count the whole time.
 * The hole was found the hard way: /sales/mapping-database measured 283px of container against 561px
 * of content at 375px — a real sideways scroll on a live page — while this ratchet read 174 and the
 * sales sweep that had just finished reported 7 remaining sites (#4330, #4338). Sales was not 6. It
 * was 24.
 *
 * So the number below is the first honest count of all four spellings, and the ratchet goes back to
 * only ever falling. The concentration now: src/components/admin (53), employee-portal (28),
 * sales (24), direct-orders (15), attendance (14), recruitment (10). Of the 82 that were newly
 * visible, the large majority are `max-h-… overflow-auto` vertical lists — a one-token
 * `overflow-y-auto` retires each of those without touching a layout, which is where to start.
 *
 * DO NOT narrow the pattern back to the `-x-` pair to make this number smaller. That is the exact
 * move this entry exists to prevent, and a page that scrolls sideways does not care which spelling
 * let it.
 *
 * 256 -> 254 on 2026-09-25: the manager/HR Vacation Report's two desktop tables (Leave Entitlements,
 * 9 columns; Master Requests, 12 columns) each dropped their `hidden md:block overflow-x-auto`
 * wrapper for `hidden xl:block` with `<table className="w-full table-fixed">` and a percentage
 * `<colgroup>` — the entitlements table merged to 6 columns (dropping the raw HR ID column), the
 * requests table to 8. Below `xl` both already had a `block md:hidden` card fallback, now `block
 * xl:hidden`, so nothing lost coverage. Raw `employeeHrId`/`managerHrId` were dropped from both
 * tables' and cards' display per AGENTS.md §4 ("show human-readable names, never raw codes or IDs")
 * — CSV/XLSX export and the filter search value are untouched.
 *
 * 254 -> 251 on 2026-09-25: the Territory Drilldown desktop tree's manager branches
 * (territory-tree-desktop.tsx — RegionRoot, RegionsRoot, AreaLane) dropped their
 * `overflow-x-auto` wrappers, the same fix already applied to the Medical Rep's AreaRoot; lanes
 * now stack/wrap under the parent's own width instead of scrolling sideways.
 */
const BASELINE = 251;

/**
 * app/ and src/components/ are where UI class strings live. src/lib/ is excluded on
 * purpose: the document and export generators there (offer letters, the spotlight
 * sheet, the premium closing workbook, the hiring-pack papers) are owner-approved
 * exemptions with their own frozen looks, and they emit print/PDF/XLSX output that
 * has no viewport to overflow in the first place.
 */
const ROOTS = ["app", "src/components"];

/**
 * A class that grants permission to scroll sideways, inside a quoted class string.
 *
 * The optional `x-` is what makes the shorthand count: `overflow-auto` and
 * `overflow-scroll` set both axes, so they permit the same sideways scroll as
 * `overflow-x-auto`. The alternation deliberately cannot reach `overflow-y-auto`
 * (after `overflow-` it must see `auto`, `scroll`, or `x-` — `y-` matches nothing)
 * and cannot reach any `-hidden` or `-clip`, which clip rather than scroll.
 */
const CLASS_STRING_WITH_SIDEWAYS_SCROLL =
  /["'`][^"'`\n]*\boverflow-(?:x-)?(?:auto|scroll)\b[^"'`\n]*["'`]/;
const ANY_SIDEWAYS_SCROLL_TOKEN = /\boverflow-(?:x-)?(?:auto|scroll)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runFitsTheScreenRatchetTests() {
  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 800,
    `only ${files.length} .tsx files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it on ~1,200 files.
  // A ratchet whose regex is wrong does not fail loudly — it reports a number, and
  // a wrong number looks exactly as authoritative as a right one.
  // ───────────────────────────────────────────────────────────────────────────
  const countIn = (snippet: string) =>
    stripComments(snippet)
      .split("\n")
      .filter((line) => CLASS_STRING_WITH_SIDEWAYS_SCROLL.test(line)).length;

  assert.equal(countIn('<div className="overflow-x-auto">{rows}</div>'), 1, "a plain class string is a real site and must count");
  assert.equal(countIn("<div className={`flex overflow-x-auto ${x}`}>{r}</div>"), 1, "a template-literal class string must still count — a good half of these are written that way");
  assert.equal(countIn('<div className="md:overflow-x-auto">{r}</div>'), 1, "a responsive prefix still grants sideways scroll at that breakpoint and must count");
  assert.equal(countIn('<div className="overflow-x-scroll">{r}</div>'), 1, "overflow-x-scroll is the same permission as overflow-x-auto");

  // The shorthand. These four are why the count went 174 -> 256: the detector could not
  // see them, and /sales/mapping-database scrolled sideways underneath one of them while
  // this test read green.
  assert.equal(countIn('<div className="overflow-auto">{r}</div>'), 1, "the shorthand sets BOTH axes, so it grants exactly the same sideways scroll as overflow-x-auto");
  assert.equal(countIn('<div className="max-h-[320px] overflow-auto">{r}</div>'), 1, "a max-height beside it shows the author wanted VERTICAL scroll, but the class still permits horizontal — it counts, and overflow-y-auto retires it");
  assert.equal(countIn('<div className="overflow-scroll">{r}</div>'), 1, "overflow-scroll is the shorthand twin and counts the same");
  assert.equal(countIn("<div className={`p-2 md:overflow-auto ${x}`}>{r}</div>"), 1, "a responsive prefix on the shorthand still grants sideways scroll at that breakpoint");

  assert.equal(countIn('<div className="overflow-x-hidden">{r}</div>'), 0, "overflow-x-hidden clips rather than scrolls — it is not the anti-pattern this rule names");
  assert.equal(countIn('<div className="overflow-hidden">{r}</div>'), 0, "the hidden shorthand clips on both axes — nothing scrolls, so nothing to count");
  assert.equal(countIn('<div className="overflow-clip">{r}</div>'), 0, "overflow-clip clips and cannot scroll");
  assert.equal(countIn('<div className="overflow-y-auto">{r}</div>'), 0, "vertical scrolling is normal and is not what the fits-the-screen rule is about");
  assert.equal(countIn('<div className="overflow-y-scroll">{r}</div>'), 0, "the y- axis never counts, whichever of auto/scroll it uses");
  assert.equal(countIn('<div className="overflow-y-auto overflow-x-hidden">{r}</div>'), 0, "the correct shape — vertical scroll, horizontal clipped — must not be dragged in by the widened pattern");
  assert.equal(countIn('<div className="overflow-visible">{r}</div>'), 0, "overflow-visible grants no scroll container at all");
  assert.equal(countIn("// this wraps instead of using overflow-x-auto"), 0, "a line comment naming the class is prose, not a site");
  assert.equal(countIn("/**\n * no `overflow-x-auto` here on purpose\n */"), 0, "a JSDoc block naming the class is prose, not a site");
  assert.equal(countIn("{/* overflow-x-auto was removed when this became a card */}"), 0, "a JSX block comment naming the class is prose, not a site");
  assert.equal(
    countIn('const u = "https://x.example/a";\n<div className="overflow-x-auto">{r}</div>'),
    1,
    "a URL must not read as the start of a comment and swallow the line after it",
  );

  // Line numbers survive stripping, or every file:line reported below is shifted
  // upward by the size of whatever comment block sat above it.
  const preserved = stripComments('/*\n * `overflow-x-auto`\n */\n<div className="overflow-x-auto">x</div>').split("\n");
  assert.equal(preserved.length, 4, "stripping must preserve the line count, or every file:line this test prints is wrong");
  assert.ok(
    CLASS_STRING_WITH_SIDEWAYS_SCROLL.test(preserved[3]),
    "the surviving site must still sit on its original line after the comment above it is stripped",
  );

  // The cheap pre-filter and the line matcher must agree on what a site is, or a file
  // whose only site uses a spelling the token regex missed is skipped entirely and the
  // count silently under-reports — which is precisely how the shorthand hid for so long.
  for (const spelling of ["overflow-x-auto", "overflow-x-scroll", "overflow-auto", "overflow-scroll"]) {
    const line = `<div className="${spelling}">x</div>`;
    assert.ok(ANY_SIDEWAYS_SCROLL_TOKEN.test(line), `the pre-filter must admit a file containing ${spelling}, or that file is never scanned`);
    assert.ok(CLASS_STRING_WITH_SIDEWAYS_SCROLL.test(line), `the line matcher must count ${spelling}`);
  }
  for (const spelling of ["overflow-y-auto", "overflow-y-scroll", "overflow-hidden", "overflow-x-hidden", "overflow-clip"]) {
    const line = `<div className="${spelling}">x</div>`;
    assert.ok(!ANY_SIDEWAYS_SCROLL_TOKEN.test(line), `the pre-filter must reject ${spelling} — it grants no sideways scroll`);
    assert.ok(!CLASS_STRING_WITH_SIDEWAYS_SCROLL.test(line), `the line matcher must reject ${spelling}`);
  }

  const sites: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (!ANY_SIDEWAYS_SCROLL_TOKEN.test(source)) continue;
    source.split("\n").forEach((line, i) => {
      if (CLASS_STRING_WITH_SIDEWAYS_SCROLL.test(line)) sites.push(`${file.replace(/\\/g, "/")}:${i + 1}`);
    });
  }

  const count = sites.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new sideways-scroll site(s) were added — the count went ${BASELINE} -> ${count}.\n` +
      `THE FITS-THE-SCREEN GOLDEN RULE: never a horizontal scroll, mobile AND desktop friendly. ` +
      `"overflow-x-auto over a min-width IS the bug" (AGENTS.md §4).\n` +
      `Counted here: overflow-x-auto, overflow-x-scroll, AND the shorthand overflow-auto / ` +
      `overflow-scroll, which set both axes and grant the same sideways scroll.\n` +
      `If yours is a VERTICAL list written as "max-h-… overflow-auto", the fix is one token: ` +
      `overflow-y-auto. If it is a wide table, fit by MERGING columns, never by shrinking type: ` +
      `<table className="w-full table-fixed"> with a <colgroup>, and cards instead of a table on ` +
      `a phone. Then measure scrollWidth > clientWidth over main at desktop AND at 375px — note ` +
      `that shrink-0 on an inner element makes a flex-wrap inert.\n` +
      `Sites now present:\n  ${sites.slice(-12).join("\n  ")}`,
  );

  assert.ok(
    count >= BASELINE,
    `Good news: sideways-scroll sites dropped ${BASELINE} -> ${count}. Lower BASELINE in this file to ` +
      `${count} so the ground that was won cannot be given back.`,
  );
}
