import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Every outstation surface must be desktop-table / mobile-cards, module-wide.
//
// The owner's standing rule (AGENTS.md §4): "desktop shows full tables/dashboards, mobile
// never does — mobile gets cards." An audit on 2026-08-24 found the outstation module had
// never been converted: 8 tables across 6 files, and not ONE carried a mobile gate — zero
// `md:hidden`, zero `hidden md:block`, zero `md:table`. Every one sat in a bare
// `overflow-x-auto`, so a 375px phone got a sideways-scrolling table. Three forced a minimum
// far wider than a phone: 760px and 860px on the dashboard, and 1,240px with two sticky
// columns on the request queue.
//
// The width is not the real cost. On the request queue the Actions column — View and Edit,
// the only things you can actually DO on that screen — sat off the right edge. On the HR
// expense review the sticky right column holds the approve switch, the amount field and the
// reason box: the controls that decide what an employee is reimbursed.
//
// Like its CRM sibling this scans the WHOLE directory rather than pinning a file list, so a
// new outstation panel is covered the moment it is added. It walks one level of
// subdirectories too — expense-command/ and expense-shared/ both hold table files.
// ─────────────────────────────────────────────────────────────────────────────

/** Tailwind's `md:` breakpoint. Below it outstation shows cards; at and above it, tables. */
const MOBILE_MAX_WIDTH_PX = 767;

const OUTSTATION_DIR = fileURLToPath(new URL("../src/components/outstation/", import.meta.url));

/**
 * How a table may be hidden below `md`.
 *
 * `data-portal-desktop-table` is deliberately NOT accepted here, though the CRM sibling accepts
 * it. That attribute only does anything because `enterprise-shell.tsx` injects
 * `@media (max-width: 767px) { [data-portal-desktop-table] { display: none !important } }` —
 * and that stylesheet ships with the EMPLOYEE PORTAL shell. Outstation pages live under
 * `app/(admin)/`, which renders `AppShell` and never mounts it, so on these screens the
 * attribute is inert decoration. Accepting it would let a table claim a gate that does not
 * exist at runtime. `<PortalDesktopTable>` is still fine — it carries a real
 * `hidden … md:block` wrapper as well as the attribute.
 */
const DESKTOP_GATES = [/\bmd:block\b/, /\bmd:table\b/];

/** How a file may render its mobile half. The primitive emits the `md:hidden` card list itself. */
const MOBILE_CARD_PATHS = [/\bPortalResponsiveDataList\b/, /\bmd:hidden\b/];

/**
 * Comments are stripped before matching, so a note explaining what a file USED to do — several
 * of these carry one — cannot fail the build by mentioning `overflow-x-auto` or a `<table>`
 * that no longer exists.
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

type OutstationFile = { name: string; source: string };

function outstationFiles(): OutstationFile[] {
  const files: OutstationFile[] = [];
  for (const entry of readdirSync(OUTSTATION_DIR, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      for (const nested of readdirSync(OUTSTATION_DIR + entry.name).sort()) {
        if (!nested.endsWith(".tsx")) continue;
        files.push({
          name: `${entry.name}/${nested}`,
          source: stripComments(readFileSync(`${OUTSTATION_DIR}${entry.name}/${nested}`, "utf8")),
        });
      }
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    files.push({
      name: entry.name,
      source: stripComments(readFileSync(OUTSTATION_DIR + entry.name, "utf8")),
    });
  }

  // A scan that silently found nothing would pass every assertion below and prove nothing —
  // the exact vacuous-pass failure this kind of test exists to prevent.
  assert.ok(
    files.length >= 20,
    `Expected the outstation component tree to hold at least 20 .tsx files, found ${files.length}. ` +
      "Either the directory moved or the scan is broken — a scan that finds nothing passes vacuously.",
  );
  return files;
}

function rendersDesktopTable(file: OutstationFile): boolean {
  return /<PortalDesktopTable\b/.test(file.source) || tableOffsets(file.source).length > 0;
}

export function runOutstationMobileTableCardTests() {
  const files = outstationFiles();
  const tableFiles = files.filter(rendersDesktopTable);

  // Six files carried the eight tables at conversion time. If this drops, a panel lost its
  // desktop view; if it climbs while the assertions below still pass, a new panel shipped
  // correctly gated — which is the point.
  assert.ok(
    tableFiles.length >= 6,
    `Expected at least 6 outstation files to render a desktop table, found ${tableFiles.length}. ` +
      "A panel that lost its <table> lost the desktop view, which is the opposite of the rule.",
  );

  for (const file of files) {
    // ── HEADLINE: not one ungated table survives ────────────────────────────
    // 640-char lookback: expense-report.tsx puts a synced top scrollbar between the gate and
    // the tag (measured 308 chars). Wide enough for that, far too narrow to borrow a gate
    // from an unrelated block.
    for (const offset of tableOffsets(file.source)) {
      const window = file.source.slice(Math.max(0, offset - 640), offset + 200);
      const gated = DESKTOP_GATES.some((gate) => gate.test(window));
      const line = file.source.slice(0, offset).split("\n").length;
      assert.ok(
        gated,
        `src/components/outstation/${file.name}:${line} renders a <table> that is still visible ` +
          `at ${MOBILE_MAX_WIDTH_PX}px. An outstation table must be desktop-only — sit inside a ` +
          "`hidden … md:block` wrapper, or be `hidden … md:table` itself. Reach for " +
          "<PortalDesktopTable> before hand-rolling either. Note that `data-portal-desktop-table` " +
          "alone does NOT work here: the CSS behind it ships with the employee-portal shell, and " +
          "these pages render AppShell.",
      );
    }

    // ── Never nest a <table> inside PortalDesktopTable ──────────────────────
    // It already IS the table. Nesting emits <table><table>, the parser foster-parents the
    // inner one out while React keeps it nested, and the page hydrates with a mismatch.
    assert.doesNotMatch(
      file.source,
      /<PortalDesktopTable[^>]*>\s*<table/,
      `src/components/outstation/${file.name} nests a <table> inside <PortalDesktopTable>, which ` +
        "already IS the table. Pass <thead>/<tbody> as its children instead.",
    );
  }

  // ── The cards actually exist, in every file that has a table ─────────────
  // A table hidden below md with nothing in its place is a blank screen — strictly worse than
  // the sideways-scrolling table it replaced.
  for (const file of tableFiles) {
    assert.ok(
      MOBILE_CARD_PATHS.some((path) => path.test(file.source)),
      `src/components/outstation/${file.name} renders a desktop-only table but no mobile card ` +
        "path, so a phone gets an empty panel where the data used to be. Render the rows through " +
        "<PortalResponsiveDataList>, or add an md:hidden card block beside the table.",
    );
  }

  // ── No table may hide in an ungated horizontal scroll box ────────
  // The pre-conversion shape was a full-width table inside an `overflow-x-auto` div, unchanged at
  // every viewport. It reads as "responsive" in a diff and is a sideways scroll on a phone.
  //
  // This deliberately does NOT flag every bare `overflow-x-auto`. The first draft did, and it went
  // red on five sites that were all correct: `-mx-1 overflow-x-auto px-1` around a single
  // `whitespace-nowrap` line. That idiom exists BECAUSE of the owner's standing rule — never
  // truncate with an ellipsis, never let text wrap — so a 95-character postal address scrolls
  // inside its own box and the page itself never moves. A test that forced those to carry a `md:`
  // gate would be ordering the next session to break that rule to go green.
  //
  // What is flagged is a scroll box whose contents force a FIXED PIXEL floor — `min-w-[860px]`,
  // `w-[1240px]` — because that is a table whether or not it is spelled `<table>`, and the floor
  // is the phone-hostile part. Content-driven widths (`w-max`, `min-w-max`, `min-w-full`) are the
  // legitimate line-scroll idiom and stay untouched.
  const FIXED_PX_FLOOR = /\b(?:min-)?w-\[\d{3,}px\]|<table\b|<PortalDesktopTable\b/;
  for (const file of files) {
    const pattern = /className=(?:"[^"]*|\{cn\(\s*"[^"]*)\boverflow-x-auto\b/g;
    let match = pattern.exec(file.source);
    while (match !== null) {
      const after = file.source.slice(match.index, match.index + 400);
      if (FIXED_PX_FLOOR.test(after)) {
        const window = file.source.slice(Math.max(0, match.index - 640), match.index + 400);
        const gated = DESKTOP_GATES.some((gate) => gate.test(window));
        const line = file.source.slice(0, match.index).split("\n").length;
        assert.ok(
          gated,
          `src/components/outstation/${file.name}:${line} puts content with a fixed pixel width ` +
            "floor inside an `overflow-x-auto` that has no md: gate on it or on an enclosing " +
            `element. At ${MOBILE_MAX_WIDTH_PX}px that is a sideways-scrolling table — whether or ` +
            "not it is spelled `<table>` — not a card list.",
        );
      }
      match = pattern.exec(file.source);
    }
  }

  // ── The HR decision controls are ONE component, not two copies ───────────
  // expense-report.tsx renders the approve switch, the adjusted-amount field and the reason box
  // in BOTH halves. These write the amount an employee is actually reimbursed, so a phone-only
  // copy that drifted from the desktop one would be a payroll defect, not a styling one.
  {
    const report = files.find((candidate) => candidate.name === "expense-report.tsx");
    assert.ok(report, "src/components/outstation/expense-report.tsx is missing.");
    const uses = report.source.match(/<HrDecisionControls\b/g) ?? [];
    assert.equal(
      uses.length,
      2,
      `expense-report.tsx should render <HrDecisionControls> exactly twice — once in the mobile ` +
        `card and once in the desktop row — found ${uses.length}. If a half stopped using it, the ` +
        "approve switch / amount / reason controls have been duplicated, and the two copies will " +
        "drift on a screen that decides real reimbursements.",
    );
    assert.match(
      report.source,
      /function HrDecisionControls\(/,
      "expense-report.tsx must define HrDecisionControls once and share it between both halves.",
    );
  }
}
