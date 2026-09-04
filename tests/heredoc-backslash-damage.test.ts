import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Heredoc backslash damage — a repo-wide sweep for the residue.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * Writing a file through a shell heredoc (`cat > file <<'EOF'`) eats one level of backslash, even
 * when the delimiter is quoted. Two source files reached `main` damaged that way, and an audit on
 * 2026-09-04 found both were assertions that could never fail:
 *
 *   tests/marketing-approval-history-tab.test.ts  `/…\btruncate\b/` arrived with its two word
 *       boundaries as literal U+0008 BACKSPACE bytes. The `assert.doesNotMatch` guarding the
 *       owner's no-ellipsis rule was a permanent green.
 *   tests/organogram-whatsapp-gate.test.ts        `"\b"` in a plain string is U+0008, not a word
 *       boundary. Four assertions claiming a phone-number route exposes no POST/PUT/PATCH/DELETE
 *       were all `!false`.
 *
 * ── WHY A SWEEP AND NOT TWO PINS ─────────────────────────────────────────────
 * Both failed in the PASSING direction, which is the whole problem: a vacuous assertion is
 * indistinguishable from a working one in CI output, forever. Nothing about either site was
 * special — any file authored through a heredoc can arrive this way — so the guard has to be the
 * shape of the defect, not the shape of the two places it was found.
 *
 * ── THE TWO ON-DISK SHAPES ───────────────────────────────────────────────────
 * They are genuinely different and only one of them is visible in a diff:
 *   1. A real control byte in the file. Byte-exact, cheap, zero false positives.
 *   2. A halved escape that is still valid JavaScript — `"\b"` where `"\\b"` was meant. The file
 *      reviews clean; the backspace only exists at runtime. Caught by comparing against the
 *      correct form, which `tests/access-registry-coverage.test.ts` has always had.
 *
 * Reach, stated honestly: rule 2 is line-scoped and skips `String.raw`, which is the other correct
 * way to write these (`tests/offer-outstation-clause.test.ts`). A `new RegExp(` whose pattern sits
 * on the FOLLOWING line is not seen. That is deliberate — a wider window costs false positives on
 * the many legitimate `x.replace(/\s+/g, " ")` calls that share a line with a constructor, and a
 * guard that cries wolf gets deleted.
 */

/** Where source lives. `.claude/hooks` is included: those are `.mjs` files, written by hand. */
const SCAN_ROOTS = ["app", "src", "tests", "scripts", "supabase", join(".claude", "hooks")];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".cjs", ".sql"];
const SKIP_DIRECTORY_NAMES = new Set([".git", ".next", "node_modules", "coverage", "dist", "build", "worktrees"]);

/** BEL, BACKSPACE, VERTICAL TAB, FORM FEED, ESC — none has a reason to sit in this repo's source. */
const CONTROL_CHARACTERS = /[\u0007\u0008\u000b\u000c\u001b]/;

const REGEX_CONSTRUCTOR = "new RegExp(";
const RAW_STRING_TAG = "String.raw";
/** A LONE backslash before a regex class letter: `"\b"` on disk where `"\\b"` was meant. */
const HALVED_REGEX_ESCAPE = /(?<!\\)\\[bsdwSDWB]/;

function scannableFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // a root that does not exist in this checkout is not a failure
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_wt-")) continue; // sibling worktrees, never this checkout's source
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        visit(join(directory, entry.name));
        continue;
      }
      if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(join(directory, entry.name));
      }
    }
  };
  visit(root);
  return found;
}

export function runHeredocBackslashDamageTests() {
  const files = SCAN_ROOTS.flatMap(scannableFiles);

  // POSITIVE CONTROL on the walker itself. Everything below is a "found nothing" assertion, and a
  // walk that silently reached no files would satisfy every one of them. This is the same failure
  // this whole test exists to prevent, one level up.
  assert.ok(
    files.length > 3000,
    `the sweep must actually reach the tree — only ${files.length} files scanned, so the empty results below would prove nothing`,
  );

  const controlByteSites: string[] = [];
  const halvedEscapeSites: string[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    const controlAt = text.search(CONTROL_CHARACTERS);
    if (controlAt > -1) {
      controlByteSites.push(`${file}:${text.slice(0, controlAt).split("\n").length}`);
    }

    if (!text.includes(REGEX_CONSTRUCTOR)) continue;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes(REGEX_CONSTRUCTOR)) continue;
      if (line.includes(RAW_STRING_TAG)) continue;
      if (!HALVED_REGEX_ESCAPE.test(line)) continue;
      halvedEscapeSites.push(`${file}:${index + 1}  ${line.trim()}`);
    }
  }

  assert.deepEqual(
    controlByteSites,
    [],
    `a control byte is sitting in source — a heredoc ate a backslash and left the character it stood for. Rewrite the file with the Write tool, never a heredoc:\n  ${controlByteSites.join("\n  ")}`,
  );

  assert.deepEqual(
    halvedEscapeSites,
    [],
    `a regex is being built from a string holding a HALVED escape, so it matches something other than what it reads as (\`"\\b"\` is U+0008, not a word boundary). Double the backslash or use String.raw:\n  ${halvedEscapeSites.join("\n  ")}`,
  );

  // The two sites the 2026-09-04 audit repaired, pinned by BEHAVIOUR rather than by source text so
  // this keeps working if either file is reformatted. Each pattern must still be able to see a real
  // violation — the property both of them lost.
  const truncatedHeading = /<h3 className="[^"]*\btruncate\b/;
  assert.match('<h3 className="x truncate">n</h3>', truncatedHeading, "the no-ellipsis pattern must match a truncated heading");
  assert.doesNotMatch('<h3 className="x truncated">n</h3>', truncatedHeading, "…and must not be fooled by `truncated`");

  const handlerPattern = new RegExp("export async function " + "POST" + "\\b", "u");
  assert.ok(handlerPattern.test("export async function POST() {"), "the route-verb pattern must match a real handler");
  assert.ok(!handlerPattern.test("export async function POSTAL() {"), "…and must not match a longer identifier");
}
