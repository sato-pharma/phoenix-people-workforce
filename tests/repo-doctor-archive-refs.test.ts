// An archive ref named `codex/<task>` must be AUDITED, not skipped.
//
// WHY THIS EXISTS. `repo-doctor.mjs` has one section that answers "does every archived branch tip
// also exist off this laptop?", and AGENTS.md section 2.1 states that `refs/backups/*` on ORIGIN is
// the only copy that survives losing this machine. Nothing else measures it.
//
// It asked git with `refs/deleted-branches/*` and `refs/heads/rescue/*`. `git for-each-ref` globs do
// NOT cross a slash, so a single star matches only ref names containing no `/` — while this
// repository names almost every branch `codex/<task>` or `claude/<task>`. Measured 2026-09-01 on the
// primary checkout: 137 of 306 archives matched, and the report printed
//
//     137 local archive ref(s), 0 with no copy on origin
//     -> none. Every archived tip also exists on origin.
//
// Of the 169 refs it could not see, 23 existed nowhere but this laptop — `codex/agents-md-trim`,
// `codex/aif-ue-split`, four `claude/*` tips, and eighteen more. The verdict was not merely
// incomplete, it was inverted: a clean bill of health over the refs the check never examined, which
// stops anyone from looking. That is strictly worse than having no check at all.
//
// WHY THIS TEST DRIVES REAL GIT. The bug was what git does with a glob, not what a regex does with a
// string. A test that re-implemented the matching rule would have passed against the broken version
// too. So each case builds a throwaway repo holding a flat archive ref AND a nested one, and asks
// the real exported patterns through real `git for-each-ref`.
//
// EVERY CASE ALSO PINS THE OLD ANSWER. `singleStarRefs` below is the pre-fix query, reproduced
// verbatim. Asserting it still finds only the flat ref where the fixed patterns find both is what
// proves this test discriminates rather than passing for free.
//
// THE DANGEROUS DIRECTION IS ONE-WAY. A missed archive reads as "backed up"; a false alarm only
// costs a push. So the null case is not decoration — a check that answers "no archives" when git
// failed is how a laptop-only tip gets believed safe.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARCHIVE_REF_PATTERNS, archivePushTarget, listArchiveRefs } from "../scripts/repo-doctor-archive-refs.mjs";

function git(at: string, args: string[]): string {
  return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The query as it was BEFORE the 2026-09-02 fix: recursive, but blind to `refs/backups/**`. */
function beforeBackupsPrefixRefs(at: string): string[] {
  return git(at, ["for-each-ref", "--format=%(refname)", "refs/deleted-branches/**", "refs/heads/rescue/**"])
    .split("\n")
    .filter(Boolean);
}

/** The query exactly as it was before the nested-name fix, kept so each case can show what changed. */
function singleStarRefs(at: string): string[] {
  return git(at, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/deleted-branches/*",
    "refs/heads/rescue/*",
  ])
    .split("\n")
    .filter(Boolean);
}

/** A repo with one commit, a FLAT archive ref, a NESTED one, and a nested rescue branch. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "phx-archive-refs-"));
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "--quiet", "-m", "one"]);
  const tip = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["update-ref", "refs/deleted-branches/flat-name", tip]);
  git(dir, ["update-ref", "refs/deleted-branches/codex/nested-task", tip]);
  git(dir, ["update-ref", "refs/deleted-branches/claude/deeply/nested-task", tip]);
  git(dir, ["update-ref", "refs/heads/rescue/codex/rescued-task", tip]);
  git(dir, ["update-ref", "refs/backups/flat-backup", tip]);
  git(dir, ["update-ref", "refs/backups/codex/nested-backup", tip]);
  return dir;
}

export function runRepoDoctorArchiveRefsTests(): void {
  const dir = makeRepo();
  try {
    // ── The fix: every archive is seen, whatever its name's shape ──────────────────────────────
    const found = listArchiveRefs(dir);
    assert.ok(found !== null, "listArchiveRefs must not return null for a healthy repo");
    const names = found.map((r) => r.ref).sort();

    assert.deepEqual(
      names,
      [
        "refs/backups/codex/nested-backup",
        "refs/backups/flat-backup",
        "refs/deleted-branches/claude/deeply/nested-task",
        "refs/deleted-branches/codex/nested-task",
        "refs/deleted-branches/flat-name",
        "refs/heads/rescue/codex/rescued-task",
      ],
      "every archive ref must be audited — a `codex/<task>` name is the DOMINANT convention in this "
        + "repo, and skipping it certifies backups that were never checked (AGENTS.md 2.1)",
    );

    // ── The old answer, pinned: this is what made the bug invisible ────────────────────────────
    const old = singleStarRefs(dir).sort();
    assert.deepEqual(
      old,
      ["refs/deleted-branches/flat-name"],
      "the pre-fix single-star query must still miss every nested ref — if this ever matches them, "
        + "for-each-ref semantics changed and the comment explaining `**` is now wrong",
    );
    assert.ok(
      old.length < names.length,
      "the fixed patterns must find strictly MORE than the old ones, or this test proves nothing",
    );

    // ── The refs/backups/** namespace specifically: what the 2026-09-02 fix added ──────────────
    const beforeBackups = beforeBackupsPrefixRefs(dir).sort();
    assert.deepEqual(
      beforeBackups,
      [
        "refs/deleted-branches/claude/deeply/nested-task",
        "refs/deleted-branches/codex/nested-task",
        "refs/deleted-branches/flat-name",
        "refs/heads/rescue/codex/rescued-task",
      ],
      "the pre-2026-09-02 patterns must still miss every refs/backups ref — if they stop missing "
        + "them, this pin is stale and no longer proves what the fix changed",
    );
    assert.equal(
      names.filter((n) => n.startsWith("refs/backups/")).length,
      2,
      "refs/backups/** is THE namespace AGENTS.md 2.1 names as the only copy that survives losing "
        + "this laptop — auditing every OTHER namespace but that one is how 21 real archive refs "
        + "went unexamined while the report printed a clean bill of health",
    );

    // ── The recovery line must name a ref someone would actually look for ──────────────────────
    assert.equal(
      archivePushTarget("refs/backups/codex/nested-backup"),
      "refs/backups/codex/nested-backup",
      "a ref already under refs/backups pushes to ITSELF — the naive form yields "
        + "refs/backups/refs/backups/<name>, filing the tip where nobody will look, and it is "
        + "printed at exactly the moment someone is trying to rescue work",
    );
    assert.equal(
      archivePushTarget("refs/deleted-branches/codex/nested-task"),
      "refs/backups/codex/nested-task",
      "a deleted-branch archive keeps the target it already had — this fix must not move it",
    );
    assert.equal(
      archivePushTarget("refs/heads/rescue/codex/rescued-task"),
      "refs/backups/rescue/codex/rescued-task",
      "a rescue branch keeps the target it already had — this fix must not move it",
    );

    // ── The patterns themselves are recursive ──────────────────────────────────────────────────
    for (const pattern of ARCHIVE_REF_PATTERNS) {
      assert.ok(
        pattern.endsWith("/**"),
        `${pattern} must end in "/**" — a single star stops at a slash, which is the whole bug`,
      );
    }

    // ── Not knowing must never read as clean ───────────────────────────────────────────────────
    const notARepo = mkdtempSync(join(tmpdir(), "phx-archive-refs-empty-"));
    try {
      assert.equal(
        listArchiveRefs(notARepo),
        null,
        "a directory that is not a git repo must answer null, never [] — an empty list reads as "
          + "'no archives to worry about', which is how a laptop-only tip gets believed safe",
      );
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
