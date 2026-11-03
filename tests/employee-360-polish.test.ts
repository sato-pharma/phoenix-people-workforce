import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { employeeAvatarGround, employeeInitials } from "../src/components/employee-360/avatar.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const PAGES = [
  "app/(admin)/employee-360/[hrId]/page.tsx",
  "app/employee-portals/employee-360/page.tsx",
  "app/employee-portals/employee-360/[hrId]/page.tsx",
];

const UI = [
  "src/components/employee-360/employee-360-view.tsx",
  "src/components/employee-360/employee-search-list.tsx",
  "src/components/employee-360/period-filter.tsx",
  "src/components/employee-360/charts.tsx",
  "src/components/employee-360/crm-insights-sections.tsx",
  "src/components/employee-360/incentive-section.tsx",
  ...PAGES,
  "app/(admin)/employee-360/page.tsx",
];

// Owner, 2026-10-27: a premium polish of Employee 360 in both portals. Three things it pins:
// a section whose read fails is named on the page (never silently missing), the rep's own report
// carries the Phoenix CRM sections like every other report, and the look is flat and square —
// no glow, no hover lift, no gradient avatar, no rounded corner. The cards keep their depth.
export function runEmployee360PolishTests() {
  for (const page of PAGES) {
    const source = read(page);
    assert.match(source, /const unreadSections: string\[\] = \[\];/, `${page} collects the sections it could not read`);
    for (const name of ["Team Development", "Team Compliance", "Training-Manager Effectiveness", "Marketing ROI"]) {
      assert.match(source, new RegExp(`unreadSections\\.push\\("${name}"\\)`), `${page} names ${name} when its read fails`);
    }
    assert.match(source, /unreadSections=\{unreadSections\}/, `${page} hands them to the report`);
    assert.match(source, /crmInsights=\{crmInsights\}/, `${page} hands the Phoenix CRM sections to the report`);
  }

  const view = read("src/components/employee-360/employee-360-view.tsx");
  assert.match(view, /unreadNames\.length > 0 \? <UnreadSectionsNotice names=\{unreadNames\} \/>/, "the report names what it could not read");
  assert.match(view, /Could not be read just now/);
  assert.match(view, /\{r\.typeName \? `\$\{r\.typeName\} · ` : ""\}\{r\.customerName\}/, "a marketing request reads by its type and customer, not its code alone");

  const pm = read("src/lib/employee-360/pm-marketing.ts");
  assert.doesNotMatch(pm, /catch\s*\(/, "a failed Marketing ROI read throws, so the page can name it");

  for (const file of UI) {
    const source = read(file);
    assert.doesNotMatch(source, /(?<![\w.])rounded(?:-|\b)(?!\w*\()/, `${file}: square corners — no rounded class`);
    assert.doesNotMatch(source, /hover:-translate-y|bg-gradient-to|Sparkles|🎯/, `${file}: no hover lift, gradient or ornament`);
    assert.doesNotMatch(source, /shadow-\[0_\d+px_\d+px_rgba\(249,115,22/, `${file}: no orange glow on an active chip`);
    assert.doesNotMatch(source, /\btruncate\b|text-ellipsis|line-clamp|…/, `${file}: never truncated with an ellipsis`);
  }
  // Card depth is the house look (app/globals.css RULE 3) and stays.
  assert.match(view, /const PREMIUM_CARD =/);
  assert.match(view, /shadow-\[0_10px_30px_rgba\(15,23,42,0\.05\)\]/);

  // Owner, 2026-10-27: "a real heavy premium polish to the design, style and idea". The report reads
  // as one personnel record: a masthead with the facts as a ledger, what it could read and its
  // contents; an at-a-glance strip; numbered chapters; every figure grid a hairline ledger — never
  // the grey tiles or tinted icon squares it replaced.
  assert.match(view, /Employee 360 · Personnel record/, "the masthead names what the page is");
  assert.match(view, /aria-label="Contents of this report"/, "the masthead carries the report's contents");
  assert.match(view, /function AtAGlance\(/, "the record opens on its headline figures");
  assert.match(view, /function Chapter\(/, "the sections are grouped into chapters");
  assert.match(view, /number: String\(index \+ 1\)\.padStart\(2, "0"\)/, "the chapters are numbered in the order they appear");
  assert.match(view, /\.filter\(\(chapter\) => chapter\.parts\.length > 0\)/, "a chapter with nothing to show is left out");
  assert.match(view, /const LEDGER_CELL = "border-b border-r border-slate-200 bg-white"/);
  assert.doesNotMatch(view, /BadgeCheck|TONE_ICON_WRAP/, "flat marks, no badge icons or tinted icon squares");
  for (const file of UI) {
    assert.doesNotMatch(read(file), /bg-slate-50\/60/, `${file}: figures sit in a ledger, not grey tiles`);
  }
  // Inside a chapter (the h2), every section heads with an h3 — the Phoenix CRM sections too.
  const crm = read("src/components/employee-360/crm-insights-sections.tsx");
  assert.match(crm, /<h3 className=/, "a Phoenix CRM section heads with an h3");
  assert.doesNotMatch(crm, /<h2\b/, "and never an h2 beside the chapter's own");
  assert.match(read("src/components/employee-360/period-filter.tsx"), /Reporting period/, "the period bar is labelled");

  // One avatar for the same person on the list and on the report, flat.
  const list = read("src/components/employee-360/employee-search-list.tsx");
  for (const [file, source] of [["view", view], ["list", list]] as const) {
    assert.match(source, /from "\.\/avatar"/, `the ${file} uses the shared avatar`);
    assert.doesNotMatch(source, /function initials\(|function avatarTone\(/, `the ${file} has no copy of its own`);
  }
  assert.equal(employeeInitials("Mona  Adel Hassan"), "MA");
  assert.equal(employeeInitials("   "), "—");
  assert.equal(employeeAvatarGround("B-10"), employeeAvatarGround("B-10"), "the same person wears the same ground");
  assert.doesNotMatch(employeeAvatarGround("R-1"), /gradient|from-|to-/);

  // The admin routes show a loading state like every sibling admin page.
  for (const path of ["app/(admin)/employee-360/loading.tsx", "app/(admin)/employee-360/[hrId]/loading.tsx"]) {
    assert.match(read(path), /AppRouteLoadingState/, `${path} exists and shows the loading state`);
  }
  // A link to someone who is not on record never echoes the raw id back.
  for (const page of ["app/(admin)/employee-360/[hrId]/page.tsx", "app/employee-portals/employee-360/[hrId]/page.tsx"]) {
    assert.match(read(page), /No employee record matches this link\./, `${page}: the not-found line names no id`);
  }
}
