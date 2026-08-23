import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  readAttendanceExceptionNotes,
  resolveAttendanceExceptionNotesPatch,
} from "../src/lib/attendance/exception-notes.ts";

// ─────────────────────────────────────────────────────────────────────────────
// `attendance_exceptions.notes` has two authors. The employee (or an admin filing for them) writes
// it when raising the dispute; the reviewer may add to it when approving or rejecting. One column.
//
// Until 2026-08-23 the review path erased the first author's text on every decision:
//   - the manager posted `notes: reviewNotes[id] ?? null`, so an untouched box sent explicit null;
//   - the route flattened that to `notes: typeof notes === "string" ? notes : null`;
//   - the service wrote `notes: input.notes ?? null` unconditionally onto the existing row.
// Approving without typing anything therefore blanked the requester's note — the note the table
// renders directly above the review box.
//
// Three things are pinned here: the rule, the fact that the service spreads it rather than writing
// a plain `notes:` key, and the fact that the review UI omits the key when the box is empty.
// ─────────────────────────────────────────────────────────────────────────────

const service = readFileSync(
  new URL("../src/lib/attendance/exceptions.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../app/api/attendance/exceptions/[id]/route.ts", import.meta.url),
  "utf8",
);
const manager = readFileSync(
  new URL("../src/components/attendance/attendance-exceptions-manager.tsx", import.meta.url),
  "utf8",
);

/** The body of a top-level `export async function <name>`, bounded by its OWN closing brace. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest : rest.slice(0, end);
}

export function runAttendanceExceptionNotesTests() {
  // ── An absent note leaves the column out of the update entirely ───────────
  // This is the whole defect. Omitting beats writing a before-image back: there is no read, so no
  // race with a concurrent edit and nothing to get stale.
  assert.deepEqual(
    resolveAttendanceExceptionNotesPatch(undefined),
    {},
    "a review that carries no notes key must not write the notes column at all",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(resolveAttendanceExceptionNotesPatch(undefined), "notes"),
    false,
    "the absent case must omit the key, not set it to undefined — a present key still overwrites",
  );

  // ── An explicit value still writes ────────────────────────────────────────
  assert.deepEqual(
    resolveAttendanceExceptionNotesPatch("Approved, fingerprint device was down that morning"),
    { notes: "Approved, fingerprint device was down that morning" },
    "a reviewer who types a note must have it stored",
  );
  assert.deepEqual(
    resolveAttendanceExceptionNotesPatch("  padded  "),
    { notes: "padded" },
    "a stored note is trimmed",
  );
  assert.deepEqual(
    resolveAttendanceExceptionNotesPatch(null),
    { notes: null },
    "an explicit null is a deliberate clear and must still clear",
  );
  assert.deepEqual(
    resolveAttendanceExceptionNotesPatch("   "),
    { notes: null },
    "a whitespace-only note is a clear, not a note made of spaces",
  );

  // ── The route keeps absent and null apart ─────────────────────────────────
  assert.equal(
    readAttendanceExceptionNotes({ decision: "approved" }),
    undefined,
    "a body with no notes key must reach the service as undefined, never as null",
  );
  assert.equal(
    readAttendanceExceptionNotes({ decision: "approved", notes: null }),
    null,
    "an explicit null in the body must survive as a clear",
  );
  assert.equal(
    readAttendanceExceptionNotes({ decision: "approved", notes: "device outage" }),
    "device outage",
    "a string in the body must survive",
  );
  assert.equal(
    readAttendanceExceptionNotes({ decision: "approved", notes: 42 }),
    null,
    "a non-string, non-absent notes value is treated as a clear rather than written raw",
  );

  // ── The service must actually use the rule ────────────────────────────────
  const review = functionBody(service, "reviewAttendanceException");
  assert.match(
    review,
    /\.\.\.resolveAttendanceExceptionNotesPatch\(input\.notes\)/,
    "reviewAttendanceException must SPREAD the resolved patch so an absent note omits the column",
  );
  assert.doesNotMatch(
    review,
    /\n\s*notes:\s/,
    "reviewAttendanceException must not carry a plain notes key — that writes the column every call",
  );

  // ── The route must not flatten absent into null ───────────────────────────
  assert.doesNotMatch(
    route,
    /typeof notes === "string" \? notes : null/,
    "the old coercion turned every body without a notes key into an explicit clear",
  );
  assert.match(
    route,
    /readAttendanceExceptionNotes\(payload as Record<string, unknown>\)/,
    "the PATCH route must read notes through the helper that preserves the absent case",
  );

  // ── The review UI must omit the key when the box is empty ─────────────────
  assert.doesNotMatch(
    manager,
    /notes:\s*reviewNotes\[id\]\s*\?\?\s*null/,
    "the review UI must not post an empty box as an explicit null",
  );
  assert.match(
    manager,
    /JSON\.stringify\(reviewNote \? \{ decision, notes: reviewNote \} : \{ decision \}\)/,
    "an untouched review box must send no notes key at all",
  );

  // ── The create path is deliberately untouched ─────────────────────────────
  // saveAttendanceException is a create-or-replace of the dispute itself: the filer's payload IS
  // the whole record, so writing notes unconditionally there is correct, not the same bug.
  const save = functionBody(service, "saveAttendanceException");
  assert.match(
    save,
    /notes: input\.notes \?\? null/,
    "saveAttendanceException still fully states the record it creates — do not 'fix' it to match",
  );
}
