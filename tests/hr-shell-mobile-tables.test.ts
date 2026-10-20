import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hrNavigationSections } from "@/config/system-navigation";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Every page an HR seat can open must work on a phone.
//
// The owner's standing rule (AGENTS.md §4): "desktop shows full tables/dashboards, mobile never
// does — mobile gets cards." He restated it for this build as a hard acceptance criterion: the
// two new HR accounts must have "hundred percent desktop compatibility and hundred percent
// mobile compatibility". The HR shell is a NEW namespace (/hr/*) assembled out of pages that
// already existed, so it inherited whatever each of those pages happened to do — and most of
// them had never been opened on a phone by anyone. An audit on 2026-08-28 found 14 tables across
// 9 files that forced a 375px screen to scroll sideways, the widest at a 1480px minimum.
//
// WHY A CLOSURE SCAN, NOT A DIRECTORY SCAN. crm-mobile-table-cards.test.ts can scan one directory
// because the CRM module IS a directory. The HR shell is not: it is ~30 sidebar rows resolving to
// pages that pull components from probation/, reports/, hr-calendar/, attendance/,
// deductions-governance/, field-workforce-compliance/, employee-portal/ and more. The only honest
// definition of "in scope" is reachability, so this test walks hrNavigationSections -> page file
// -> import closure. Add a row to the HR sidebar and its tables are covered on the next run,
// with nobody having to remember a list.
//
// THE RULE, and why each half of it is necessary. A table breaks a phone when it declares a
// MINIMUM width wider than the phone, OR when it has enough columns that it will exceed one
// regardless. Both halves were arrived at by getting it wrong in each direction on 2026-08-28:
//   - Flagging every ungated <table> caught a 3-column product list that shrinks to fit and is
//     perfectly readable at 375px. Converting it would have been churn.
//   - Gating on min-width alone cleared three 7-to-9-column tables that declare no minimum at
//     all. px-4 padding alone spends 32px per column, so nine columns are 288px of padding
//     before a single character of content — they overflow just as surely, they just do not say
//     so in a class name.
// ─────────────────────────────────────────────────────────────────────────────

/** Tailwind's `md:` breakpoint. Below it the HR shell shows cards; at and above it, tables. */
const MOBILE_MAX_WIDTH_PX = 767;

/**
 * The narrowest phone the shell is measured against, plus a little slack. A table that declares
 * a minimum at or under this shrinks into the viewport; one above it cannot.
 */
const PHONE_WIDTH_PX = 380;

/** At and above this, padding alone guarantees an overflow whether a minimum is declared or not. */
const CROWDED_COLUMN_COUNT = 5;

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * A `<table>` is safe on a phone when it is hidden below `md`, or when it stops being a table
 * below `md`. Four spellings are in use and all four are correct:
 *   - `data-portal-desktop-table` — the attribute enterprise-shell.tsx display:none's
 *   - `hidden … md:block` on a wrapper div
 *   - `hidden … md:table` on the table itself
 *   - `portalStackingTableClassName`, whose value is `block … md:table` (pinned below)
 */
const DESKTOP_GATES = [
  /data-portal-desktop-table/,
  /\bmd:block\b/,
  /\bmd:table\b/,
  /\bportalStackingTableClassName\b/,
];

/**
 * How a file may render its mobile half. PortalResponsiveDataList emits the `md:hidden` card list
 * itself; PortalStackingCell keeps one instance and stacks its cells with a visible label.
 */
const MOBILE_CARD_PATHS = [
  /\bPortalResponsiveDataList\b/,
  /\bPortalStackingCell\b/,
  /\bmd:hidden\b/,
];

/**
 * Tables that stay tables on a phone, on purpose. Each entry has to say why, because the default
 * answer is "convert it" and an exemption list is how a rule quietly stops applying.
 */
const EXEMPT: Record<string, string> = {
  "app/(admin)/admin/private-calendars/page.tsx":
    "Reachable from the HR sidebar since 2026-10-08 (Private Calendars on the Talent Acquisition " +
    "seat). Five <th> tags, but a phone never sees five columns: Title, Line and Area / Department " +
    "are `hidden sm:table-cell` with `w-0` cols, and their values are MERGED into the Employee " +
    "cell below sm — the fits-the-screen rule's own prescribed fix (merge columns, never shrink " +
    "type) — so 375px shows two columns, Employee and View Calendar, inside a table-fixed colgroup. " +
    "Cards would rebuild a list the owner had re-cut the same day to hold the whole company.",
};

function read(file: string): string {
  return readFileSync(ROOT + file, "utf8");
}

/** Resolve an /hr/* href to the page file the rewrite in proxy.ts actually serves. */
function pageFileFor(href: string): string | null {
  const rest = href.replace(/^\/hr/, "");
  for (const candidate of [
    `app/(admin)${rest}/page.tsx`,
    `app${rest}/page.tsx`,
    `app/(portal)${rest}/page.tsx`,
  ]) {
    if (existsSync(ROOT + candidate)) return candidate;
  }
  return null;
}

function localImports(file: string): string[] {
  const source = read(file);
  const found = new Set<string>();
  for (const match of source.matchAll(/from\s+"(@\/[^"]+)"/g)) {
    const base = match[1].replace(/^@\//, "src/");
    for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
      if (existsSync(ROOT + base + ext)) {
        found.add(base + ext);
        break;
      }
    }
  }
  return [...found];
}

/**
 * Three hops from the page. Measured on 2026-08-28: depth 3 reaches every component that renders
 * a table on an HR page, and depth 4 adds only leaf utilities. Deeper is not free — the closure
 * of 30 pages is already several hundred files.
 */
function importClosure(entry: string, depth = 3): string[] {
  const seen = new Set([entry]);
  let frontier = [entry];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const imported of localImports(file)) {
        if (seen.has(imported)) continue;
        seen.add(imported);
        next.push(imported);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return [...seen];
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

/**
 * A window around `offset` measured in CODE characters — anything that is not whitespace.
 *
 * All three windows below used to be byte counts, and a byte count silently depends on how the
 * comment stripper REPRESENTS a comment. The local stripper this file used to carry DELETED comment
 * text, so a 640-byte lookback was 640 bytes of code; `stripComments` blanks a comment to spaces in
 * place instead, to keep every reported `file:line` pointing at its real line. Measured on
 * 2026-09-25, the 640 characters before the table in `hr-calendar.tsx` and
 * `probation-dashboard-view.tsx` were then **639 whitespace** — a comment block sits directly above
 * both — so the window held no code at all, found no `hidden md:block`, and the sweep reported two
 * correctly gated tables as unfitted on a phone. Counting code restores the budgets' original
 * meaning and cannot be diluted again.
 */
function codeWindow(source: string, offset: number, back: number, forward: number): string {
  let start = offset;
  for (let seen = 0; start > 0 && seen < back; ) {
    start -= 1;
    if (!/\s/.test(source[start])) seen += 1;
  }
  let end = offset;
  for (let seen = 0; end < source.length && seen < forward; end += 1) {
    if (!/\s/.test(source[end])) seen += 1;
  }
  return source.slice(start, end);
}

/** The widest `min-w-[Npx]` on the table tag or in the 400 characters of wrapper before it. */
function declaredMinWidth(source: string, offset: number): number {
  const window = codeWindow(source, offset, 400, 260);
  let widest = 0;
  for (const match of window.matchAll(/min-w-\[(\d+)px\]/g)) {
    widest = Math.max(widest, Number(match[1]));
  }
  return widest;
}

/**
 * Columns declared in this table's <thead>. Two shapes are used in this repo, and BOTH have to be
 * counted and then compared — not tried in order:
 *   A. literal <th> tags, one per column
 *   B. a string array mapped to <th>, which has exactly ONE literal <th> (inside the callback)
 *
 * Trying A first and returning early is the obvious way to write this and it is wrong: shape B
 * scores 1, so hr-calendar's eight-column table reported "1 columns" and only escaped notice
 * because it also declares min-w-[980px]. A shape-B table with no declared minimum would have
 * been cleared outright. Measured against the real files on 2026-08-28 — that is not a
 * hypothetical, it is what the first version of this counter did.
 *
 * The array scan takes the widest bracket group rather than the first, because the slice starts
 * at the <table> tag and so includes its own className — `min-w-[980px]` is a bracket group with
 * zero quoted strings, and reading only the first one scores every such table 0.
 */
function columnCount(source: string, offset: number): number {
  const head = codeWindow(source, offset, 0, 4000);
  const end = head.indexOf("</thead>");
  const block = end === -1 ? head.slice(0, 1500) : head.slice(0, end);

  const literal = [...block.matchAll(/<th[\s>]/g)].length;

  let mapped = 0;
  for (const group of block.matchAll(/\[[^\]]*\]/g)) {
    mapped = Math.max(mapped, Math.floor([...group[0].matchAll(/"/g)].length / 2));
  }

  return Math.max(literal, mapped);
}

/** Does this table need a mobile half at all? */
function isWide(source: string, offset: number): boolean {
  return (
    declaredMinWidth(source, offset) > PHONE_WIDTH_PX ||
    columnCount(source, offset) >= CROWDED_COLUMN_COUNT
  );
}

function isDesktopGated(source: string, offset: number): boolean {
  const window = codeWindow(source, offset, 640, 200);
  return DESKTOP_GATES.some((gate) => gate.test(window));
}

export function runHrShellMobileTableTests() {
  // ── The primitives this test's gates are spelled in terms of ──────────────
  // DESKTOP_GATES accepts the NAME `portalStackingTableClassName` rather than its value, because
  // the value lives in another file. If that constant ever stopped containing `md:table`, every
  // stacking table would be gated in this test's eyes and ungated in the browser — the test would
  // go green on a broken shell. Pin the value here so that cannot happen quietly.
  const primitives = read("src/components/employee-portal/portal-primitives.tsx");
  assert.match(
    primitives,
    /portalStackingTableClassName\s*=\s*"[^"]*\bmd:table\b[^"]*"/,
    "portalStackingTableClassName must still resolve to a `md:table` class. This test treats the " +
      "constant's NAME as proof a table is desktop-gated; if its value stops carrying md:table, " +
      "every stacking table below would pass here and stack wrongly in the browser.",
  );
  assert.match(
    primitives,
    /portalStackingTableClassName\s*=\s*"\s*block\b/,
    "portalStackingTableClassName must still start `block`, which is what makes the table stop " +
      "being a table below md. Without it the cells keep table layout and the stack collapses " +
      "back into the wide row the pattern exists to avoid.",
  );
  assert.match(
    primitives,
    /function PortalResponsiveDataList[\s\S]{0,900}?\bmd:hidden\b/,
    "PortalResponsiveDataList must still emit its card list gated to below md. MOBILE_CARD_PATHS " +
      "accepts the component's name as proof a file has a mobile half — that is only true while " +
      "the component itself renders one.",
  );

  // ── Resolve the HR shell to a set of files ────────────────────────────────
  const hrefs = hrNavigationSections
    .flatMap((section) => section.items.map((item) => item.href))
    .filter((href) => href.startsWith("/hr/"));

  // A scan that silently found nothing would pass every assertion below and prove nothing — the
  // exact failure mode the whole test exists to prevent.
  assert.ok(
    hrefs.length >= 25,
    `Expected the HR sidebar to hold at least 25 /hr/* rows, found ${hrefs.length}. Either the ` +
      "catalogue moved or this scan is broken, and a scan that finds nothing passes vacuously.",
  );

  const pages = hrefs.map(pageFileFor).filter((page): page is string => page !== null);
  assert.ok(
    pages.length >= 20,
    `Only ${pages.length} of ${hrefs.length} HR sidebar rows resolved to a page file. A row that ` +
      "resolves to nothing is a 404 for the seat, and it is also invisible to every check below — " +
      "so this is either a broken link or a broken resolver, and both matter.",
  );

  const files = new Set<string>();
  for (const page of pages) {
    for (const file of importClosure(page)) {
      if (file.startsWith("src/components/") || file.startsWith("app/")) files.add(file);
    }
  }
  assert.ok(
    files.size >= 100,
    `The HR import closure covered only ${files.size} files. It reached 142 when this was measured on 2026-08-28; ` +
      "a collapse that large means the resolver stopped following imports.",
  );

  const sorted = [...files].sort();

  // ── HEADLINE: no HR page hands a phone a table it cannot fit ──────────────
  let wideTablesSeen = 0;
  const offenders: string[] = [];

  for (const file of sorted) {
    const source = stripComments(read(file));

    for (const offset of tableOffsets(source)) {
      // Narrow tables shrink into the viewport and are left alone deliberately — converting a
      // 3-column list to cards is churn, not a fix.
      if (!isWide(source, offset)) continue;
      wideTablesSeen += 1;

      if (EXEMPT[file]) continue;
      if (isDesktopGated(source, offset)) continue;

      const minWidth = declaredMinWidth(source, offset);
      const line = source.slice(0, offset).split("\n").length;
      offenders.push(
        `${file}:${line} (${minWidth > 0 ? `min-w ${minWidth}px` : "no declared minimum"}, ` +
          `${columnCount(source, offset)} columns)`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These tables are reachable from the HR sidebar and are still full-width tables at " +
      `${MOBILE_MAX_WIDTH_PX}px:\n  ` +
      offenders.join("\n  ") +
      "\n\nPick one of the two patterns. For a READ-ONLY table, wrap the rows in " +
      "<PortalResponsiveDataList> — cards below md, table from md up. For a table whose ROW " +
      "holds an unsaved edit, use the stacking pattern (portalStackingTableClassName + " +
      "<PortalStackingCell>) instead: PortalResponsiveDataList renders every row twice, so a " +
      "row-local useState exists in two copies, and a phone rotated to landscape crosses the md " +
      "breakpoint and swaps in the other one — the pending edit is gone with no warning. Draft " +
      "state held in the ENCLOSING component keyed by row id is safe either way, because both " +
      "copies read and write the same value.",
  );

  // The count is not decoration. If it collapses, the width/column detection broke and the
  // assertion above went green by measuring nothing.
  assert.ok(
    wideTablesSeen >= 20,
    `Only ${wideTablesSeen} wide tables were detected across the whole HR closure. There were 29 ` +
      "when this was measured on 2026-08-28, so a number this low means declaredMinWidth or columnCount stopped " +
      "matching — and the headline assertion above then passes without checking anything.",
  );

  // ── A gated table must leave something behind ─────────────────────────────
  // A table hidden below md with nothing in its place is a blank screen — strictly worse than
  // the sideways scroll it replaced. This is the half of the rule that is easy to forget,
  // because the diff looks finished once the `hidden md:block` is on.
  for (const file of sorted) {
    if (EXEMPT[file]) continue;
    const source = stripComments(read(file));
    const hasGatedWideTable = tableOffsets(source).some(
      (offset) => isWide(source, offset) && isDesktopGated(source, offset),
    );
    if (!hasGatedWideTable) continue;

    assert.ok(
      MOBILE_CARD_PATHS.some((path) => path.test(source)),
      `${file} hides a wide table below md but renders no mobile half, so an HR seat opening it ` +
        "on a phone gets an empty panel where the data used to be. Render the rows through " +
        "<PortalResponsiveDataList>, or stack them with <PortalStackingCell>.",
    );
  }

  // ── Never nest a <table> inside PortalDesktopTable ────────────────────────
  // It already IS the table. Nesting emits <table><table>, the HTML parser foster-parents the
  // inner one out while React keeps it nested, and the page hydrates with a mismatch.
  for (const file of sorted) {
    assert.doesNotMatch(
      stripComments(read(file)),
      /<PortalDesktopTable[^>]*>\s*<table/,
      `${file} nests a <table> inside <PortalDesktopTable>, which already IS the table. Pass ` +
        "<thead>/<tbody> as its children instead.",
    );
  }

  // ── The exemption list must stay honest ──────────────────────────────────
  // An exemption for a file that no longer exists, or that is no longer reachable, is a standing
  // licence nobody reviews. Delete it the moment it stops describing something real.
  for (const [file, reason] of Object.entries(EXEMPT)) {
    assert.ok(
      existsSync(ROOT + file),
      `${file} is exempted from the HR mobile-table rule but does not exist. Remove the entry — ` +
        "a stale exemption is a hole that nobody is looking at.",
    );
    assert.ok(
      reason.length >= 80,
      `The exemption for ${file} must say why, at length. "It is fine" is how a rule stops ` +
        "applying one file at a time.",
    );
    assert.ok(
      files.has(file),
      `${file} is exempted from the HR mobile-table rule but is no longer reachable from the HR ` +
        "sidebar. Remove the entry.",
    );
  }
}
