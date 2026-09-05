import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rotatedLabel } from "../src/lib/share-links/rotated-label.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE LABEL A ROTATED SHARE LINK INHERITS.
//
// Three reports rotate their feed token weekly and unattended: direct orders, marketing requests,
// and the CV lifecycle sheet. Each rotation copied the previous label and appended " (rotated)",
// so each one added ten characters to a string that was never reset. By 2026-09-05 the live
// marketing label carried FIVE markers and stood at 134 characters; direct orders had four.
//
// Nothing failed, and that is the point. There is no error to catch here, no exception, no red
// check — just a string in a column a human reads, quietly growing by ten characters a week. The
// test that matters is therefore section 3: rotate a label sixty times, a year of Fridays, and
// assert the length does not move. Run against the OLD code that assertion fails immediately.
// ─────────────────────────────────────────────────────────────────────────────

const CALL_SITES = [
  "../src/lib/direct-orders/sheet-token-rotation.ts",
  "../src/lib/marketing-requests/sheet-token-rotation.ts",
  "../src/lib/recruitment/cv-lifecycle-sheet-token-rotation.ts",
];

/** The two real production labels on 2026-09-05, verbatim, so the fixtures cannot drift polite. */
const LIVE_MARKETING =
  "Owner live Google Sheet feed (all marketing requests, files on) (rotated 2026-08-05) " +
  "(rotated) (rotated) (rotated) (rotated) (rotated)";
const LIVE_DIRECT_ORDERS = "Owner live Google Sheet feed (rotated) (rotated) (rotated) (rotated)";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

export function runShareLinkRotatedLabelTests(): void {
  // ── 1. One marker, however many it started with ─────────────────────────────
  assert.equal(
    rotatedLabel("Owner live Google Sheet feed", "fallback"),
    "Owner live Google Sheet feed (rotated)",
    "a label with no marker gains exactly one",
  );
  assert.equal(
    rotatedLabel(LIVE_DIRECT_ORDERS, "fallback"),
    "Owner live Google Sheet feed (rotated)",
    "four accumulated markers collapse to one",
  );
  assert.equal(
    rotatedLabel(LIVE_MARKETING, "fallback"),
    "Owner live Google Sheet feed (all marketing requests, files on) (rotated 2026-08-05) (rotated)",
    "the human's dated note survives; only the bare markers collapse",
  );

  // ── 2. Idempotent, which is what makes it safe to run weekly ────────────────
  const once = rotatedLabel("Owner live CV lifecycle Google Sheet", "fallback");
  assert.equal(
    rotatedLabel(once, "fallback"),
    once,
    "rotatedLabel(rotatedLabel(x)) must equal rotatedLabel(x) — the label reaches a fixed point",
  );

  // ── 3. THE ONE THAT WOULD HAVE CAUGHT IT: a year of Fridays ────────────────
  //
  // Fifty-two rotations plus a few. Under the old `${old.label} (rotated)` this reaches roughly
  // 640 characters; the assertion below fails on the second iteration, not the sixtieth.
  let label = "Owner live Google Sheet feed";
  const afterFirst = rotatedLabel(label, "fallback");
  for (let week = 0; week < 60; week += 1) label = rotatedLabel(label, "fallback");
  assert.equal(
    label,
    afterFirst,
    "sixty weekly rotations must leave the label byte-identical to the first one",
  );
  assert.ok(label.length < 64, `a rotated label must stay short; got ${label.length} characters`);

  // ── 4. Nothing to inherit falls back, and never to a bare marker ────────────
  assert.equal(rotatedLabel(null, "Rotated feed link"), "Rotated feed link", "null inherits nothing");
  assert.equal(rotatedLabel("", "Rotated feed link"), "Rotated feed link", "empty inherits nothing");
  assert.equal(rotatedLabel("   ", "Rotated feed link"), "Rotated feed link", "blank inherits nothing");
  assert.equal(
    rotatedLabel(42, "Rotated feed link"),
    "Rotated feed link",
    "a non-string from the database inherits nothing rather than stringifying to junk",
  );
  assert.equal(
    rotatedLabel("(rotated) (rotated)", "Rotated feed link"),
    "Rotated feed link",
    "a label that was ONLY markers must fall back, not stand as the bare word",
  );

  // ── 5. The pattern must not regenerate in the three call sites ─────────────
  //
  // Fixing three copies fixes three copies; the fourth report to gain a rotation would copy
  // whichever neighbour it was written beside. So the shape itself is asserted, by content rather
  // than by a byte window — this file's own line numbers move, and a pinning test that slices a
  // fixed offset false-fails the moment anything above it shifts.
  for (const relative of CALL_SITES) {
    const source = read(relative);
    assert.ok(
      source.includes("rotatedLabel("),
      `${relative} must build its label through the shared helper`,
    );
    assert.ok(
      !source.includes("(rotated)`"),
      `${relative} still appends " (rotated)" inline — that is the bug this helper replaced`,
    );
  }
}
