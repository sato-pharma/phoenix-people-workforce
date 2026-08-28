import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { splitInsertOnly } from "../src/lib/imports/org-entity-write-guard.ts";

// Recurrence guard: an employee import must never resurrect a deactivated team.
//
// The trap is an asymmetry between two lookups over the same table. loadTeamState() omits
// is_active=false rows when it builds the "already exists" set — deliberately, so a deactivated
// team cannot win a name resolution and pull employees back onto a retired seat. But the write path
// looks the code up directly and DOES find that row. So the importer believed the team was absent,
// found it anyway, and UPDATEd it with is_active: true — silently reviving a team somebody had
// deactivated on purpose and overwriting its curated name and area on the way.
//
// Measured against production 2026-08-28 at ~11:30 Cairo: exactly 2 of 120 teams sat in that gap, and
// both were deactivated (the two "Delta (1)" rows, while Delta (3) was going live). A sheet naming
// Area "Kafr El-Sheikh (1)" + Team "Delta (1)" resolved to that row's exact code, so the revival was
// reachable from an ordinary upload — not theoretical.
//
// Re-measured at ~12:15 Cairo the same day: 57 of 120. The fixture below keeps the original Delta (1)
// row because that is the case that was proven reachable, but do not read "2" as this guard's value —
// the 37 rows that flipped in between were the importer's own junk teams being cleaned up by hand, and
// the next upload would have reactivated all of them. Full account: org-entity-write-guard.ts.
//
// Two halves, and BOTH are needed. The behavioural half pins the rule; the source half pins that the
// route still routes through it, because the rule is worthless if upsertTeams stops calling it.

const routeSource = readFileSync(
  fileURLToPath(new URL("../app/api/imports/employees/confirm/route.ts", import.meta.url)),
  "utf8",
);

/**
 * The body of one top-level `async function <name>(` in the route source.
 *
 * Anchored on the function name and cut at the next top-level function, NOT sliced at a fixed byte
 * offset — a byte window false-FAILS the moment anything above it grows, which is how source-pinning
 * tests in this repo have broken before.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `route source must still declare async function ${name}(`);
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:async function|function) [A-Za-z]/);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

export async function runEmployeeImportTeamResurrectionGuardTests() {
  // ── Headline: an entity whose row already exists is NEVER written ──
  //
  // This is the whole rule. The deactivated team is the case that matters: its code IS in the row
  // lookup (that is why the old code found it) even though the resolvable set reports it absent.
  const deactivatedTeam = { code: "kafr_el_sheikh_1_delta_1", name: "Delta (1)" };
  const brandNewTeam = { code: "delta_3_anti_infective", name: "Delta (3)" };

  const rowsThatExist = new Set([deactivatedTeam.code]); // what a lookup by code really returns
  const split = splitInsertOnly([deactivatedTeam, brandNewTeam], (code) => rowsThatExist.has(code));

  assert.deepEqual(
    split.toInsert.map((entity) => entity.code),
    [brandNewTeam.code],
    "only the team with no row may be inserted — a deactivated team must never reach the write path",
  );
  assert.deepEqual(
    split.preserved.map((entity) => entity.code),
    [deactivatedTeam.code],
    "the deactivated team must be reported as preserved, not silently skipped",
  );

  // Every entity is accounted for exactly once — nothing may be dropped on the floor.
  assert.equal(
    split.toInsert.length + split.preserved.length,
    2,
    "every entity must land in exactly one of toInsert / preserved",
  );

  // An empty existing-set means everything is new; a full one means nothing is written at all.
  assert.equal(splitInsertOnly([deactivatedTeam, brandNewTeam], () => false).preserved.length, 0);
  assert.equal(splitInsertOnly([deactivatedTeam, brandNewTeam], () => true).toInsert.length, 0);

  // ── The route still routes through the rule ──
  const upsertTeamsBody = functionBody(routeSource, "upsertTeams");

  assert.ok(
    upsertTeamsBody.includes("splitInsertOnly("),
    "upsertTeams must delegate the insert-vs-preserve decision to splitInsertOnly()",
  );
  assert.ok(
    !upsertTeamsBody.includes(".update("),
    "upsertTeams must not UPDATE an existing team row — that is the resurrection path",
  );
  assert.ok(
    !upsertTeamsBody.includes(".upsert("),
    "upsertTeams must not upsert either — onConflict would overwrite the same curated columns",
  );

  // is_active may only ever be set on a fresh INSERT. If the word appears anywhere near an update or
  // an upsert in this function, the guard has been undone.
  const insertCount = (upsertTeamsBody.match(/\.insert\(/g) ?? []).length;
  assert.equal(
    insertCount,
    1,
    "upsertTeams should write through exactly one INSERT call",
  );

  // ── The three sibling upserts stay insert-only too, by their upstream filter ──
  //
  // These DO call .upsert(..., { onConflict: "code" }), which reads like an overwrite. It is
  // unreachable: collectOrganizationEntities() removes every already-existing code before they are
  // called. Pinning the filter itself, so deleting it cannot quietly re-arm all three at once.
  const validatorSource = readFileSync(
    fileURLToPath(new URL("../src/lib/imports/employee-validator.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /if \(exists\?\.has\(entity\.code\)\) \{\s*return;/.test(validatorSource),
    "collectOrganizationEntities must keep dropping entities whose code already exists — it is the only thing making the departments/lines/positions upserts insert-only",
  );
}
