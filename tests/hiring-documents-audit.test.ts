import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/**
 * The body of a top-level `export async function <name>`, bounded by its OWN closing brace.
 *
 * Bounding on the next `export` instead - as tests/payroll-mutation-audit.test.ts does - silently
 * swallows every private helper below the LAST exported function. This file keeps
 * markHiringDocumentSubmitted down there and it calls .update(, so the read-only download function
 * read as a seventh unaudited writer. Closing braces sit in column 0 throughout this codebase.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the hiring documents service`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every top-level exported async function in a source file, in declaration order. */
function exportedAsyncFunctions(source: string): string[] {
  return [...source.matchAll(/\nexport async function (\w+)\(/g)].map((m) => m[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Production evidence for why this test exists (queried 2026-08-23 against ozucdzovmcqvepbozvqf):
// `select ... from audit_logs where entity_type ilike '%hiring%' or ilike '%document%'` returned
// ZERO rows — not a stale count, none had ever been written. Meanwhile the module held 10 document
// definitions (newest edited 2026-08-22), 8 statuses and 1 employee note, and the wider log took
// 109,171 rows in the same 30 days, 338 of them from vacations alone.
//
// So the entire hiring-document checklist could be rewritten, and a filed certificate deleted out
// of a private bucket, with no record of who did it. The note row was the sharpest case: a stray
// write on B-106 left it empty, and there was no way afterwards to prove what it had said.
// ─────────────────────────────────────────────────────────────────────────────

const WRITERS = [
  { entityType: "hiring_document_definition", fn: "createHiringDocumentDefinition" },
  { entityType: "hiring_document_definition", fn: "deleteHiringDocumentDefinition" },
  { entityType: "hiring_document_status", fn: "updateHiringDocumentStatus" },
  { entityType: "hiring_document_note", fn: "updateHiringDocumentEmployeeNotes" },
  { entityType: "hiring_document_file", fn: "attachHiringDocumentFiles" },
  { entityType: "hiring_document_file", fn: "removeHiringDocumentFile" },
];

export function runHiringDocumentsAuditTests() {
  const service = readSource("../src/lib/hiring-documents/service.ts");
  const audit = readSource("../src/lib/admin/audit.ts");

  // ── Every writer records a REQUIRED audit row ─────────────────────────────
  // writeRequiredAuditLog, not writeAuditLog: the latter swallows a persistence failure, which
  // would leave exactly the silent hole this change exists to close.
  for (const { entityType, fn } of WRITERS) {
    const body = functionBody(service, fn);
    assert.ok(
      body.includes("await writeRequiredAuditLog({"),
      `${fn} must write a REQUIRED audit row — a hiring-document mutation must name its actor`,
    );
    assert.ok(
      body.includes(`entityType: "${entityType}"`),
      `${fn} must record its audit row against entityType "${entityType}"`,
    );
    assert.ok(
      body.includes("actorLoginId: hiringAuditActor(access)"),
      `${fn} must resolve its actor the same way every other audited service does`,
    );
  }

  // ── No writer can be added later without one ──────────────────────────────
  // The invariant, not the list: anything exported from this service that mutates a table has to
  // audit. Six functions is today's answer; a seventh must not be able to ship silently.
  const mutators = exportedAsyncFunctions(service).filter((name) => {
    const body = functionBody(service, name);
    return /\.(insert|upsert|delete)\(/.test(body) || /\.update\(\{/.test(body);
  });
  assert.deepEqual(
    mutators.slice().sort(),
    WRITERS.map((w) => w.fn).slice().sort(),
    "an exported hiring-documents function mutates a table but is not in the audited list",
  );

  // ── The before-image must be read BEFORE the mutation ─────────────────────
  // Ordering is the whole value for these three. An upsert overwrites, a soft delete hides the
  // name from every later read, and a file delete destroys the row — a before-image read placed
  // after any of them records nothing about what was there.
  const notes = functionBody(service, "updateHiringDocumentEmployeeNotes");
  assert.ok(
    notes.indexOf("const previousNotes") < notes.indexOf(".upsert("),
    "updateHiringDocumentEmployeeNotes must read the old note BEFORE overwriting it",
  );

  const status = functionBody(service, "updateHiringDocumentStatus");
  assert.ok(
    status.indexOf("const before =") < status.indexOf(".upsert("),
    "updateHiringDocumentStatus must read the old status BEFORE overwriting it",
  );

  const removed = functionBody(service, "deleteHiringDocumentDefinition");
  assert.ok(
    removed.indexOf("const before =") < removed.indexOf(".update({"),
    "deleteHiringDocumentDefinition must read the name BEFORE retiring the definition",
  );

  // A deleted file is unrecoverable — the row goes and the object goes with it — so the audit row
  // is the only surviving trace. It has to carry what was destroyed, not just that something was.
  const removeFile = functionBody(service, "removeHiringDocumentFile");
  for (const field of ["fileName: row.file_name", "storagePath: row.storage_path"]) {
    assert.ok(
      removeFile.includes(field),
      `removeHiringDocumentFile must record ${field} — the file itself is gone afterwards`,
    );
  }

  // ── The entity types are declared ─────────────────────────────────────────
  for (const entityType of new Set(WRITERS.map((w) => w.entityType))) {
    assert.ok(
      audit.includes(`| "${entityType}"`),
      `AuditEntityType must declare "${entityType}" or the audit row will not typecheck`,
    );
  }

  // ── Every route hands the acting user down ────────────────────────────────
  // The service can only name an actor the route gives it; a call that forgot would compile only
  // if the parameter were optional, which is exactly why it is not.
  const routes = [
    { calls: ["updateHiringDocumentStatus(access,", "updateHiringDocumentEmployeeNotes(access,"], rel: "../app/api/hiring-documents/route.ts" },
    { calls: ["createHiringDocumentDefinition(access,"], rel: "../app/api/hiring-documents/definitions/route.ts" },
    { calls: ["deleteHiringDocumentDefinition(access,"], rel: "../app/api/hiring-documents/definitions/[id]/route.ts" },
  ];
  for (const route of routes) {
    const source = readSource(route.rel);
    for (const call of route.calls) {
      assert.ok(source.includes(call), `${route.rel} must pass the acting user into ${call}`);
    }
  }
}
