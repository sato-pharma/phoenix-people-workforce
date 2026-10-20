// Pins the Recruitment workspace's HIDE filters and the 20 Oct 2026 sweep of the page.
//
// Why each case matters:
//   * The owner, 20 Oct 2026: "a filter to exclude, for example, exclude shortlisted, exclude rejected".
//     Status, source and call result each hold a KEEP list and a HIDE list. A value in both would ask
//     the database for nothing at all, so a press always moves the value out of the other list, and a
//     hand-edited link that names it twice keeps it (the narrower reading never wins silently).
//   * Hiding is decided in the DATABASE (`ats_workspace_filter`), like every other filter: a hide that
//     never reaches `p` hides nothing however the screen looks. And the status tiles' counts must hold
//     still while a status is hidden, or the tile he would press to un-hide reads 0.
//   * The decided toggle lights no press while a status is hidden: "All" beside a hidden Shortlisted
//     would claim every status is shown.
//   * The Folders tab sends no tab, so without a folder it used to read the WHOLE pool — every CV in
//     every tab under "Folders". It now lists only what is filed, and with no folder at all, nothing.
//   * The sweep's fixes are behaviour in client components the suite cannot render, so their load-
//     bearing lines are pinned by source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  activeFilterCount,
  decisionModeOf,
  emptyWorkspaceFilters,
  keepOrHideOf,
  parseWorkspaceFilters,
  pressHide,
  pressKeep,
  serializeWorkspaceFilters,
  statusesForDecisionMode,
  workspaceDbParams,
  type WorkspaceFilters,
} from "../src/lib/recruitment/workspace/filters.ts";
import { workspaceExportFilterLine } from "../src/lib/recruitment/workspace/export-workbook.ts";
import { workspaceViewer } from "../src/lib/recruitment/workspace/role-tabs.ts";

const FOLDER_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runRecruitmentWorkspaceExcludeFiltersTests() {
  const hr = workspaceViewer({ role: "HR Manager", scope: "system" } as unknown as Parameters<typeof workspaceViewer>[0]);

  // ── 1 · The URL carries what is hidden, and nothing when nothing is ──
  const hiding: WorkspaceFilters = {
    ...emptyWorkspaceFilters(),
    excludeCallResults: ["no_answer"],
    excludeSources: ["email"],
    excludeStatuses: ["shortlisted", "rejected"],
    tab: "medical_rep",
  };
  const query = serializeWorkspaceFilters(hiding);
  assert.equal(query.get("notStatus"), "shortlisted,rejected");
  assert.equal(query.get("notSource"), "email");
  assert.equal(query.get("notCall"), "no_answer");
  assert.deepEqual(parseWorkspaceFilters(new URLSearchParams(query.toString())), hiding, "every hide survives the URL");
  assert.equal(serializeWorkspaceFilters(emptyWorkspaceFilters()).toString(), "", "a clean visit still has no query");
  assert.equal(activeFilterCount(hiding), 3, "each hidden kind is one filter in Clear all (n)");

  // Malformed values are dropped; a value both kept and hidden is kept.
  const junk = parseWorkspaceFilters(new URLSearchParams("status=shortlisted&notStatus=shortlisted,deleted,rejected&notSource=fax,whatsapp&notCall=maybe,call_back"));
  assert.deepEqual(junk.statuses, ["shortlisted"]);
  assert.deepEqual(junk.excludeStatuses, ["rejected"], "an unknown status is dropped, and a kept one is never also hidden");
  assert.deepEqual(junk.excludeSources, ["whatsapp"]);
  assert.deepEqual(junk.excludeCallResults, ["call_back"]);

  // ── 2 · It reaches the database filter as its own keys ──
  const p = workspaceDbParams(hiding, hr);
  assert.deepEqual(p.exclude_statuses, ["shortlisted", "rejected"], "RED: a hide that never reaches p hides nothing");
  assert.deepEqual(p.exclude_sources, ["email"]);
  assert.deepEqual(p.exclude_call_results, ["no_answer"]);
  assert.equal("statuses" in p, false);
  const clean = workspaceDbParams(emptyWorkspaceFilters(), hr);
  assert.equal("exclude_statuses" in clean || "exclude_sources" in clean || "exclude_call_results" in clean, false, "nothing hidden sends nothing");

  // ── 3 · Show only and Hide move a value between the two lists, never into both ──
  assert.deepEqual(pressHide(["shortlisted"], [], "shortlisted"), { hide: ["shortlisted"], keep: [] }, "hiding a kept value un-keeps it");
  assert.deepEqual(pressKeep([], ["rejected"], "rejected"), { hide: [], keep: ["rejected"] }, "keeping a hidden value un-hides it");
  assert.deepEqual(pressHide([], ["rejected"], "rejected"), { hide: [], keep: [] }, "a second press on the eye is any again");
  assert.deepEqual(pressKeep(["new"], [], "new"), { hide: [], keep: [] });
  assert.deepEqual(pressHide(["new"], ["rejected"], "shortlisted"), { hide: ["rejected", "shortlisted"], keep: ["new"] });
  assert.equal(keepOrHideOf(["new"], ["rejected"], "new"), "only");
  assert.equal(keepOrHideOf(["new"], ["rejected"], "rejected"), "hide");
  assert.equal(keepOrHideOf(["new"], ["rejected"], "hired"), "any");

  // ── 4 · The decided toggle lights no press while a status is hidden ──
  assert.equal(decisionModeOf([], ["rejected"]), null, "All would claim every status while Rejected is hidden");
  assert.equal(decisionModeOf([]), "all");
  assert.equal(decisionModeOf(statusesForDecisionMode("decided"), []), "decided");

  // ── 5 · The Excel file says what was hidden ──
  assert.equal(
    workspaceExportFilterLine(hiding, "medical_rep"),
    "Medical Rep · hiding Shortlisted and Rejected · not from Email · latest call not no answer",
  );

  // ── 6 · The Folders tab never lists the whole pool ──
  const folders = { ...emptyWorkspaceFilters(), tab: "folders" as const };
  assert.deepEqual(workspaceDbParams(folders, hr).candidate_ids, [], "RED: no folder and no expansion lists nothing, never every tab");
  const everyFolder = workspaceDbParams(folders, hr, { folderIdsExpanded: [FOLDER_ID] });
  assert.deepEqual(everyFolder.folder_ids, [FOLDER_ID], "every folder's CVs = the folders the caller expanded");
  assert.equal("candidate_ids" in everyFolder, false);
  assert.equal("candidate_ids" in workspaceDbParams({ ...emptyWorkspaceFilters(), tab: "medical_rep" }, hr), false, "a role tab is untouched");
  const rowsDb = source("src/lib/recruitment/workspace/rows-db.ts");
  assert.ok(rowsDb.includes("expandFolderIds(filters.folderIds, filters.tab === FOLDERS_TAB)"), "the Folders tab expands every folder when none is chosen");

  // ── 7 · The migration: hides in the filter, and the status counts ignore them ──
  const sql = source("supabase/migrations/20261020210704_ats_workspace_exclude_filters.sql");
  assert.ok(sql.includes("coalesce(c.status, 'new') <> all(pr.exclude_statuses)"), "a hidden status hides its CVs, a CV with no status reading as New");
  assert.ok(sql.includes("<> all(pr.exclude_sources)"));
  assert.ok(sql.includes("where latest.result = any(pr.exclude_call_results)"), "only the latest call result is hidden on");
  assert.ok(
    sql.includes("ats_workspace_filter(p - 'statuses' - 'exclude_statuses')"),
    "RED: the status tiles must hold still while a status is hidden, or the tile to un-hide it reads 0",
  );

  // ── 8 · The filter bar: the status line is always in view, each tile with both presses ──
  const bar = source("src/components/recruitment/workspace/filter-bar.tsx");
  const statusLine = bar.search(/candidateStatuses\.map\(\(status\) => \(\s*<KeepHideTile/);
  assert.ok(statusLine > 0, "every status is drawn as a show-only-or-hide tile");
  assert.ok(statusLine < bar.indexOf("{expanded ? ("), "the status line sits on the open bar, not in the folded panel");
  assert.ok(bar.includes("set({ statuses: statusesForDecisionMode(mode), excludeStatuses: [] })"), "a decided press clears the hidden statuses");
  assert.ok(bar.includes('className={recruitmentStackedToolbarClassName}'), "the tray is the kit's, not a one-off");

  // ── 9 · The sweep's fixes, by source ──
  const shell = source("src/components/recruitment/workspace/role-workspace.tsx");
  assert.ok(shell.includes("rows: actionRows,"), "decisions on a CV opened off the list patch the opened copy too");
  assert.ok(shell.includes('return type !== "checkbox" && type !== "radio";'), "a row's tick box does not swallow the shortcuts");
  assert.ok(
    shell.includes('key === "s" && openedRow.status !== "hired" && openedRow.status !== "shortlisted"'),
    "S on a shortlisted CV does not re-write the status and restart its overdue clock",
  );
  assert.ok(shell.includes("onShow={() => apply(filtersRef.current, { reload: true })}"), "the new-CVs bar refreshes the counts too");
  assert.ok(shell.includes("since={newest ?? loadedAt}"), "an empty list still asks for new CVs");
  assert.ok(shell.includes("rows.state.error ? null : ("), "a failed read never says 'nothing here'");
  const toasts = source("src/components/recruitment/workspace/undo-toast.tsx");
  assert.ok(toasts.includes("setEntries((current) => [...current, entry]);"), "a fifth decision does not cut the first one's Undo short");
  assert.ok(toasts.includes("{entries.slice(-4).map((entry) => ("), "only the newest four toasts are drawn");
  const rows = source("src/components/recruitment/workspace/use-workspace-rows.ts");
  assert.ok(rows.includes('setState({ error: errorText(error, "The CVs could not be loaded."), loading: false, loadingMore: false, nextCursor: null, rows: [] });'), "a failed reload drops the old view's rows");
  const cvActions = source("src/components/recruitment/workspace/cv-actions.tsx");
  assert.ok(cvActions.includes("event.currentTarget.blur();"), "the call result drop-down lets go of focus");

  // ── 10 · The production sweep, 21 Oct 2026: what only a phone and a light page showed ──
  assert.ok(
    shell.includes("const headerActionClassName = `inline-flex") && !shell.includes("border-white/20 bg-white/10 px-3 py-1.5"),
    "RED: Shortcuts and Previous workspace sit on the LIGHT hero, so white text on a white tint is invisible",
  );
  assert.ok(
    bar.includes("flex min-w-0 flex-1 basis-64 flex-wrap") && bar.includes("shrink-0 tabular-nums font-semibold"),
    "RED: on a phone the status tiles keep a whole line, so a count never slides under the eye",
  );
  assert.ok(
    bar.includes("pr-9 text-sm sm:pr-16") && bar.includes('placeholder="Search name, phone, email, CV"'),
    "RED: the search box must show its whole placeholder on a 375px phone, never cut mid-word (measured 217px of 251 at 375px; the 248px wording still clipped on production)",
  );
}
