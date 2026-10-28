import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// docs/tables-said-once-fit.md rule 3, and AGENTS.md §4 (THE FITS-THE-SCREEN GOLDEN RULE): a data table
// is `w-full table-fixed` with a `<colgroup>`, fits by MERGING columns, carries no `min-width` floor, and
// has a phone layout. tests/fits-the-screen-ratchet.test.ts counts the scroll that permits overflow;
// this one counts the table that is built without the construct that prevents it.
//
// A source read cannot prove a table fits (only a browser measuring scrollWidth can), so this is a
// RATCHET: four counts, each of which may FALL as a screen is rebuilt and may never RISE. A new table
// is held to the rule from the day it is written. Heuristics, per file that draws a table:
//
//   notFixed      a raw `<table` and no `table-fixed` anywhere in the file
//   noColgroup    a raw `<table`, `<PortalDesktopTable`, `<CrmTable` or `<RgTable` and no `<colgroup`, no `cols=`
//   minWidth      a `<table` / `<PortalDesktopTable` tag with `min-w-…` / `minWidth`, a `minWidth` prop, or a
//                 `min-w-[…]` / `min-w-max` on the same line as an `overflow-x-…` wrapper
//   noPhoneLayout no card list for a phone: no PortalResponsiveDataList / CrmCardsOnPhone / CrmCard, no
//                 `md:hidden`-style pair and no `@container`
//
// The files in ALLOWED are exempt, each with its reason. Lower a BASELINE when screens are fixed; never
// raise one to make a red run green.
// ─────────────────────────────────────────────────────────────────────────────

const BASELINE = { noColgroup: 93, noPhoneLayout: 25, minWidth: 31, notFixed: 46 };

/** Exempt files and why. A new entry needs the owner's word, not a convenience. */
const ALLOWED: Readonly<Record<string, string>> = {
  "src/components/sales/closing-performance-review-workspace.tsx": "the monthly closing matrix keeps its scroll by the owner's ruling (MatrixScroller)",
  "src/components/sales/weekly/weekly-product-units-view.tsx": "a matrix whose width is a count of products (MatrixScroller, owner ruling)",
  "src/components/crm/crm-master-table.tsx": "the CRM Master report scrolls by the owner's decision (data-wide-report)",
  "src/components/payroll/copilot/payroll-copilot-workbench.tsx": "the Payroll Copilot 27-column sheet scrolls by the owner's decision (rebuilt on his July screenshots)",
  "src/components/admin/email-body-editor.tsx": "not a data table: the email body is a layout table in the editor",
  "src/components/recruitment/interview-calendar/month-picker.tsx": "not a data table: the interview calendar's month picker",
  "src/components/recruitment/interview-calendar/interview-calendar-view.tsx": "not a data table: the interview calendar grid",
  "src/components/offers/joining-form-page.tsx": "not a data table: the offer joining form",
  "src/components/hiring-pack/forms-drive.tsx": "not a data table: the hiring-pack papers keep their printed layout",
  "src/components/spotlight/spotlight-workspace.tsx": "not a data table: the spotlight sheet",
};

const ROOTS = ["app", "src/components"];
const TABLE_TAG = /<(?:table|PortalDesktopTable|CrmTable|RgTable|AdminTableShell)\b/;
const RAW_TABLE = /<table\b/;
const PHONE_LAYOUT = /PortalResponsiveDataList|CrmCardsOnPhone|<CrmCard\b|\b(?:sm|md|lg|xl):hidden\b|\b(?:md|lg|xl):block\b|\b(?:md|lg|xl):(?:flex|grid)\b|@container|@(?:md|lg|xl):/;

type Flags = { noColgroup: boolean; noPhoneLayout: boolean; minWidth: boolean; notFixed: boolean };

/** The tag text from `<name` to its closing `>` (an arrow `=>` inside an attribute does not end it). */
function tagsOf(source: string, name: RegExp): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(new RegExp(name.source, "g"))) {
    let depth = 0;
    let end = match.index ?? 0;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

export function flagsOf(rawSource: string): Flags | null {
  const source = stripComments(rawSource);
  if (!TABLE_TAG.test(source)) return null;
  const hasRaw = RAW_TABLE.test(source);
  const hasColgroup = /<colgroup\b/.test(source) || /\bcols=/.test(source);
  const tableTags = tagsOf(source, /<(?:table|PortalDesktopTable)\b/);
  const floorOnTag = tableTags.some((tag) => /min-w-|minWidth|style=\{\{[^}]*\bwidth/.test(tag));
  const floorBesideScroll = source.split("\n").some((line) => /\boverflow-x-(?:auto|scroll)\b/.test(line) && /\bmin-w-(?:\[|max)/.test(line));
  return {
    minWidth: floorOnTag || floorBesideScroll,
    noColgroup: !hasColgroup,
    noPhoneLayout: !PHONE_LAYOUT.test(source),
    notFixed: hasRaw && !/\btable-fixed\b/.test(source),
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

export function runTableStructureRatchetTests() {
  // Detector controls, before it is trusted on ~300 files.
  const good = '<table className="w-full table-fixed"><colgroup><col /></colgroup></table><div className="md:hidden">cards</div>';
  assert.deepEqual(flagsOf(good), { minWidth: false, noColgroup: false, noPhoneLayout: false, notFixed: false }, "a fitting table raises nothing");
  assert.equal(flagsOf('<table className="w-full"><tbody /></table>')?.notFixed, true, "a table with no table-fixed is seen");
  assert.equal(flagsOf('<table className="w-full table-fixed"><tbody /></table>')?.noColgroup, true, "a table with no colgroup is seen");
  assert.equal(flagsOf('<table className="w-full table-fixed min-w-[900px]"><colgroup /></table>')?.minWidth, true, "a min-width floor on the table is seen");
  assert.equal(flagsOf('<PortalDesktopTable cols={c} minWidth="900px">x</PortalDesktopTable>')?.minWidth, true, "the dead minWidth prop is seen");
  assert.equal(flagsOf('<div className="overflow-x-auto min-w-[700px]"><table className="table-fixed"><colgroup /></table></div>')?.minWidth, true, "a floor beside an overflow wrapper is seen");
  assert.equal(flagsOf('<table className="table-fixed"><colgroup /></table>')?.noPhoneLayout, true, "no phone layout is seen");
  assert.equal(flagsOf("<div>no table here</div>"), null, "a file with no table is not a table file");
  assert.equal(flagsOf('// <table className="w-full">\n<div />'), null, "a comment naming a table is prose");
  assert.equal(flagsOf('<table className="w-full table-fixed" onClick={() => go()}><colgroup /></table>')?.minWidth, false, "an arrow function in an attribute must not cut the tag short");

  const files = ROOTS.flatMap((root) => walk(root));
  assert.ok(files.length > 800, `only ${files.length} .tsx files were scanned — the walk is not reaching the tree`);
  for (const allowed of Object.keys(ALLOWED)) {
    assert.ok(files.includes(allowed), `ALLOWED names ${allowed}, which no longer exists — remove the entry`);
    assert.ok(ALLOWED[allowed].length > 20, `${allowed}: an exemption needs its reason`);
  }

  const found: Record<keyof Flags, string[]> = { minWidth: [], noColgroup: [], noPhoneLayout: [], notFixed: [] };
  let tableFiles = 0;
  for (const file of files) {
    if (file in ALLOWED) continue;
    const flags = flagsOf(readFileSync(file, "utf8"));
    if (!flags) continue;
    tableFiles++;
    for (const key of Object.keys(found) as Array<keyof Flags>) if (flags[key]) found[key].push(file);
  }
  assert.ok(tableFiles > 150, `only ${tableFiles} table files were found — the detector is not reaching the tables`);

  const advice: Record<keyof Flags, string> = {
    minWidth: "no min-w-[…], min-w-max or minWidth on a table or its wrapper — fit by MERGING columns, never a floor",
    noColgroup: "every table has a <colgroup> (PortalDesktopTable: the `cols` prop) whose percentages add up to 100",
    noPhoneLayout: "every table has a phone layout below md: cards that carry every column's fact (PortalResponsiveDataList / CrmCardsOnPhone)",
    notFixed: '<table className="w-full table-fixed">',
  };
  for (const key of Object.keys(found) as Array<keyof Flags>) {
    const count = found[key].length;
    assert.ok(
      count <= BASELINE[key],
      `table structure "${key}": ${count - BASELINE[key]} new file(s) — the count went ${BASELINE[key]} -> ${count}.\n` +
        `The rule (docs/tables-said-once-fit.md rule 3): ${advice[key]}.\nLatest files:\n  ${found[key].slice(-12).join("\n  ")}`,
    );
    if (count < BASELINE[key]) {
      console.warn(`Good news: table structure "${key}" dropped ${BASELINE[key]} -> ${count}. Lower BASELINE.${key} in tests/table-structure-ratchet.test.ts to ${count}.`);
    }
  }
}
