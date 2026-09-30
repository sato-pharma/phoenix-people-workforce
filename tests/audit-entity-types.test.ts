import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AUDIT_ENTITY_TYPES } from "../src/lib/admin/audit-entity-types.ts";

/**
 * THE AUDIT LOG PICKER IS DERIVED, NOT REMEMBERED.
 *
 * Owner-authorised 2026-09-30 ("derive the audit log picker from the catalogue"). Before it,
 * `/admin/logs` offered a hand-kept shortlist of ten names while production wrote 88 distinct
 * entity types in 30 days, at ~2,456 audit rows a day — so most trails could be reached only by
 * paging "all", and three of the ten offered had not been written in a month.
 *
 * What this pins is the MECHANISM, not the contents. A count would rot the first time a feature is
 * audited; what must not rot is that the list cannot fall behind the union, that the union cannot
 * gain a name the screen never offers, and that reading the catalogue in the browser does not drag
 * the service-role client along with it.
 */
export function runAuditEntityTypesTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  const CATALOGUE = "src/lib/admin/audit-entity-types.ts";
  const AUDIT = "src/lib/admin/audit.ts";
  const VIEWER = "src/components/admin/audit-log-viewer.tsx";

  // ── THE LIST IS THE UNION, MEMBER FOR MEMBER ─────────────────────────────────────────────────
  //
  // Parsed from the source rather than compared against a number: the union grows whenever a
  // feature is audited, and a test that counted would go red for the right change.
  const auditSource = read(AUDIT);
  const lines = auditSource.split("\n");
  const start = lines.findIndex((line) => line.startsWith("export type AuditEntityType ="));
  assert.ok(start >= 0, `${AUDIT} must still declare the AuditEntityType union.`);
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/;\s*$/.test(lines[index])) { end = index; break; }
  }
  assert.ok(end > start, `${AUDIT}'s AuditEntityType union must terminate.`);

  const union = [...lines.slice(start, end + 1).join("\n").matchAll(/^\s*\|\s*"([a-z][a-z0-9_]*)"\s*;?\s*$/gm)]
    .map((match) => match[1]);
  assert.ok(union.length > 100, `parsed only ${union.length} union members — the parser, not the union, is wrong.`);

  const missing = union.filter((name) => !AUDIT_ENTITY_TYPES.includes(name as (typeof AUDIT_ENTITY_TYPES)[number]));
  assert.deepEqual(
    missing,
    [],
    `AUDIT_ENTITY_TYPES is missing ${missing.length} type(s) the union declares — ` +
      "a trail the code writes that /admin/logs cannot select. Keep the list derived from " +
      "Record<AuditEntityType, true> and the compiler will not let this happen.",
  );
  const invented = AUDIT_ENTITY_TYPES.filter((name) => !union.includes(name));
  assert.deepEqual(invented, [], `AUDIT_ENTITY_TYPES names ${invented.length} type(s) the union does not declare.`);

  // ── THE DRIFT GUARD ITSELF ───────────────────────────────────────────────────────────────────
  //
  // 🔴 The list is derived from an EXHAUSTIVE RECORD on purpose. `permissionResources` is this
  // repo's cautionary tale: a runtime array beside a union, where a name in the union and not the
  // array is treated as permitted for every role, silently. Replacing the record with a plain
  // array here would restore exactly that shape — the assertions above would still pass on the day
  // it was written and rot on the next audited feature.
  const catalogueSource = read(CATALOGUE);
  assert.match(
    catalogueSource,
    /Record<AuditEntityType,\s*true>/,
    `${CATALOGUE} must derive the list from Record<AuditEntityType, true> — that record is the ` +
      "only thing making a missing name a compile error rather than a silent gap.",
  );
  assert.match(
    catalogueSource,
    /Object\.keys\(/,
    `${CATALOGUE} must derive the array from the record's own keys, never write the names twice.`,
  );

  // ── IT STAYS OUT OF THE CLIENT BUNDLE ────────────────────────────────────────────────────────
  //
  // `audit.ts` imports getSupabaseAdmin. A value import here would pull the service-role client
  // into a "use client" component; `import type` is erased, which is the whole reason this module
  // is separate from audit.ts in the first place.
  assert.match(
    catalogueSource,
    /import type \{ AuditEntityType \} from "\.\/audit";/,
    `${CATALOGUE} must import AuditEntityType as a TYPE only — audit.ts is server code.`,
  );
  assert.doesNotMatch(
    catalogueSource,
    /^import \{/m,
    `${CATALOGUE} must not take a value import from anywhere — it ships to the browser.`,
  );

  // ── THE SCREEN READS THE CATALOGUE ───────────────────────────────────────────────────────────
  const viewerSource = read(VIEWER);
  assert.match(
    viewerSource,
    /import \{ AUDIT_ENTITY_TYPES \} from "@\/lib\/admin\/audit-entity-types";/,
    `${VIEWER} must take its entity types from the catalogue.`,
  );
  assert.match(
    viewerSource,
    /const ENTITY_TYPES = \["all", \.\.\.AUDIT_ENTITY_TYPES\];/,
    `${VIEWER} must build the picker as "all" plus the whole catalogue — a literal list here is ` +
      "the defect this change removed, and it comes back as a tidy-looking simplification.",
  );
  assert.match(
    viewerSource,
    /import type \{ AuditLogFilter, AuditLogPage \} from "@\/lib\/admin\/audit";/,
    `${VIEWER} must keep its audit.ts import type-only.`,
  );

  assert.match(
    viewerSource,
    /maxResults=\{ENTITY_TYPES\.length\}/,
    `${VIEWER} must raise SearchableSelect's result cap to the whole list — it defaults to 100 ` +
      "and the catalogue is larger, so without this the tail of the alphabet silently disappears " +
      "from an unsearched list, which is the very defect this change set out to remove.",
  );

  // ── ORDER ────────────────────────────────────────────────────────────────────────────────────
  //
  // Alphabetical, because the select is searchable and any "most used first" order encodes one
  // quarter's volumes. Sorted also makes a duplicate impossible to miss.
  const sorted = [...AUDIT_ENTITY_TYPES].sort();
  assert.deepEqual([...AUDIT_ENTITY_TYPES], sorted, "AUDIT_ENTITY_TYPES must be sorted.");
  assert.equal(new Set(AUDIT_ENTITY_TYPES).size, AUDIT_ENTITY_TYPES.length, "no duplicates.");
}
