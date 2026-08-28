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
// there were 292 real sites when this was counted honestly, across 126 files.
//
// So this test does not try to fix them. It RATCHETS. The count may fall and may
// never rise, which means:
//
//   - new UI is held to the rule from the day it is written, and
//   - the existing 292 can be retired deliberately, screen by screen, with the
//     baseline lowered as they go.
//
// A count that goes UP is a new violation somebody just added. A count that goes
// DOWN is good news and this test says so, because a stale-high baseline quietly
// re-opens the door to the number it was lowered from.
//
// WHAT COUNTS
// Only a CSS truncation class inside a quoted class string, in CODE. A JS identifier
// named `truncate`, an Excel column truncation in an export, or the word in a comment
// is not a UI ellipsis and is not counted — comments are stripped before anything is
// measured, and that is now enforced by the detector self-checks in the body below
// rather than merely promised in this paragraph.
//
// It was promised here and untrue from the day this landed. The first count of 298
// included SIX prose mentions, and five of those six were comments explaining why the
// author had deliberately NOT used the class — the ratchet was spending its headroom
// on documentation of compliance. #2571 then lost a full CI round when a seventh such
// comment pushed the count to 299: a production revert held up by a sentence
// describing the very rule it was obeying.
//
// WHAT IS NOT A VIOLATION
// The ~460 "…" characters in progress text — "Loading…", "Approving…", "Opening
// WhatsApp…". Those are a progress indicator, not truncation: nothing is being
// hidden from the reader. Sweeping them would be a regression dressed up as
// compliance, so they are out of scope by design, not by oversight.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-28 on commit aeab6be5, with comments stripped. Lower this when
 * sites are genuinely retired; never raise it to make a red run go green.
 *
 * Was 298 when first counted on 80ba78f2 (Phase 5). That figure counted six prose
 * mentions as violations, so it never described the UI. Nothing changed on screen
 * when it moved to 292 — only the measurement stopped being wrong.
 */
const BASELINE = 292;

const ROOTS = ["app", "src"];

/** A CSS truncation class sitting inside a quoted class string. */
const CLASS_STRING_WITH_TRUNCATION =
  /["'`][^"'`\n]*\b(?:truncate|text-ellipsis|line-clamp-\d+)\b[^"'`\n]*["'`]/;
const ANY_TRUNCATION_TOKEN = /\b(?:truncate|text-ellipsis|line-clamp-\d+)\b/;

/**
 * Remove comments before counting, so a class only counts where it is APPLIED.
 *
 * A backtick has to stay in the delimiter set above, because a template literal is
 * how a good half of these class strings are actually written
 * (`` className={`flex truncate ${x}`} ``). That makes a markdown code span in a
 * JSDoc block indistinguishable from a real class string on a line-by-line read —
 * which is the whole defect. Stripping the comment first is what separates them;
 * narrowing the delimiters would only trade false positives for false negatives.
 *
 * Newlines are preserved so the `file:line` reported for a real violation still
 * points at its real line: a block comment keeps its line breaks and loses
 * everything else. The `[^:]` guard keeps a `https://…` URL from reading as the
 * start of a line comment and swallowing the rest of the line with it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it on ~2,900 files.
  // A ratchet whose regex is wrong does not fail loudly — it reports a number, and
  // a wrong number looks exactly as authoritative as a right one. That is how 298
  // stood unchallenged until a comment tipped it to 299 and someone read the list.
  // ───────────────────────────────────────────────────────────────────────────
  const countIn = (snippet: string) =>
    stripComments(snippet)
      .split("\n")
      .filter((line) => CLASS_STRING_WITH_TRUNCATION.test(line)).length;

  assert.equal(countIn('<p className="truncate">{name}</p>'), 1, "a plain class string is a real violation and must still count");
  assert.equal(countIn("<p className={`flex truncate ${x}`}>{n}</p>"), 1, "a template-literal class string must still count — narrowing the delimiters to silence comments would blind the ratchet to these instead");
  assert.equal(countIn('<p className="line-clamp-2">{n}</p>'), 1, "line-clamp falls under the same rule as truncate");
  assert.equal(countIn("// the label span has no `truncate`, so a long one would wrap"), 0, "a line comment naming the class is prose, not a violation");
  assert.equal(countIn("/**\n * the span has no `truncate` here\n */"), 0, "a JSDoc block naming the class is prose, not a violation");
  assert.equal(countIn("{/* No `truncate` on purpose — the text must never be cut */}"), 0, "a JSX block comment naming the class is prose, not a violation");
  assert.equal(countIn('const u = "https://x.example/a";\n<p className="truncate">{n}</p>'), 1, "a URL must not read as the start of a comment and swallow the line after it");

  // Line numbers survive stripping, or every file:line reported below is shifted
  // upward by the size of whatever comment block sat above it.
  const preserved = stripComments('/*\n * `truncate`\n */\n<p className="truncate">x</p>').split("\n");
  assert.equal(preserved.length, 4, "stripping must preserve the line count, or every file:line this test prints is wrong");
  assert.ok(
    CLASS_STRING_WITH_TRUNCATION.test(preserved[3]),
    "the surviving violation must still sit on its original line after the comment above it is stripped",
  );

  const sites: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
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
