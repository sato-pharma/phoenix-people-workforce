import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Recurrence guard for a share token pasted into the documentation.
//
// WHAT HAPPENED. A full bearer token for a public share link has been committed under docs/ twice:
// the live sheet's "bootstrap" feed token in docs/direct-orders-live-sheet.gs on 2026-08-05 (#1754,
// taken out again by #1792), and two feed tokens in
// docs/runbooks/direct-orders-feed-token-stale-duplicate-2026-09-05.md on 2026-09-06 (#3322), one of
// them live at the time. The required secret-scan check caught neither: gitleaks knows vendor key
// formats, and a token minted as randomBytes(32).toString("base64url") has no vendor prefix at all.
//
// WHAT IT CHECKS. Every tracked file under docs/, for a run of 43 or more base64url characters that
// holds upper case, lower case AND a digit — the shape of every share token this app mints. A longer
// run counts too: a token glued to a "_" or a "-" is still a token. Requiring both cases and a digit
// keeps git SHAs, sha256 digests (lower-case hex), kebab-case slugs and long camelCase names out; the
// price is that about one real token in 1,500 has no digit and would pass. Binary files (a NUL in the
// first 8 KB) are skipped: a token typed into a spreadsheet is compressed inside the file, where no
// text scan could see it anyway.
//
// WHAT IT PRINTS. File, line and the first 6 characters, never more. A failure lands in a CI log that
// anyone with access to the repository can read, so a guard that echoed the token would be the leak.
// The run itself never leaves tokenShapedRuns() — only its first 6 characters and its hash do.
//
// A LEGITIMATE HIT goes in ALLOWED_RUNS, pinned by file and the sha256 of the run, with its reason —
// never a looser pattern. None existed when this landed (2026-09-16): the tree was scanned first, and
// its only two hits were the two tokens above.
const ALLOWED_RUNS: { file: string; sha256: string; reason: string }[] = [];

const TOKEN_RUN = /[A-Za-z0-9_-]{43,}/g;

type TokenShapedRun = { line: number; first6: string; sha256: string };

function tokenShapedRuns(text: string): TokenShapedRun[] {
  const runs: TokenShapedRun[] = [];
  text.split("\n").forEach((content, index) => {
    for (const match of content.matchAll(TOKEN_RUN)) {
      const run = match[0];
      if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) continue;
      runs.push({ line: index + 1, first6: run.slice(0, 6), sha256: createHash("sha256").update(run).digest("hex") });
    }
  });
  return runs;
}

export function runDocsShareTokenGuardTests() {
  // The detector first, on strings assembled here rather than written out: a pattern that could no
  // longer match would otherwise report a clean tree for ever.
  const shaped = "Ab1".repeat(15).slice(0, 43);
  assert.equal(
    tokenShapedRuns(`GET /api/share/direct-orders/${shaped}/feed  403`).length,
    1,
    "a token inside a share URL must be found — that is exactly how the 2026-09-06 runbook carried one",
  );
  assert.equal(tokenShapedRuns(`_${shaped}_`).length, 1, "a token glued to underscores is still a token");
  assert.deepEqual(
    tokenShapedRuns(`intro\n\n${shaped}`).map((run) => [run.line, run.first6]),
    [[3, "Ab1Ab1"]],
    "a finding carries its own line and exactly the first 6 characters",
  );
  assert.equal(tokenShapedRuns(shaped.slice(0, 42)).length, 0, "42 characters is shorter than any token this app mints");
  assert.equal(
    tokenShapedRuns("0123456789abcdef".repeat(4)).length,
    0,
    "a sha256 digest or git SHA is lower-case hex and must never be flagged — runbooks quote them",
  );
  assert.equal(
    tokenShapedRuns("direct-orders-feed-token-stale-duplicate-2026-09-05").length,
    0,
    "a kebab-case slug has no upper case and must never be flagged",
  );
  assert.equal(
    tokenShapedRuns("Ab".repeat(22)).length,
    0,
    "a run with no digit is not flagged: long camelCase names stay out, at the price of one real token in about 1,500",
  );

  // -z: NUL-separated, so a filename can never be mis-split. `git ls-files` rather than a directory
  // walk, because only TRACKED files reach the remote, and this checkout carries ~1.9M gitignored
  // path entries (measured for tests/no-nul-bytes-in-source.test.ts).
  const listed = execFileSync("git", ["ls-files", "-z", "--", "docs"], { maxBuffer: 64 * 1024 * 1024 });
  const files = listed
    .toString("utf8")
    .split("\u0000")
    .filter((file) => file.length > 0);
  assert.ok(
    files.length > 25,
    `git ls-files listed only ${files.length} files under docs/ — the sweep did not actually run, so a green result here would certify nothing`,
  );

  const allowed = new Set(ALLOWED_RUNS.map((entry) => `${entry.file}:${entry.sha256}`));
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue; // listed in the index but absent from the working tree — not this test's business
    }
    if (bytes.subarray(0, 8000).includes(0)) continue;
    scanned += 1;
    for (const run of tokenShapedRuns(bytes.toString("utf8"))) {
      if (allowed.has(`${file}:${run.sha256}`)) continue;
      offenders.push(`${file}:${run.line} starts ${run.first6}`);
    }
  }
  assert.ok(scanned > 25, `only ${scanned} text files under docs/ were read — the scan did not actually run`);

  assert.deepEqual(
    offenders,
    [],
    `A tracked file under docs/ holds a token-shaped string: 43 or more base64url characters mixing upper ` +
      `case, lower case and digits, the shape of a share token. Only its first 6 characters are shown. ` +
      `Replace it with those 6 characters, and treat the token as exposed: git history keeps the original, ` +
      `so revoke or rotate it unless it is already revoked. A string that is not a credential goes in ` +
      `ALLOWED_RUNS in tests/docs-share-token-guard.test.ts, with its reason.\n  ${offenders.join("\n  ")}`,
  );
}
