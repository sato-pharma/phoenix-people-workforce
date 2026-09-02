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

import {
  NON_ARCHIVE_REF_PREFIXES,
  isArchiveRef,
  archivePushTarget,
  listArchiveRefs,
  strandedArchives,
} from "../scripts/repo-doctor-archive-refs.mjs";

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

  // The inversion's own fixture: things the rule must judge WITHOUT having been told about them.
  git(dir, ["update-ref", "refs/some-new-convention/kept", tip]); // nobody has classified this
  git(dir, ["tag", "-a", "archive/annotated", "-m", "kept", tip]); // an ANNOTATED tag, not a commit
  git(dir, ["update-ref", "refs/heads/codex/live-work", tip]); // a live branch, measured elsewhere
  git(dir, ["update-ref", "refs/remotes/origin/main", tip]); // a cache of someone else's ref
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
        "refs/some-new-convention/kept",
        "refs/tags/archive/annotated",
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

    assert.equal(
      archivePushTarget("refs/tags/archive/wt-pr1843"),
      "refs/backups/tags/archive/wt-pr1843",
      "a namespace that SAYS something keeps it — the backup ref is read months later by someone "
        + "asking what this commit was, and refs/backups/wt-pr1843 alone does not answer that",
    );

    // ── THE INVERSION: a namespace nobody has classified must be AUDITED, never ignored ───────
    assert.ok(
      names.includes("refs/some-new-convention/kept"),
      "a ref in a namespace this file has never heard of must be audited. The allowlist was wrong "
        + "THREE times — refs/backups, then refs/tags/archive, then refs/deleted-stashes — each "
        + "time silently, and each time in the direction that reads as a clean bill of health",
    );
    assert.ok(
      isArchiveRef("refs/invented/tomorrow/by-someone-else"),
      "the rule must answer for a convention that does not exist yet, with no edit to this file — "
        + "that is the whole point of inverting it. A skip list goes stale toward NOISE; a look "
        + "list goes stale toward LOSS",
    );

    // ── The skip list, and the one branch namespace that outranks it ──────────────────────────
    assert.equal(
      isArchiveRef("refs/heads/codex/live-work"),
      false,
      "a LIVE branch is not an archive — the UNPUSHED COMMITS section already measures those, and "
        + "listing every working branch here would bury the archives it exists to surface",
    );
    assert.ok(
      isArchiveRef("refs/heads/rescue/codex/rescued-task"),
      "rescue/<name> is a keepsake wearing a branch's clothes, so it must outrank the refs/heads/ "
        + "skip — it was an archive before this inversion and must not become invisible now",
    );
    assert.equal(
      isArchiveRef("refs/remotes/origin/main"),
      false,
      "a remote-tracking ref is a CACHE of a ref that lives somewhere else — auditing it reports "
        + "origin's own branches back as YOUR un-backed-up work, which is noise that trains "
        + "people to stop reading the section",
    );
    assert.ok(
      isArchiveRef("refs/stashed-experiments/x"),
      "an EXACT-match skip entry must not swallow a namespace that merely starts with it — "
        + "refs/stash is one ref, and refs/stashed-* would be somebody's kept work",
    );
    for (const entry of NON_ARCHIVE_REF_PREFIXES) {
      assert.ok(
        entry.startsWith("refs/"),
        `${entry} must be a full ref prefix — a bare name would match nothing and quietly widen `
          + "the audit rather than narrow it",
      );
    }

    // ── An ANNOTATED tag must resolve to its commit ───────────────────────────────────────────
    const annotated = found.find((r) => r.ref === "refs/tags/archive/annotated");
    assert.ok(annotated, "an annotated tag in an archive namespace must be listed at all");
    assert.equal(
      annotated?.sha,
      git(dir, ["rev-parse", "refs/tags/archive/annotated^{commit}"]),
      "an annotated tag must resolve to its COMMIT. Its own object is a tag, and for-each-ref "
        + "--contains rejects a non-commit — so the archive would read as stranded however safe "
        + "it is, and this repo keeps 52 refs under refs/tags/archive",
    );

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

// ── Whether a tip "exists on origin" — the SECOND half of this check, wrong until 2026-09-02 ──
//
// The test was `!advertised.has(sha)`: is this SHA the TIP of some ref origin advertises? But an
// archived tip is normally an ORDINARY ANCESTOR of main — merged, pushed, entirely safe — and a ref
// tip it is not. Measured on the primary checkout: 5 refs reported laptop-only, 4 of them direct
// ancestors of origin/main. Worse, the count MOVES on its own as merged branches are deleted from
// origin, so a section meant to be acted on teaches people to ignore it.
//
// The fix must not overshoot into the other direction. A remote-tracking ref is a CACHE of what
// origin said at the last fetch; a rewound or deleted branch would otherwise read as proof, and a
// false CLEAN loses the commit. So an anchor counts only when origin advertises that exact SHA now.
// The stale-anchor case below is the one that pins this, and it is the reason this cannot be
// simplified to "is it an ancestor of origin/main".

/** A repo with a real bare origin, so ancestry and advertisement are both real. */
function makeRepoWithOrigin(): { dir: string; bare: string; shas: Record<string, string> } {
  const bare = mkdtempSync(join(tmpdir(), "phx-archive-origin-"));
  execFileSync("git", ["init", "--bare", "--quiet", bare], { stdio: ["ignore", "pipe", "pipe"] });

  const dir = mkdtempSync(join(tmpdir(), "phx-archive-work-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "--quiet", "-m", "one"]);
  const ancestor = git(dir, ["rev-parse", "HEAD"]);

  writeFileSync(join(dir, "b.txt"), "two\n");
  git(dir, ["add", "b.txt"]);
  git(dir, ["commit", "--quiet", "-m", "two"]);
  const tip = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "--quiet", "origin", "main"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", tip]);

  // Never pushed: this is what genuinely-stranded work looks like.
  writeFileSync(join(dir, "c.txt"), "three\n");
  git(dir, ["add", "c.txt"]);
  git(dir, ["commit", "--quiet", "-m", "three"]);
  const orphan = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["reset", "--quiet", "--hard", tip]);

  // A SEPARATE never-pushed line, whose TIP is held by a stale remote-tracking ref. Deliberately
  // not the same commit as `orphan`: if the two shared a SHA, the stale-anchor case below could be
  // satisfied by the ordinary stranded assertion and would prove nothing of its own.
  writeFileSync(join(dir, "d.txt"), "four\n");
  git(dir, ["add", "d.txt"]);
  git(dir, ["commit", "--quiet", "-m", "four"]);
  const staleChild = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "e.txt"), "five\n");
  git(dir, ["add", "e.txt"]);
  git(dir, ["commit", "--quiet", "-m", "five"]);
  const staleTip = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["reset", "--quiet", "--hard", tip]);

  // Origin advertised this once and does not any more — a cache, not proof.
  git(dir, ["update-ref", "refs/remotes/origin/gone", staleTip]);

  git(dir, ["update-ref", "refs/deleted-branches/at-tip", tip]);
  git(dir, ["update-ref", "refs/deleted-branches/codex/an-ancestor", ancestor]);
  git(dir, ["update-ref", "refs/deleted-branches/codex/never-pushed", orphan]);

  return { dir, bare, shas: { ancestor, tip, orphan, staleChild, staleTip } };
}

function advertisedShas(dir: string): Set<string> {
  return new Set(
    git(dir, ["ls-remote", "origin"])
      .split("\n")
      .map((line) => line.split("\t")[0])
      .filter(Boolean),
  );
}

export function runStrandedArchiveCases(): void {
  const { dir, bare, shas } = makeRepoWithOrigin();
  try {
    const refs = listArchiveRefs(dir);
    assert.ok(refs !== null, "the fixture repo must be readable");

    const advertised = advertisedShas(dir);
    const stranded = strandedArchives(refs, advertised, dir).map((r) => r.ref).sort();

    assert.deepEqual(
      stranded,
      ["refs/deleted-branches/codex/never-pushed"],
      "only the commit origin has never seen is stranded — an archived tip is normally an ORDINARY "
        + "ANCESTOR of main, and calling those laptop-only is what made this section unreadable",
    );

    // The old rule, pinned: it called the ancestor stranded, which is what changed.
    const oldRule = refs.filter((r) => !advertised.has(r.sha)).map((r) => r.ref).sort();
    assert.deepEqual(
      oldRule,
      ["refs/deleted-branches/codex/an-ancestor", "refs/deleted-branches/codex/never-pushed"],
      "the pre-fix SHA-equality rule must still call the ancestor stranded — if it stops, this pin "
        + "is stale and the test no longer proves what the fix changed",
    );
    assert.ok(
      oldRule.length > stranded.length,
      "the fixed rule must report strictly FEWER than the old one, or this test proves nothing",
    );

    // ── The direction that must never invert: a STALE anchor is not proof ──────────────────────
    git(dir, ["update-ref", "refs/deleted-branches/codex/child-of-stale", shas.staleChild]);
    const afterStale = listArchiveRefs(dir);
    assert.ok(afterStale !== null, "the fixture repo must still be readable");
    const strandedWithStale = strandedArchives(afterStale, advertisedShas(dir), dir).map((r) => r.ref);

    assert.ok(
      strandedWithStale.includes("refs/deleted-branches/codex/child-of-stale"),
      "a commit reachable ONLY from a remote-tracking ref that origin no longer advertises must "
        + "still read as stranded — refs/remotes/* is a CACHE of the last fetch, and trusting it "
        + "blindly turns a rewound or deleted branch into proof. A false alarm costs a push; a "
        + "false clean costs the commit",
    );

    // ── Not knowing must never read as clean ──────────────────────────────────────────────────
    assert.deepEqual(
      strandedArchives(refs, new Set(), dir).map((r) => r.ref).sort(),
      refs.map((r) => r.ref).sort(),
      "if origin advertises nothing we can verify, EVERY archive must read as stranded, never none",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
}
