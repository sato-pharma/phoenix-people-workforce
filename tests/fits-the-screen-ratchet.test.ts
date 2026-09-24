import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule (AGENTS.md §4, THE FITS-THE-SCREEN GOLDEN RULE): "never a
// horizontal scroll, always mobile AND desktop friendly". The rule names its own
// anti-pattern in as many words:
//
//     "fit by MERGING columns, never shrinking type — `overflow-x-auto` over a
//      `min-width` IS the bug"
//
// This test counts that construct. `overflow-x-auto` (and its `-scroll` twin) is
// the class that GRANTS a page permission to scroll sideways; wherever one sits,
// the content underneath it was too wide and was allowed to overflow instead of
// being made to fit.
//
// WHY A RATCHET AND NOT A SWEEP
// Deleting the class does not fix the screen — it replaces a sideways scroll with
// a silent clip, which is worse for the reader. The real fix is per-screen layout
// work: `table-fixed` with a `<colgroup>`, merged columns, cards on a phone. There
// were 209 sites when this was counted honestly, across 128 files, and each one
// needs its own pass. So the count may FALL and may never RISE:
//
//   - new UI is held to the rule from the day it is written, and
//   - the existing 209 can be retired deliberately, screen by screen.
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
// `overflow-x-hidden` (which clips rather than scrolls), `overflow-y-*` (vertical
// scrolling is normal and not what the rule is about), and any mention in a comment
// — comments are stripped before anything is measured, and the detector self-checks
// below enforce that rather than merely promising it. The no-ellipsis ratchet lost a
// full CI round to a comment describing the very rule it was obeying (#2571); the
// same mistake is not repeated here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-09-24 on origin/main, with comments stripped, over app/ and
 * src/components/. Lower this when screens are genuinely made to fit; never raise
 * it to make a red run go green.
 *
 * 209 sites across 128 files at first count. The concentration is where the wide
 * tables live: src/components/sales (41), src/components/admin (40),
 * src/components/employee-portal (25), src/components/direct-orders (15).
 *
 * For whoever lowers this next: the fix that holds is the one AGENTS.md names —
 * `<table className="w-full table-fixed">` with a `<colgroup>`, fitting by MERGING
 * columns. Dropping `overflow-x-auto` on its own just moves the defect from a
 * scrollbar to a clip, and `shrink-0` on an inner element makes a `flex-wrap`
 * inert, so check the row actually wraps after the change rather than assuming it.
 */
const BASELINE = 209;

/**
 * app/ and src/components/ are where UI class strings live. src/lib/ is excluded on
 * purpose: the document and export generators there (offer letters, the spotlight
 * sheet, the premium closing workbook, the hiring-pack papers) are owner-approved
 * exemptions with their own frozen looks, and they emit print/PDF/XLSX output that
 * has no viewport to overflow in the first place.
 */
const ROOTS = ["app", "src/components"];

/** The class that grants permission to scroll sideways, inside a quoted class string. */
const CLASS_STRING_WITH_X_SCROLL =
  /["'`][^"'`\n]*\boverflow-x-(?:auto|scroll)\b[^"'`\n]*["'`]/;
const ANY_X_SCROLL_TOKEN = /\boverflow-x-(?:auto|scroll)\b/;

/**
 * Remove comments before counting, so the class only counts where it is APPLIED.
 * Newlines are preserved so the `file:line` reported for a real site still points at
 * its real line. The `[^:]` guard keeps a `https://…` URL from reading as the start
 * of a line comment and swallowing the rest of the line with it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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
      .filter((line) => CLASS_STRING_WITH_X_SCROLL.test(line)).length;

  assert.equal(countIn('<div className="overflow-x-auto">{rows}</div>'), 1, "a plain class string is a real site and must count");
  assert.equal(countIn("<div className={`flex overflow-x-auto ${x}`}>{r}</div>"), 1, "a template-literal class string must still count — a good half of these are written that way");
  assert.equal(countIn('<div className="md:overflow-x-auto">{r}</div>'), 1, "a responsive prefix still grants sideways scroll at that breakpoint and must count");
  assert.equal(countIn('<div className="overflow-x-scroll">{r}</div>'), 1, "overflow-x-scroll is the same permission as overflow-x-auto");
  assert.equal(countIn('<div className="overflow-x-hidden">{r}</div>'), 0, "overflow-x-hidden clips rather than scrolls — it is not the anti-pattern this rule names");
  assert.equal(countIn('<div className="overflow-y-auto">{r}</div>'), 0, "vertical scrolling is normal and is not what the fits-the-screen rule is about");
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
    CLASS_STRING_WITH_X_SCROLL.test(preserved[3]),
    "the surviving site must still sit on its original line after the comment above it is stripped",
  );

  const sites: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (!ANY_X_SCROLL_TOKEN.test(source)) continue;
    source.split("\n").forEach((line, i) => {
      if (CLASS_STRING_WITH_X_SCROLL.test(line)) sites.push(`${file.replace(/\\/g, "/")}:${i + 1}`);
    });
  }

  const count = sites.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new sideways-scroll site(s) were added — the count went ${BASELINE} -> ${count}.\n` +
      `THE FITS-THE-SCREEN GOLDEN RULE: never a horizontal scroll, mobile AND desktop friendly. ` +
      `"overflow-x-auto over a min-width IS the bug" (AGENTS.md §4).\n` +
      `Fit by MERGING columns, never by shrinking type: <table className="w-full table-fixed"> ` +
      `with a <colgroup>, and cards instead of a table on a phone. Then measure ` +
      `scrollWidth > clientWidth over main at desktop AND at 375px — note that shrink-0 on an ` +
      `inner element makes a flex-wrap inert.\n` +
      `Sites now present:\n  ${sites.slice(-12).join("\n  ")}`,
  );

  assert.ok(
    count >= BASELINE,
    `Good news: sideways-scroll sites dropped ${BASELINE} -> ${count}. Lower BASELINE in this file to ` +
      `${count} so the ground that was won cannot be given back.`,
  );
}
