import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * TERRITORY SYNC PANEL: NAMES NOT IDS, AND CROSS-LINE RECONCILIATION STAYS WITH THE ROLES THAT
 * ALREADY SEE EVERY LINE.
 *
 * WHY THIS EXISTS. The panel rendered `status.lastSyncedBy` straight from the audit log's
 * `actor_login_id` — a raw login or HR id on screen, which breaks the owner's standing rule to
 * show names, never codes or IDs. Separately, the panel's per-line reconciliation chips summed
 * `report.reconciliation` across EVERY line the sync touched (CNS, Pedia, Anti Infective, …) and
 * rendered them to any Territory Drilldown viewer — a Medical Rep included, who on every other
 * surface of this page sees only their own line. The panel's own doc comment also still claimed
 * `canRun` was false on the manager-facing drilldown page, when the page has passed it
 * unconditionally (by owner decision — the sync is corrective and idempotent) since before this
 * fix; a stale comment like that is exactly what lets a real gap go unnoticed.
 *
 * Fixed by: resolving the actor to a display name server-side (sync.ts's
 * `resolveSyncActorDisplayName`, never the raw id) and gating the reconciliation chips behind a
 * `showReconciliation` prop that the page derives from `isTerritoryLinePickerRole` — the same
 * Super Admin / CEO set that already gets the nationwide line picker. `canRun` stays unconditional:
 * every Territory Drilldown role may still press Sync.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The body of a top-level function, up to the next top-level declaration. Line-based on purpose:
 *  a fixed byte window false-fails as soon as anything above it shifts. */
function functionBody(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const declaration = /^(export )?(async )?function [A-Za-z0-9_]+/;
  const start = lines.findIndex((line) => new RegExp(`^(export )?(async )?function ${name}\\b`).test(line));
  assert.notEqual(start, -1, `${name} must exist`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (declaration.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function runTerritorySyncPanelRoleScopingTests() {
  const syncSource = readSource("../src/lib/sales/territory/sync.ts");
  const panelSource = readSource("../src/components/sales/territory/territory-sync-panel.tsx");
  const pageSource = readSource("../app/employee-portals/territory-drilldown/page.tsx");

  // --- sync.ts: the actor is resolved to a name, never handed through raw --------------------

  const status = functionBody(syncSource, "getTerritorySyncStatus");
  assert.match(
    status,
    /lastSyncedBy:\s*await resolveSyncActorDisplayName\(/,
    "getTerritorySyncStatus must resolve lastSyncedBy through resolveSyncActorDisplayName, never row.actor_login_id directly — a raw login/HR id is never shown in the UI",
  );
  assert.doesNotMatch(
    status,
    /lastSyncedBy:\s*row\.actor_login_id/,
    "the raw actor_login_id must not reach TerritorySyncStatus.lastSyncedBy",
  );

  const resolver = functionBody(syncSource, "resolveSyncActorDisplayName");
  assert.match(
    resolver,
    /startsWith\(["']system:["']\)/,
    "the scheduled sync's system: actor must be named explicitly, not looked up as if it were an employee",
  );
  assert.match(
    resolver,
    /return ["']a colleague["'];?\s*$/m,
    "an unresolvable actor must fall back to a human phrase, not silently disappear or fall through to the id",
  );
  assert.doesNotMatch(
    resolver,
    /return loginId;/,
    "resolveSyncActorDisplayName must never return the raw login id it was given",
  );

  // --- territory-sync-panel.tsx: reconciliation chips are role-gated, not report-gated --------

  assert.match(
    panelSource,
    /export function TerritorySyncPanel\(\{\s*canRun,\s*showReconciliation\s*\}:\s*\{\s*canRun:\s*boolean;\s*showReconciliation:\s*boolean;?\s*\}\)/,
    "TerritorySyncPanel must accept a showReconciliation prop alongside canRun",
  );

  const chipsBlockStart = panelSource.indexOf("lineSummaries.map");
  assert.notEqual(chipsBlockStart, -1, "the per-line reconciliation chips (summarizeByLine output) must still exist");
  const beforeChips = panelSource.slice(0, chipsBlockStart);
  const guardIndex = beforeChips.lastIndexOf("showReconciliation &&");
  assert.ok(
    guardIndex !== -1 && guardIndex > beforeChips.lastIndexOf("{report && ("),
    "the reconciliation chips must be gated behind `showReconciliation &&`, nested inside the `report &&` block — not rendered to every viewer who has a report",
  );

  // The comment that once claimed canRun was false on the drilldown page is gone — both the sync
  // route (assertSyncOperator) and the page keep every Territory Drilldown role able to press Sync.
  assert.doesNotMatch(
    panelSource,
    /drilldown page `canRun` is false/,
    "the panel's doc comment must not claim the drilldown page disables the button — it has passed canRun unconditionally since the owner's decision to open Sync to every drilldown role",
  );

  // --- page.tsx: canRun stays unconditional, showReconciliation is role-derived ---------------

  assert.match(
    pageSource,
    /<TerritorySyncPanel\s+canRun\s+showReconciliation=\{isTerritoryLinePickerRole\(access\.role\)\}\s*\/>/,
    "the drilldown page must pass canRun unconditionally (every drilldown role may sync) and derive showReconciliation from isTerritoryLinePickerRole — never hardcode it true or false",
  );
}
