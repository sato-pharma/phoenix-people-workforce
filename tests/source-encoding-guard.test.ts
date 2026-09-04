import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo-wide source encoding guard.
 *
 * Every signature below is written as \u escapes and never as a literal glyph, so this file can be
 * swept by its own rule. That is the whole design point: the two guards that came before this one
 * (employee-portal-navigation.test.ts and employee-portal-launch-smoke.mjs) spelled their patterns
 * out as real characters, which made each of them the first thing a repo-wide sweep would flag, so
 * a sweep could only exist with those files excluded. A guard with an exclusion list has a blind
 * spot exactly where the encoding-sensitive code lives. Both were rewritten to escapes alongside
 * this file, and there is now nothing to exclude.
 *
 * Anyone who genuinely needs to write one of these sequences (a decoder test, a detector pattern)
 * writes it the same way: \u00E2\u20AC\u201D escapes, never the pasted glyph.
 */

const SOURCE_ROOTS = ["src", "app", "scripts", "tests"] as const;
const SOURCE_EXTENSIONS = /\.(?:tsx?|jsx?|mjs|cjs|py)$/;
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", ".git", "__snapshots__"]);

/**
 * A floor, not an exact count, so the sweep cannot pass vacuously. An empty or mis-rooted file list
 * reads identically to a clean tree, and "no matches" is the failure mode this guard is least able
 * to notice about itself.
 */
const MINIMUM_FILES_SWEPT = 2_000;

type MojibakeSignature = {
  readonly label: string;
  readonly pattern: RegExp;
};

const MOJIBAKE_SIGNATURES: readonly MojibakeSignature[] = [
  {
    // U+2013/U+2014 dashes, curly quotes and the ellipsis all decode into this two-character prefix.
    label: "UTF-8 punctuation read as CP1252 (em/en dash, curly quote, ellipsis)",
    pattern: /\u00E2\u20AC./,
  },
  {
    label: "UTF-8 accented letter read as CP1252",
    pattern: /\u00C3[\u0080-\u00BF]/,
  },
  {
    label: "UTF-8 Latin-1 punctuation read as CP1252 (the stray A-circumflex before a symbol)",
    pattern: /\u00C2[\u00A0-\u00BF]/,
  },
  {
    label: "U+FFFD replacement character - a decode that already failed and is not recoverable",
    pattern: /\uFFFD/,
  },
];

function collectSourceFiles(root: string): string[] {
  let collected: string[] = [];
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const filePath = join(root, entry);
    if (statSync(filePath).isDirectory()) {
      collected = collected.concat(collectSourceFiles(filePath));
    } else if (SOURCE_EXTENSIONS.test(entry)) {
      collected.push(filePath);
    }
  }
  return collected;
}

export function runSourceEncodingGuardTests() {
  const files = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(root));

  assert.ok(
    files.length >= MINIMUM_FILES_SWEPT,
    `Source encoding guard swept only ${files.length} files (expected at least ${MINIMUM_FILES_SWEPT}). ` +
      "The roots moved or the walk broke - a sweep that reads nothing reports a clean tree.",
  );

  const findings: string[] = [];
  for (const filePath of files) {
    const source = readFileSync(filePath, "utf8");
    const lines = source.split(/\r?\n/);
    for (const { label, pattern } of MOJIBAKE_SIGNATURES) {
      if (!pattern.test(source)) continue;
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        findings.push(`${filePath}:${index + 1}  ${label}\n      ${line.trim().slice(0, 160)}`);
      });
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Mojibake in committed source (${findings.length} site(s)). These are UTF-8 bytes that were ` +
      "decoded through CP1252 and re-saved, so the original character is gone from the file rather " +
      "than merely displayed wrongly. Restore the intended character; if the sequence is deliberate " +
      "(a decoder fixture, a detector pattern) write it as \\u escapes so this guard stays " +
      `exclusion-free.\n\n${findings.join("\n")}\n`,
  );
}
