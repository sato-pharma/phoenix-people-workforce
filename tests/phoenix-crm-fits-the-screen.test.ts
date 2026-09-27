import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE FITS-THE-SCREEN GOLDEN RULE (AGENTS.md §4), pinned for the WHOLE Phoenix CRM
// admin module — the screens the 2026-09-26/27 build added, and every screen added
// to it after this.
//
//     "never a horizontal scroll, always mobile AND desktop friendly. Use
//      `<table className="w-full table-fixed">` with a `<colgroup>`; fit by MERGING
//      columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug"
//
// WHY THIS TEST EXISTS
// The approved 21-point CRM plan listed a screen-fit measurement as one of its own
// verification steps, and that step was never taken — the session that shipped the
// last point said so in as many words. Measured here on 2026-09-28, the module was
// in fact CLEAN: 24 files, exactly ONE `<table>` element in the whole module (inside
// `CrmTable`), and not one of the four sideways-scroll spellings anywhere. Nothing
// pinned any of that. `tests/crm-mobile-table-cards.test.ts` sweeps the OLDER
// `src/components/crm/` directory and never looks here, and
// `tests/fits-the-screen-ratchet.test.ts` counts the scroll construct repo-wide but,
// in its own words, "cannot prove a screen fits" and permits the count to sit still.
// So a raw `<table>` dropped into a new CRM tab, or an `overflow-x-auto` added to an
// existing one, would have gone in green.
//
// WHAT IS PINNED, AND WHY EACH ONE IS THE BUG WHEN IT BREAKS
//
//  1 · A FLOOR on the file count. A moved or renamed directory sweeps nothing and
//      reads green — the failure mode every derived sweep here has to answer for.
//  2 · ONE `<table>` in the module, inside `CrmTable`. The primitive is what carries
//      `w-full table-fixed` and the `<colgroup>`; a raw table beside it is the rule's
//      own anti-pattern with nothing holding its widths.
//  3 · `CrmTable` itself still declares `w-full`, `table-fixed` and a `<colgroup>`,
//      one `<col>` per declared width. Lose `table-fixed` and the declared widths
//      become suggestions the browser is free to ignore.
//  4 · NO sideways-scroll class, in any of the four spellings. `overflow-auto` and
//      `overflow-scroll` are the shorthand and set BOTH axes, so they grant exactly
//      the same sideways scroll as the explicit pair.
//  5 · CARDS ON A PHONE. `CrmTable` is `hidden md:block` by default, so a file that
//      renders one and no `CrmCardsOnPhone` shows a phone NOTHING AT ALL. That is a
//      blank screen, not a cramped one, which is why it is an assertion and not a
//      ratchet.
//  6 · DECLARED WIDTHS NEVER EXCEED THE BOX. Percentages summing over 100 under
//      `table-fixed` push the table wider than its container, and `.admin-shell`
//      carries `overflow-x: clip` (app/globals.css), so the excess is CUT rather
//      than scrolled — invisible to `scrollWidth` and to the eye.
//  7 · ONE DECLARED WIDTH PER HEADER CELL. A `<colgroup>` shorter than the header row
//      silently leaves the last columns to share whatever is left, which is how a
//      table that was measured once drifts after a column is added.
//  8 · A CELL BREAKS A LONG WORD. Same `overflow-x: clip` again: under `table-fixed`
//      an unbreakable token does not widen the table, it is cut mid-word. `break-words`
//      on the shared cell class is what makes a 52-character customer name wrap
//      instead of disappearing.
//
// WHAT THIS CANNOT DO, said plainly
// It cannot prove a screen fits. Only a browser can, by measuring
// `scrollWidth > clientWidth` over `main` at desktop and at 375px, and per-cell
// `td.scrollWidth > td.clientWidth` because the admin shell clips rather than scrolls.
// This pins the constructs that make fitting possible, across every screen in the
// module at once, including the ones nobody has measured yet. The two are complements.
//
// SO THE MEASUREMENT WAS TAKEN, 2026-09-28 — the plan's own unrun step, on the A2 Today
// screen, in a served harness with the shell chain, the real class values and the LONGEST
// strings production holds (the 36-character Arabic customer name, the 21-character
// speciality, and the worst sentence `describeDayWindows` can build). Every reading
// carried a control.
//
//   viewport   main      page scrollWidth/clientWidth   cells clipped
//   375        375       375 / 375                      0   (cards shown, table hidden)
//   768        768       768 / 768                      0
//   1024       752       1024 / 1024                    0   ← the worst case: the 272px
//   1280      1008      1280 / 1280                     0     sidebar appears at lg, so
//                                                             1024 is NARROWER than 768
//
//   controls   a left-anchored 900px probe   page 1188 / 1024  → seen
//              the List column cut to 3%     3 cells clipped, "PM" needing 25px in 22px
//
// AND THE ONE THAT MATTERS FOR CHECK 8, measured at 1024: with `break-words` removed, a
// 64-character Latin token rendered 638px of ink inside a 207px cell — 420px hanging past
// it, `td.scrollWidth - clientWidth = 419` — while the page's OWN `scrollWidth` stayed at
// exactly 1024. The golden rule's prescribed page check reads perfectly clean on a cell
// with 420px hanging off the side, because `.admin-shell { overflow-x: clip }` cuts rather
// than scrolls. With `break-words` on, the same token measured 202px inside 207px. The real
// longest production name measures 178px in that 207px cell: 29px of headroom.
//
// (An Arabic token is NOT a control for this — 60 repeated Arabic letters wrapped happily
// with `overflow-wrap: normal`, because the script offers break opportunities between
// letters. The first attempt used one and read a false clean.)
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = new URL("../", import.meta.url);

/** The Phoenix CRM admin module — the tabs, boards and primitives a browser renders. */
const MODULE_DIR = "src/components/phoenix-crm";

/**
 * The module held 24 `.tsx` files on 2026-09-28. The floor is deliberately well under that:
 * it is here to catch a MOVED directory, not to freeze the file count.
 */
const FILE_FLOOR = 20;

/** The one file allowed to render a `<table>` element: the primitive every screen goes through. */
const TABLE_PRIMITIVE = "ui.tsx";

/**
 * Every class that GRANTS a page permission to scroll SIDEWAYS. The last two are the
 * shorthand and set both axes, so they permit the same sideways scroll as the explicit pair.
 */
const SIDEWAYS_SCROLL = ["overflow-x-auto", "overflow-x-scroll", "overflow-auto", "overflow-scroll"] as const;

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function exists(path: string): boolean {
  try {
    statSync(fileURLToPath(new URL(path, ROOT)));
    return true;
  } catch {
    return false;
  }
}

/** Every `.tsx` directly under the module, comments already blanked. */
function moduleFiles(): Array<{ name: string; source: string }> {
  return readdirSync(fileURLToPath(new URL(MODULE_DIR, ROOT)), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => ({ name: entry.name, source: stripComments(read(`${MODULE_DIR}/${entry.name}`)) }));
}

/** The `"28%"`-style widths of one `columns={[ … ]}` literal, plus how many entries it declared. */
function declaredWidths(literal: string): { entries: number; percentages: number[] } {
  const inner = literal.slice(literal.indexOf("[") + 1, literal.lastIndexOf("]"));
  const entries = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const percentages = entries
    .map((part) => /^["'](\d+(?:\.\d+)?)%["']$/.exec(part))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return { entries: entries.length, percentages };
}

/**
 * Every declared column set in a source, found from the `columns` prop itself rather than from the
 * component holding it.
 *
 * A first pass keyed on `<CrmTable` and read the next `columns={[…]}` after it, which is wrong here
 * and false-failed on `reports-tab.tsx`: the module's six report tables are declared on a local
 * `ReportList` wrapper that forwards `columns={columns}` into one `<CrmTable>` and maps `headers`
 * into the `<th>`s. So the file holds ONE `<CrmTable>`, whose own header row is a single literal
 * `<th>` inside a `.map()`, and six callers each declaring five widths. Keying on the prop reads
 * both shapes correctly:
 *
 *   - a tag that ALSO declares `headers={[…]}` is checked against that list, and
 *   - a `<CrmTable>` with a literal `<thead>` is checked against its own `<th>` count.
 *
 * A tag whose widths are a forwarded variable declares nothing and is not counted; the caller that
 * supplied the literal is what gets checked.
 */
function declaredColumnSets(source: string): Array<{ tag: string; literal: string; headerCells: number | null }> {
  const out: Array<{ tag: string; literal: string; headerCells: number | null }> = [];
  for (const match of source.matchAll(/columns=\{(\[[\s\S]*?\])\}/g)) {
    const at = match.index ?? 0;
    const literal = match[1] ?? "[]";

    // The opening tag this prop belongs to: the nearest `<Name` before it.
    const before = source.slice(0, at);
    const tagAt = before.lastIndexOf("<");
    const tag = /^<([A-Za-z][\w.]*)/.exec(source.slice(tagAt))?.[1] ?? "";

    // The rest of that opening tag, so a sibling `headers` prop is read from the SAME element.
    const tagEnd = source.indexOf(">", at + match[0].length);
    const tagProps = source.slice(tagAt, tagEnd === -1 ? source.length : tagEnd);
    const headers = /headers=\{(\[[\s\S]*?\])\}/.exec(tagProps);

    let headerCells: number | null = null;
    if (headers) {
      headerCells = declaredWidths(headers[1] ?? "[]").entries;
    } else if (tag === "CrmTable") {
      const thead = source.indexOf("</thead>", at);
      headerCells = thead === -1 ? null : (source.slice(at, thead).match(/<th\b/g) ?? []).length;
    }
    out.push({ tag, literal, headerCells });
  }
  return out;
}

export function runPhoenixCrmFitsTheScreenTests(): void {
  // ── 1 · The sweep is looking at something ───────────────────────────────────────────────────────
  assert.ok(exists(MODULE_DIR), `${MODULE_DIR} must exist — a moved module would sweep nothing and read green`);
  const files = moduleFiles();
  assert.ok(
    files.length >= FILE_FLOOR,
    `${MODULE_DIR} holds ${files.length} .tsx files, below the floor of ${FILE_FLOOR}. Either the module moved or the sweep is looking at nothing.`,
  );
  assert.ok(
    files.some((file) => file.name === TABLE_PRIMITIVE),
    `${MODULE_DIR}/${TABLE_PRIMITIVE} is missing — the table primitive this test is built around has moved`,
  );

  const problems: string[] = [];

  // ── 2 · Exactly one `<table>` in the module, and it is the primitive ────────────────────────────
  for (const file of files) {
    const tables = (file.source.match(/<table\b/g) ?? []).length;
    if (tables === 0) continue;
    if (file.name !== TABLE_PRIMITIVE) {
      problems.push(
        `${MODULE_DIR}/${file.name} renders a raw <table>. Every table in this module goes through <CrmTable>, ` +
          `which is what carries "w-full table-fixed" and the <colgroup> the golden rule asks for.`,
      );
    } else if (tables !== 1) {
      problems.push(`${MODULE_DIR}/${TABLE_PRIMITIVE} renders ${tables} <table> elements; the primitive is meant to be the only one`);
    }
  }

  // ── 3 · The primitive still fixes its own layout ────────────────────────────────────────────────
  const primitive = files.find((file) => file.name === TABLE_PRIMITIVE)?.source ?? "";
  const primitiveTable = /<table\b[^>]*>/.exec(primitive)?.[0] ?? "";
  for (const required of ["w-full", "table-fixed"]) {
    if (!primitiveTable.includes(required)) {
      problems.push(
        `${MODULE_DIR}/${TABLE_PRIMITIVE}'s <table> no longer declares "${required}". Without it the declared column ` +
          `widths become suggestions the browser may ignore, and the table sizes itself to its content.`,
      );
    }
  }
  if (!primitive.includes("<colgroup>") || !primitive.includes("<col ")) {
    problems.push(`${MODULE_DIR}/${TABLE_PRIMITIVE} no longer renders a <colgroup> of <col> elements — nothing holds the column widths`);
  }
  if (!/hidden md:block/.test(primitive)) {
    problems.push(
      `${MODULE_DIR}/${TABLE_PRIMITIVE} no longer hides its table below md. A table on a phone is the horizontal scroll ` +
        `the rule forbids; the phone gets cards instead.`,
    );
  }

  // ── 4 · Nothing grants a sideways scroll ────────────────────────────────────────────────────────
  for (const file of files) {
    for (const spelling of SIDEWAYS_SCROLL) {
      if (!file.source.includes(spelling)) continue;
      problems.push(
        `${MODULE_DIR}/${file.name} uses "${spelling}", which grants a SIDEWAYS scroll. The fix is per-screen layout ` +
          `work — table-fixed with a <colgroup>, merged columns, cards on a phone — never the class. ` +
          `(A list meant to scroll vertically wants overflow-y-auto.)`,
      );
    }
  }

  // ── 5 · Every desktop-only table has a phone card path ──────────────────────────────────────────
  for (const file of files) {
    if (file.name === TABLE_PRIMITIVE) continue;
    if (!/<CrmTable\b/.test(file.source)) continue;
    // `desktopOnly={false}` renders the table at every width, so that file needs no card path.
    if (file.source.includes("desktopOnly={false}")) continue;
    // The element, rendered — not the name as a substring. A first pass used `includes`, and a
    // deliberate rename to `CrmCardsOnPhoneX` walked straight past it, because the typo CONTAINS
    // the name it broke.
    if (!/<CrmCardsOnPhone\b/.test(file.source)) {
      problems.push(
        `${MODULE_DIR}/${file.name} renders a <CrmTable> (hidden below md) with no <CrmCardsOnPhone>. A phone would be ` +
          `shown NOTHING on this screen — a blank, not a cramped, layout.`,
      );
    }
  }

  // ── 6 and 7 · Declared widths fit the box, one per header cell ──────────────────────────────────
  let columnSetsSeen = 0;
  for (const file of files) {
    if (file.name === TABLE_PRIMITIVE) continue;

    // Every table in the module declares its widths somewhere. A `<CrmTable>` with no `columns`
    // prop at all has none, literal or forwarded, and sizes itself to its content.
    for (const match of file.source.matchAll(/<CrmTable\b[\s\S]*?>/g)) {
      if (!/\bcolumns=\{/.test(match[0])) {
        problems.push(`${MODULE_DIR}/${file.name} renders a <CrmTable> with no columns prop — its widths are undeclared`);
      }
    }

    for (const set of declaredColumnSets(file.source)) {
      columnSetsSeen += 1;
      const { entries, percentages } = declaredWidths(set.literal);
      const total = percentages.reduce((sum, width) => sum + width, 0);
      if (total > 100) {
        problems.push(
          `${MODULE_DIR}/${file.name} declares column widths summing to ${total}% on <${set.tag}>, over the 100% of its ` +
            `container. Under table-fixed the table then exceeds its box, and .admin-shell's overflow-x: clip CUTS the ` +
            `excess rather than scrolling it — invisible to scrollWidth and to the reader. Merge columns instead.`,
        );
      }
      if (set.headerCells !== null && set.headerCells > 0 && entries !== set.headerCells) {
        problems.push(
          `${MODULE_DIR}/${file.name} declares ${entries} column widths for ${set.headerCells} header cells on ` +
            `<${set.tag}>. A short <colgroup> leaves the remaining columns to share what is left, so a measured table ` +
            `drifts the moment a column is added.`,
        );
      }
    }
  }
  assert.ok(
    columnSetsSeen >= 12,
    `Only ${columnSetsSeen} declared column sets were parsed; there were 13 on 2026-09-28. The parser has stopped ` +
      `matching, so checks 6 and 7 are passing on nothing.`,
  );

  // ── 8 · A long word wraps instead of being clipped ──────────────────────────────────────────────
  if (!/crmTdClassName\s*=\s*"[^"]*break-words/.test(primitive)) {
    problems.push(
      `crmTdClassName no longer carries "break-words". Under table-fixed an unbreakable token does not widen the ` +
        `table — .admin-shell's overflow-x: clip cuts it mid-word — so a long customer name would silently vanish.`,
    );
  }

  assert.deepEqual(problems, [], `Phoenix CRM breaks the fits-the-screen golden rule:\n  - ${problems.join("\n  - ")}`);

  // ── 9 · The detectors are alive ─────────────────────────────────────────────────────────────────
  // Each check above reports ZERO today. A zero from a detector that cannot match anything looks
  // exactly the same, so every one of them is shown a positive case here.
  assert.equal((`<div className="overflow-x-auto">`.match(/overflow-x-auto/g) ?? []).length, 1, "the scroll detector matches nothing");
  assert.equal(stripComments(`// overflow-x-auto in a comment\nconst a = 1;`).includes("overflow-x-auto"), false, "comments are not stripped");
  // (a) A direct `<CrmTable>` is read against its own literal header row.
  const direct = declaredColumnSets(`<CrmTable columns={["60%", "60%"]}>\n<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>`);
  assert.equal(direct.length, 1, "the columns-prop parser missed a declared table");
  assert.equal(direct[0]?.tag, "CrmTable", "the parser misread which element declared the widths");
  assert.equal(direct[0]?.headerCells, 3, "the header-cell counter missed a <th>");
  const directWidths = declaredWidths(direct[0]?.literal ?? "[]");
  assert.equal(directWidths.entries, 2, "the width parser miscounted its entries");
  assert.equal(
    directWidths.percentages.reduce((sum, width) => sum + width, 0),
    120,
    "the width parser would not notice widths summing over 100%",
  );

  // (b) A wrapper declaring its own `headers` is read against THAT list, not against a `<th>` it
  //     never writes — the shape `reports-tab.tsx` uses, and what the first version of this test
  //     got wrong.
  const wrapped = declaredColumnSets(`<ReportList\n  columns={["28%", null, null]}\n  headers={["Rep", "PM", "AM", "Total"]}\n/>`);
  assert.equal(wrapped.length, 1, "the parser missed a wrapper that declares its own widths");
  assert.equal(wrapped[0]?.tag, "ReportList", "the parser did not attribute the widths to the wrapper");
  assert.equal(wrapped[0]?.headerCells, 4, "a sibling headers={[…]} list was not read from the same element");
  assert.equal(declaredWidths(wrapped[0]?.literal ?? "[]").entries, 3, "the wrapper's own width count was misread");

  // (c) A forwarded `columns={columns}` declares nothing and must not be counted — otherwise the
  //     primitive's own forward would be checked against the first caller's literal.
  assert.equal(declaredColumnSets(`<CrmTable columns={columns}>`).length, 0, "a forwarded columns prop was read as a declaration");
  assert.equal(declaredWidths(`["30%", null, "20%"]`).entries, 3, "a null width is not counted as a column");
  assert.equal(declaredWidths(`["30%", null, "20%"]`).percentages.length, 2, "a null width must not be read as a percentage");
}
