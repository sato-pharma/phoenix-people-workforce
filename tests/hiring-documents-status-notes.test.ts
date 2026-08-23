import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveHiringDocumentNotes } from "../src/lib/hiring-documents/status-notes.ts";

// ─────────────────────────────────────────────────────────────────────────────
// `hiring_document_statuses.notes` is a per-document cell, separate from the per-employee HR note.
// Until 2026-08-23 `updateHiringDocumentStatus` wrote `notes: cleanText(input.notes)` on every
// call, and `notes` is optional on that payload — so an omitted key was read as "clear it".
//
// The checklist UI omits it on every single status write: Mark submitted, Mark missing and the
// deadline box all post {documentId, dueDate, employeeHrId, status} and nothing else. So any note
// on that row was blanked by the next click on it. The evidence that this was already biting is in
// the service itself: markHiringDocumentSubmitted exists as a hand-written duplicate of the same
// upsert purely to dodge it, with a comment saying reuse "would blank whatever HR had typed in that
// cell just because a scan arrived".
//
// Two things are pinned: the rule, and the fact that the status writer actually uses it instead of
// going back to writing the raw input.
// ─────────────────────────────────────────────────────────────────────────────

const service = readFileSync(
  new URL("../src/lib/hiring-documents/service.ts", import.meta.url),
  "utf8",
);

/** The body of a top-level `export async function <name>`, bounded by its OWN closing brace. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the hiring documents service`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest : rest.slice(0, end);
}

function occurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

export function runHiringDocumentsStatusNotesTests() {
  // ── An absent key leaves the cell alone ───────────────────────────────────
  // This is the whole defect. Every one of these was previously null.
  assert.equal(
    resolveHiringDocumentNotes("Chased twice, promised Sunday", undefined),
    "Chased twice, promised Sunday",
    "a status write that carries no notes key must keep the note that is there",
  );
  assert.equal(
    resolveHiringDocumentNotes("  padded note  ", undefined),
    "padded note",
    "a preserved note is still normalized",
  );
  assert.equal(
    resolveHiringDocumentNotes(null, undefined),
    null,
    "no previous note and no incoming key stays empty",
  );
  assert.equal(
    resolveHiringDocumentNotes(undefined, undefined),
    null,
    "a brand new row with no notes key starts empty",
  );

  // ── A key that IS present still decides ───────────────────────────────────
  // The guard drops accidental clears, never a deliberate one.
  assert.equal(
    resolveHiringDocumentNotes("Chased twice", null),
    null,
    "an explicit null clears the note",
  );
  assert.equal(
    resolveHiringDocumentNotes("Chased twice", ""),
    null,
    "an explicit empty string clears the note",
  );
  assert.equal(
    resolveHiringDocumentNotes("Chased twice", "   "),
    null,
    "whitespace is a clear, not a note",
  );
  assert.equal(
    resolveHiringDocumentNotes("Chased twice", "Received today"),
    "Received today",
    "a real note replaces the old one",
  );
  assert.equal(
    resolveHiringDocumentNotes(null, "  First note  "),
    "First note",
    "a first note is trimmed and kept",
  );

  // ── The status writer must actually use the rule ──────────────────────────
  const status = functionBody(service, "updateHiringDocumentStatus");

  assert.equal(
    occurrences(status, /notes: cleanText\(input\.notes\)/g),
    0,
    "updateHiringDocumentStatus must never write notes straight from its input - that is the wipe",
  );
  assert.match(
    status,
    /const nextNotes = resolveHiringDocumentNotes\(before\?\.notes, input\.notes\)/,
    "updateHiringDocumentStatus must resolve notes against the row it just read",
  );
  assert.match(
    status,
    /^\s*notes: nextNotes,$/m,
    "the upsert must write the resolved note, not the raw input",
  );

  // The audit row has to report what was actually written. If the upsert preserves a note but the
  // audit says null, the log becomes the lie the audit work was done to remove.
  const audited = status.slice(status.indexOf("writeRequiredAuditLog"));
  assert.match(
    audited,
    /newValues: \{ dueDate, notes: nextNotes, status: input\.status \}/,
    "the audit row must report the resolved note, not the raw input",
  );

  assert.match(
    service,
    /import \{ resolveHiringDocumentNotes \} from "@\/lib\/hiring-documents\/status-notes"/,
    "the service must import the shared rule rather than re-implementing it inline",
  );

  // The employee-level notes writer is a different thing and must NOT adopt this rule: its whole
  // purpose is to set the note the user just typed, and its UI always sends the field.
  const employeeNotes = functionBody(service, "updateHiringDocumentEmployeeNotes");
  assert.match(
    employeeNotes,
    /const nextNotes = cleanText\(input\.notes\)/,
    "the employee notes writer must keep writing exactly what it was given",
  );
}
