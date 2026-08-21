import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Every portal `<table>` a phone can reach must be desktop-only, with cards beside it.
//
// The owner's standing rule: "desktop shows full tables/dashboards, mobile never does —
// mobile gets cards." The portal already honours it almost everywhere through
// `PortalDesktopTable`, which is hidden under 768px by the `[data-portal-desktop-table]`
// rule in enterprise-shell.tsx. An audit of all 110 portal pages on 2026-08-16 — run
// straight after the 16px input floor fixed the systemic zoom defect
// (employee-portal-mobile-input-zoom.test.ts) — found three raw tables that had escaped it.
//
// What a raw table costs on a phone is not "it looks cramped". Each of these lost a
// specific column off the right edge, and in every case it was the column that carried
// the identity of the row:
//
//   • targets-workspace       the customer NAME in the drill-down, inside a nested <table>
//                             a phone has nothing to scroll sideways
//   • bulk-cv-extraction      the CV file name AND the Review button, CLIPPED not scrolled
//                             (the wrapper was overflow-hidden), so a queued CV read as
//                             "this one cannot be reviewed"
//   • intake-health-view      four columns of counts whose headers scroll off the top,
//                             leaving unlabelled numbers
//
// This test pins the fix by SHAPE, not by class-string: for each file, every <table> must
// be desktop-gated, and a md:hidden sibling must exist. A future edit that deletes the
// cards, or adds a fourth ungated table, fails here.
// ─────────────────────────────────────────────────────────────────────────────

/** Tailwind's `md:` breakpoint. Below it the portal shows cards; at and above it, tables. */
const MOBILE_MAX_WIDTH_PX = 767;

/**
 * A `<table>` is safe on a phone when it is hidden below `md`. Three spellings are in use
 * and all three are correct:
 *   - `data-portal-desktop-table` — the shared attribute enterprise-shell.tsx display:none's
 *   - `hidden … md:block` on the wrapper div
 *   - `hidden … md:table` on the table itself
 */
const DESKTOP_GATES = [/data-portal-desktop-table/, /\bmd:block\b/, /\bmd:table\b/];

const CONVERTED = [
  "../src/components/sales/targets-workspace.tsx",
  "../src/components/recruitment/bulk-cv-extraction-panel.tsx",
  "../src/components/recruitment/intake-health-view.tsx",
];

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * Opening `<table` tags only — never the word inside a comment or a string. Matched on the
 * tag character that follows the name, so `<table>` and `<table className=…>` both count
 * while the prose "was a nested `<table>` until 2026-08-16" in a doc comment does not…
 * except that it would, so comments are stripped first. That stripping is the reason this
 * test disagrees with a naive grep, and it is deliberate: an explanatory comment about a
 * table that no longer exists must not be able to fail a build.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function tableOffsets(source: string): number[] {
  const offsets: number[] = [];
  const pattern = /<table[\s>]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    offsets.push(match.index);
    match = pattern.exec(source);
  }
  return offsets;
}

export function runEmployeePortalMobileTableCardTests() {
  for (const path of CONVERTED) {
    const source = stripComments(read(path));
    const offsets = tableOffsets(source);

    assert.ok(
      offsets.length > 0,
      `${path} was converted to keep its desktop table and add cards beside it. No <table> at ` +
        "all means the desktop view was dropped, which is the opposite of the owner's rule.",
    );

    // ── HEADLINE: not one ungated table survives ─────────────────────────────
    // The gate is looked for in the 240 characters before the tag — far enough to cover a
    // wrapper div on its own line, short enough that it cannot borrow a gate from an
    // unrelated block further up the file.
    for (const offset of offsets) {
      const window = source.slice(Math.max(0, offset - 240), offset + 200);
      const gated = DESKTOP_GATES.some((gate) => gate.test(window));
      const line = source.slice(0, offset).split("\n").length;
      assert.ok(
        gated,
        `${path}:${line} renders a <table> that is still visible at ${MOBILE_MAX_WIDTH_PX}px. ` +
          "A portal table must be desktop-only — carry `data-portal-desktop-table`, or sit " +
          "inside a `hidden … md:block` wrapper, or be `hidden … md:table` itself. On a phone " +
          "an ungated table pushes its widest column (a customer name, a CV file name) off the " +
          "right edge, and the owner's rule is cards there, not a sideways scroll.",
      );
    }

    // ── The cards actually exist ─────────────────────────────────────────────
    // A table hidden below md with nothing in its place is a blank screen, which is worse
    // than the cramped table it replaced.
    assert.match(
      source,
      /\bmd:hidden\b/,
      `${path} hides its table below md but renders no md:hidden card block, so a phone gets ` +
        "an empty panel where the data used to be.",
    );
  }

  // ── targets-workspace: one drill-down implementation, two surfaces ─────────
  // The desktop row's <td colSpan> and the phone card render the SAME component. Two copies
  // of the brick → distributor → customer maths could disagree about a target, which is the
  // one thing a targets screen may never do.
  const targets = stripComments(read(CONVERTED[0]));
  assert.match(
    targets,
    /function SourceBreakdown\(/,
    "targets-workspace must keep the drill-down in a single <SourceBreakdown /> component.",
  );
  assert.equal(
    (targets.match(/<SourceBreakdown\b/g) ?? []).length,
    2,
    "targets-workspace must render <SourceBreakdown /> exactly twice — once in the desktop " +
      "row's expanded <td>, once in the phone card. Inlining either one back would let the two " +
      "surfaces report different sales for the same area and product.",
  );

  // The per-row numbers are derived once for both surfaces, for the same reason.
  assert.match(
    targets,
    /const viewRow = \(row: TargetGridRow\)/,
    "targets-workspace must derive each row's target, achievement and drill state in one " +
      "`viewRow` helper read by both the desktop grid and the phone cards.",
  );

  // ── PortalDesktopTable is the <table>; nesting one inside it is a hydration bug ──
  // early-birds-rep-table nested a second <table> inside it until 2026-08-16. The HTML
  // parser foster-parents a nested table out of its parent while React's client render
  // keeps it nested, so server and client markup disagree.
  for (const path of [
    "../src/components/early-birds/early-birds-rep-table.tsx",
    ...CONVERTED,
  ]) {
    const source = stripComments(read(path));
    assert.doesNotMatch(
      source,
      /<PortalDesktopTable[^>]*>\s*<table/,
      `${path} nests a <table> inside <PortalDesktopTable>, which already IS the table. That ` +
        "emits <table><table> on the server, the parser lifts the inner one out, and the page " +
        "hydrates with a mismatch. Pass <thead>/<tbody> as its children instead.",
    );
  }

  // ── A card title must WRAP on a phone, never push the page sideways ─────
  // PortalRecordCard is the mobile half of every converted table — 30 files as of
  // 2026-08-21 — and its <h3> carried a bare `whitespace-nowrap`. With no clipping and no
  // ellipsis (both correct: the owner forbids truncating text) a long title simply
  // overflowed the card. Measured in a real 375px viewport with the longest real rep name,
  // 52 chars: the title needed 436px inside a 267px slot, and the PAGE's scrollWidth went
  // to 455px — the phone scrolled sideways. That is precisely the defect the card layout
  // exists to remove, so it must not come back. 37 of 108 CRM reps are long enough to hit it.
  //
  // The rule survives where it can: `md:whitespace-nowrap` keeps the title on one line from
  // 768px up, and no desktop table is touched.
  {
    const primitives = stripComments(read("../src/components/employee-portal/portal-primitives.tsx"));
    const title = /<h3 className="([^"]*)">\{title\}<\/h3>/.exec(primitives);
    assert.ok(title, "PortalRecordCard's <h3>{title}</h3> was not found in portal-primitives.tsx.");
    const classes = title[1].split(/\s+/);
    assert.ok(
      !classes.includes("whitespace-nowrap"),
      "PortalRecordCard's title carries an unconditional `whitespace-nowrap`. On a 375px phone a " +
        "long name then overflows the card and the whole page scrolls sideways, which is the " +
        "defect the cards replace. Use `md:whitespace-nowrap` so it wraps below md and stays on " +
        "one line above it.",
    );
    assert.ok(
      classes.includes("md:whitespace-nowrap"),
      "PortalRecordCard's title must keep `md:whitespace-nowrap`, so a card rendered at desktop " +
        "width still puts its title on a single line.",
    );
  }
}
