import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Every CRM board must be desktop-table / mobile-cards. No exceptions, module-wide.
//
// The owner's standing rule (AGENTS.md §4): "desktop shows full tables/dashboards, mobile
// never does — mobile gets cards." The portal honours it through PortalDesktopTable +
// PortalResponsiveDataList, and employee-portal-mobile-table-cards.test.ts pins three files
// that were converted on 2026-08-16. The CRM module was never converted at all: an audit on
// 2026-08-21 found ZERO files under src/components/crm using the pattern, against 44 of 529
// elsewhere under src/components. All eight table-bearing CRM files rendered a full table
// inside a bare `overflow-x-auto` at every width, so a 375px phone got a ~700–1100px table
// scrolling sideways inside a container that gave no hint it was scrollable.
//
// That is not only a cosmetic loss. DoctorCoverageBoard is mounted at
// app/employee-portals/doctor-coverage/page.tsx as well as the admin route — a Medical Rep
// opens it on a phone — and the mapping panels put their *resolution control* in the last
// column, which is the first thing to go off the right edge.
//
// This test differs from its portal sibling in one deliberate way: that one pins a fixed
// list of three converted files, this one scans the WHOLE directory. The owner's constraint
// when he approved the conversion was that the CRM coverage boards "read as one module" and
// must move together or not at all — so a NEW board dropped into src/components/crm is
// covered the moment it is added, without anyone remembering to extend a list.
// ─────────────────────────────────────────────────────────────────────────────

/** Tailwind's `md:` breakpoint. Below it the CRM shows cards; at and above it, tables. */
const MOBILE_MAX_WIDTH_PX = 767;

const CRM_DIR = fileURLToPath(new URL("../src/components/crm/", import.meta.url));

/**
 * A `<table>` is safe on a phone when it is hidden below `md`. Three spellings are in use
 * and all three are correct:
 *   - `data-portal-desktop-table` — the attribute enterprise-shell.tsx display:none's
 *   - `hidden … md:block` on a wrapper div
 *   - `hidden … md:table` on the table itself
 */
const DESKTOP_GATES = [/data-portal-desktop-table/, /\bmd:block\b/, /\bmd:table\b/];

/** How a file may render its mobile half. The primitive emits the `md:hidden` card list itself. */
const MOBILE_CARD_PATHS = [/\bPortalResponsiveDataList\b/, /\bmd:hidden\b/];

/**
 * Comments are stripped before any match, so an explanatory note that mentions
 * `overflow-x-auto` or a `<table>` that no longer exists cannot fail a build. This is the
 * reason the test disagrees with a naive grep, and it is deliberate — several of these
 * files carry a comment describing exactly what they used to do.
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

type CrmFile = { name: string; source: string };

function crmFiles(): CrmFile[] {
  const files = readdirSync(CRM_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .sort()
    .map((name) => ({ name, source: stripComments(readFileSync(CRM_DIR + name, "utf8")) }));

  // A directory scan that silently found nothing would pass every assertion below and prove
  // nothing at all — the exact failure mode this whole test exists to prevent elsewhere.
  assert.ok(
    files.length >= 10,
    `Expected the CRM component directory to hold at least 10 .tsx files, found ${files.length}. ` +
      "Either the directory moved or the scan is broken — a scan that finds nothing passes vacuously.",
  );
  return files;
}

/** Does this file render a desktop table at all — raw, or through the shared primitive? */
function rendersDesktopTable(file: CrmFile): boolean {
  return /<PortalDesktopTable\b/.test(file.source) || tableOffsets(file.source).length > 0;
}

export function runCrmMobileTableCardTests() {
  const files = crmFiles();
  const tableFiles = files.filter(rendersDesktopTable);

  // The conversion covered eight files: seven render a real <table>, and doctor-coverage-board
  // renders the call list as a div grid — a table in all but tag name, seven fixed columns held
  // apart by min-w-*, which is why it is checked by name just below rather than by <table>.
  // If this count drops, a board lost its desktop view; if it climbs without the assertions
  // below passing, a new board shipped ungated.
  assert.ok(
    tableFiles.length >= 7,
    `Expected at least 7 CRM files to render a desktop table, found ${tableFiles.length}. ` +
      "A board that lost its <table> lost the desktop view, which is the opposite of the rule.",
  );

  // The call list is not a <table>, so nothing above reaches it. It is still seven columns of
  // fixed-width spans on one nowrap flex row, which on a 375px screen is the same defect with a
  // different tag — it gets the same split.
  //
  // This one is checked by OUTCOME rather than by naming <PortalResponsiveDataList>, because
  // that primitive is not available here. doctor-coverage-board.tsx has no "use client" — it
  // renders on the server — and portal-primitives.tsx does, so handing the primitive getKey /
  // renderCard / renderTable serialises three functions across the RSC boundary. React refuses,
  // and both /admin/doctor-coverage and /employee-portals/doctor-coverage 500 on every load.
  // That is not hypothetical: pinning the primitive by name here is what pushed the board onto
  // it in #2264, and production returned "Admin workspace unavailable" for about an hour on
  // 2026-08-21 (digests 1878765947 / 3180310587 / 923360379 — one per function prop).
  // The board now inlines exactly what the primitive emits, so the rule is unchanged; only the
  // spelling is. rsc-client-function-props.test.ts guards the boundary itself.
  const board = files.find((candidate) => candidate.name === "doctor-coverage-board.tsx");
  assert.ok(board, "src/components/crm/doctor-coverage-board.tsx is missing.");
  assert.match(
    board.source,
    /\bmd:hidden\b/,
    "src/components/crm/doctor-coverage-board.tsx must keep a card list gated to below md for " +
      "its call list. It is a div grid rather than a <table>, so the <table> scan above cannot " +
      "see it — a regression there would otherwise ship silently.",
  );
  assert.match(
    board.source,
    /\bPortalRecordCard\b/,
    "src/components/crm/doctor-coverage-board.tsx must build its mobile call list out of real " +
      "<PortalRecordCard>s, not a narrowed copy of the desktop row.",
  );
  assert.match(
    board.source,
    /hidden[^"]*\bmd:block\b/,
    "src/components/crm/doctor-coverage-board.tsx must keep its wide call-list row list hidden " +
      "below md. Cards on a phone are only half the rule — the desktop half has to be gated too.",
  );

  for (const file of files) {
    // ── HEADLINE: not one ungated raw table survives ─────────────────────────
    // The gate is looked for in the 640 characters before the tag. That is wider than the
    // portal sibling's 240 because crm-master-table.tsx puts its synced top scrollbar and a
    // max-h scroll container between the `hidden md:block` wrapper and the tag (515 chars
    // measured). It is still far too short to borrow a gate from an unrelated block.
    for (const offset of tableOffsets(file.source)) {
      const window = file.source.slice(Math.max(0, offset - 640), offset + 200);
      const gated = DESKTOP_GATES.some((gate) => gate.test(window));
      const line = file.source.slice(0, offset).split("\n").length;
      assert.ok(
        gated,
        `src/components/crm/${file.name}:${line} renders a <table> that is still visible at ` +
          `${MOBILE_MAX_WIDTH_PX}px. A CRM table must be desktop-only — carry ` +
          "`data-portal-desktop-table`, or sit inside a `hidden … md:block` wrapper, or be " +
          "`hidden … md:table` itself. Reach for <PortalDesktopTable> before hand-rolling any " +
          "of the three.",
      );
    }

    // ── Never nest a <table> inside PortalDesktopTable ───────────────────────
    // It already IS the table. Nesting emits <table><table> on the server, the HTML parser
    // foster-parents the inner one out while React keeps it nested, and the page hydrates
    // with a mismatch. early-birds-rep-table shipped exactly this bug on 2026-08-16.
    assert.doesNotMatch(
      file.source,
      /<PortalDesktopTable[^>]*>\s*<table/,
      `src/components/crm/${file.name} nests a <table> inside <PortalDesktopTable>, which ` +
        "already IS the table. Pass <thead>/<tbody> as its children instead.",
    );
  }

  // ── The cards actually exist, in every file that has a table ──────────────
  // A table hidden below md with nothing in its place is a blank screen — strictly worse
  // than the sideways-scrolling table it replaced.
  for (const file of tableFiles) {
    assert.ok(
      MOBILE_CARD_PATHS.some((path) => path.test(file.source)),
      `src/components/crm/${file.name} renders a desktop-only table but no mobile card path, ` +
        `so a phone gets an empty panel where the data used to be. Render the rows through ` +
        "<PortalResponsiveDataList> (which emits the md:hidden card list for you), or add an " +
        "md:hidden card block beside the table.",
    );
  }

  // ── No table may sit in a bare overflow-x-auto any more ───────────────────
  // This is the exact shape the whole module used before 2026-08-21: a full-width table in
  // an `overflow-x-auto` div, unchanged at every viewport. It reads as "responsive" in a
  // diff and is a sideways scroll on a phone. PortalDesktopTable's own wrapper is
  // `hidden overflow-x-auto md:block`, so the gate and the scroll always travel together.
  //
  // The gate may sit on the element itself or on an ancestor, so this uses the same lookback
  // window as the <table> scan: crm-master-table.tsx puts its synced top scrollbar inside the
  // `hidden md:block` wrapper rather than repeating the gate on every child, and that is
  // correct — a gated ancestor makes everything under it unreachable on a phone.
  for (const file of files) {
    const pattern = /className="[^"]*\boverflow-x-auto\b[^"]*"/g;
    let match = pattern.exec(file.source);
    while (match !== null) {
      const window = file.source.slice(Math.max(0, match.index - 640), match.index + match[0].length);
      const gated = DESKTOP_GATES.some((gate) => gate.test(window));
      const line = file.source.slice(0, match.index).split("\n").length;
      assert.ok(
        gated,
        `src/components/crm/${file.name}:${line} wraps content in a bare \`overflow-x-auto\` ` +
          `with no md: gate on it or on an enclosing element. At ${MOBILE_MAX_WIDTH_PX}px that ` +
          "is a sideways-scrolling table, not a card list. Pair it with `hidden … md:block`.",
      );
      match = pattern.exec(file.source);
    }
  }

  // ── The two coverage boards moved together, and must stay that way ────────
  // The owner's condition when approving this: the CRM coverage boards are built to read as
  // one module, so they move together or not at all. Converting one and leaving the other
  // is the specific outcome he ruled out.
  for (const name of ["doctor-coverage-tables.tsx", "rep-doctor-lists-tables.tsx"]) {
    const file = files.find((candidate) => candidate.name === name);
    assert.ok(file, `src/components/crm/${name} is missing — the coverage boards move together.`);
    assert.match(
      file.source,
      /\bPortalResponsiveDataList\b/,
      `src/components/crm/${name} must render its rows through <PortalResponsiveDataList>. ` +
        "The sibling coverage board does; converting one and not the other is exactly the " +
        "split the owner ruled out when he approved the module-wide change.",
    );
  }
  // -- A name in a mobile card must be allowed to wrap ------------------------
  // crm-recovered-chains-panel's <ResolvedChain> is deliberately rendered by BOTH halves, so
  // whatever it does happens on the phone too. Its two spans hold real people's names --
  // chain.hingeManagerName and chain.resolvedMrName -- and both carried an unconditional
  // `whitespace-nowrap`. On desktop that is right: the row sits in PortalDesktopTable, which is
  // `hidden overflow-x-auto md:block` at 960px, so a long name scrolls inside the table. On a
  // phone the same markup sits in a card whose container (`border border-slate-200 bg-white`)
  // has NO `overflow-hidden`, so the name extends the page instead.
  //
  // Measured 2026-08-21 at 375px in DM Sans, against the real shell content width (app-shell's
  // <main> is `px-3`, so 351px, not 375): growing the hinge-manager name one character at a time
  // pushed documentElement.scrollWidth from 375 to 376 at 55 characters. The longest
  // employees.full_name company-wide is 52. Three characters of margin -- not a live defect, but
  // one longer hire reintroduces exactly the sideways-scrolling phone page the mobile-card work
  // exists to remove, and that #2268 fixed for PortalRecordCard's title.
  {
    const panel = files.find((candidate) => candidate.name === "crm-recovered-chains-panel.tsx");
    assert.ok(panel, "src/components/crm/crm-recovered-chains-panel.tsx is missing.");

    const body = /function ResolvedChain\b[\s\S]*?\n}/.exec(panel.source);
    assert.ok(
      body,
      "ResolvedChain was not found in crm-recovered-chains-panel.tsx. It renders the hinge-manager " +
        "and resolved-MR names in BOTH the mobile card and the desktop row; if it was renamed or " +
        "inlined, re-point this assertion rather than deleting it.",
    );

    const nameSpans = (body[0].match(/className="[^"]*"/g) ?? []).filter((span) =>
      span.includes("whitespace-nowrap"),
    );
    assert.ok(
      nameSpans.length > 0,
      "ResolvedChain no longer gates nowrap on a breakpoint at all. That is safe for the page, but " +
        "the desktop row is then free to wrap mid-name inside a 960px table -- use " +
        "`md:whitespace-nowrap` so each half keeps its own behaviour.",
    );

    for (const span of nameSpans) {
      const classes = span.slice('className="'.length, -1).split(/\s+/);
      assert.ok(
        !classes.includes("whitespace-nowrap"),
        "ResolvedChain has a span with an unconditional `whitespace-nowrap`: " +
          span +
          ". It holds a person's name, and below md it renders inside a mobile card with no " +
          "overflow-hidden, so a 55-character name pushes the whole 375px page sideways " +
          "(measured: documentElement.scrollWidth 376 against a 375 viewport). Use " +
          "`md:whitespace-nowrap` -- one line on desktop, wrapping on a phone.",
      );
      assert.ok(
        classes.includes("md:whitespace-nowrap"),
        "ResolvedChain span " +
          span +
          " must keep `md:whitespace-nowrap`, so the desktop row -- which scrolls inside " +
          "PortalDesktopTable -- still puts the name on one line.",
      );
    }
  }
}
