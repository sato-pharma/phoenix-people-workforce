import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  hiringDeadlineChanged,
  normalizeHiringDeadline,
} from "../src/lib/hiring-documents/deadline.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The deadline field on a missing hiring document saves on blur, because a date picker has no
// natural "done" button. Until 2026-08-23 it saved on EVERY blur: tabbing across a row, or opening
// the picker and closing it unchanged, fired a PATCH that rewrote a real production row and moved
// its updated_at. Hiring document writes produce no audit row, so afterwards there is no way to
// tell one of those from a deliberate change — which is exactly how a stray write on B-106 became
// unprovable.
//
// Two things are pinned here: the rule itself, and the fact that every deadline input in the
// manager actually goes through it. The manager renders the same row twice (desktop table and
// mobile card), so a guard added to only one of them is the likeliest way this regresses.
// ─────────────────────────────────────────────────────────────────────────────

const managerSource = readFileSync(
  new URL("../src/components/hiring-documents/hiring-documents-manager.tsx", import.meta.url),
  "utf8",
);

function occurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

export function runHiringDocumentsDeadlineTests() {
  // ── The two spellings of "no deadline" are one value ──────────────────────
  // An empty <input type="date"> reads "", the payload and the column use null. Treating those as
  // different would reinstate the spurious write on every blur of an empty field.
  assert.equal(normalizeHiringDeadline(""), null, "an empty date box means no deadline");
  assert.equal(normalizeHiringDeadline("   "), null, "whitespace means no deadline");
  assert.equal(normalizeHiringDeadline(null), null, "null means no deadline");
  assert.equal(normalizeHiringDeadline(undefined), null, "undefined means no deadline");
  assert.equal(normalizeHiringDeadline("2026-01-15"), "2026-01-15", "a real date survives intact");
  assert.equal(normalizeHiringDeadline(" 2026-01-15 "), "2026-01-15", "a padded date is trimmed");

  // ── Blurring without editing must not write ───────────────────────────────
  assert.equal(
    hiringDeadlineChanged("2026-01-15", "2026-01-15"),
    false,
    "tabbing through an unchanged deadline is not an edit",
  );
  assert.equal(hiringDeadlineChanged("", ""), false, "tabbing through an empty deadline is not an edit");
  assert.equal(hiringDeadlineChanged(null, ""), false, "null and an empty box are the same absence");
  assert.equal(hiringDeadlineChanged("", null), false, "an empty box and null are the same absence");
  assert.equal(hiringDeadlineChanged(undefined, ""), false, "an unset deadline and an empty box agree");
  assert.equal(hiringDeadlineChanged("   ", null), false, "whitespace is still absence, not a change");
  assert.equal(
    hiringDeadlineChanged(" 2026-01-15 ", "2026-01-15"),
    false,
    "padding alone is not an edit",
  );

  // ── A genuine edit must still write ───────────────────────────────────────
  // The guard exists to drop no-op writes, never to swallow a real one.
  assert.equal(
    hiringDeadlineChanged("2026-01-15", "2026-02-01"),
    true,
    "moving a deadline is an edit",
  );
  assert.equal(hiringDeadlineChanged("", "2026-02-01"), true, "setting a first deadline is an edit");
  assert.equal(hiringDeadlineChanged(null, "2026-02-01"), true, "setting a deadline from null is an edit");
  assert.equal(hiringDeadlineChanged("2026-02-01", ""), true, "clearing a deadline is an edit");
  assert.equal(hiringDeadlineChanged("2026-02-01", null), true, "clearing a deadline to null is an edit");

  // ── Every deadline input in the manager is wired to the guard ─────────────
  // The unguarded one-liner is what shipped; it must not come back.
  assert.equal(
    occurrences(managerSource, /onBlur=\{\(event\) => void updateDocumentStatus\(/g),
    0,
    "a deadline blur must never call updateDocumentStatus directly - it writes on every tab-through",
  );

  // The deadline input is the only one bound to `dueDate`, so its count is the number of renders
  // that need a guard. Tying the two together means a third copy (another responsive variant, say)
  // cannot ship unguarded.
  const deadlineInputs = occurrences(managerSource, /value=\{dueDate\}/g);
  // The desktop table and the phone card draw the same `renderDocumentRow`, so there is exactly one
  // deadline input to guard — a second copy would be a layout that forked the row again.
  assert.equal(deadlineInputs, 1, "expected the desktop table and the phone card to share ONE deadline input");
  assert.equal(
    occurrences(managerSource, /renderDocumentRow\(employee, document\)/g),
    2,
    "both the desktop table and the phone card must draw the shared document row",
  );
  assert.equal(
    occurrences(managerSource, /hiringDeadlineChanged\(previous, event\.target\.value\)/g),
    deadlineInputs,
    "every deadline input must compare against its focus value before writing",
  );
  assert.equal(
    occurrences(managerSource, /deadlineOnFocusRef\.current = event\.target\.value/g),
    deadlineInputs,
    "every deadline input must record the value it held on focus",
  );
  assert.match(
    managerSource,
    /import \{ hiringDeadlineChanged, normalizeHiringDeadline \} from "@\/lib\/hiring-documents\/deadline"/,
    "the manager must import the shared deadline rule rather than re-implementing it inline",
  );
}
