import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule: "Never truncate text with an ellipsis and never let text
// wrap to multiple lines in the UI."
//
// Both halves matter at once, and that is exactly why this cannot be a codemod.
// Deleting `truncate` satisfies the first half by violating the second: the text
// stops being cut off and starts wrapping instead. The correct fix is per-site
// layout work — widen the column, let the table scroll, shorten the label — and
// there were 298 sites when this was first counted, across 126 files.
//
// So this test does not try to fix them. It RATCHETS. The count may fall and may
// never rise, which means:
//
//   - new UI is held to the rule from the day it is written, and
//   - the existing 298 can be retired deliberately, screen by screen, with the
//     baseline lowered as they go.
//
// A count that goes UP is a new violation somebody just added. A count that goes
// DOWN is good news and this test says so, because a stale-high baseline quietly
// re-opens the door to the number it was lowered from.
//
// WHAT COUNTS
// Only a CSS truncation class inside a quoted class string. A JS identifier named
// `truncate`, an Excel column truncation in an export, or the word in a comment is
// not a UI ellipsis and is deliberately not counted.
//
// WHAT IS NOT A VIOLATION
// The ~460 "…" characters in progress text — "Loading…", "Approving…", "Opening
// WhatsApp…". Those are a progress indicator, not truncation: nothing is being
// hidden from the reader. Sweeping them would be a regression dressed up as
// compliance, so they are out of scope by design, not by oversight.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-28 on commit 80ba78f2 (Phase 5). Lower this when sites are
 * genuinely retired; never raise it to make a red run go green.
 */
const BASELINE = 298;

const ROOTS = ["app", "src"];

/** A CSS truncation class sitting inside a quoted class string. */
const CLASS_STRING_WITH_TRUNCATION =
  /["'`][^"'`\n]*\b(?:truncate|text-ellipsis|line-clamp-\d+)\b[^"'`\n]*["'`]/;
const ANY_TRUNCATION_TOKEN = /\b(?:truncate|text-ellipsis|line-clamp-\d+)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Nothing gitignored lives under app/ or src/, but skip the obvious anyway
      // so a stray local folder can never inflate the count.
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runNoEllipsisTruncationRatchetTests() {
  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  const sites: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!ANY_TRUNCATION_TOKEN.test(source)) continue;
    source.split("\n").forEach((line, i) => {
      if (CLASS_STRING_WITH_TRUNCATION.test(line)) sites.push(`${file.replace(/\\/g, "/")}:${i + 1}`);
    });
  }

  const count = sites.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new UI truncation site(s) were added — the count went ${BASELINE} -> ${count}.\n` +
      `The owner's rule is that text is never cut off with an ellipsis and never wraps. Give the ` +
      `text room instead: widen the column, let the table scroll horizontally, or shorten the label.\n` +
      `Sites now present:\n  ${sites.slice(-12).join("\n  ")}`,
  );

  assert.ok(
    count >= BASELINE,
    `Good news: truncation sites dropped ${BASELINE} -> ${count}. Lower BASELINE in this file to ` +
      `${count} so the ground that was won cannot be given back.`,
  );
}
