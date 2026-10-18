/**
 * The two decisions `new-session.mjs --remove` was getting wrong, as pure functions.
 *
 * Everything else in that gate is I/O — `gh`, `git`, the filesystem — and was already pinned by
 * source-reading tests. These two are judgements, and a judgement deserves a fixture:
 *
 *   1. WHICH merged PR, if any, vouches for the commits in hand. The gate used to ask
 *      `gh pr list --head <branch> --state merged` and take `.[0]`, which is a question about a
 *      STRING. Branch names here come from task slugs and a recurring task reuses one, so the
 *      answer can be a PR from weeks ago about different work. Measured 2026-10-02: removing
 *      `codex/agents-trim` printed "PR #3588 merged them", and #3588 had used that name on
 *      2026-09-09. The same shape on `codex/agents-footprint` named #3734 from 2026-09-12 while
 *      that night's #5089 was still OPEN — deleting on that answer would have closed #5089.
 *
 *   2. WHETHER the removal may proceed at all. An OPEN PR on the head is a refusal on its own,
 *      whatever every safety signal says: the signals answer "are these commits safe", and an open
 *      PR is the different question of whether somebody is still waiting on them.
 *
 * Both are three-valued where it matters. `null` means "could not be asked", never "no" — and the
 * caller refuses on it, because erring toward the refusal costs a command and erring the other way
 * costs the work.
 */

/**
 * The merged PR whose own head commit IS this tip, or null.
 *
 * `rows` is whatever `gh pr list --head <branch> --state merged --json number,headRefOid` returned;
 * shape is not trusted, because a `gh` upgrade that renames a field must read as "cannot tell" and
 * refuse, not as "nothing merged" and clear.
 */
export function pickMergedPrForTip(rows, tip) {
  if (!Array.isArray(rows) || typeof tip !== "string" || tip.trim() === "") return null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const sha = typeof row.headRefOid === "string" ? row.headRefOid.trim() : "";
    const number = row.number;
    if (sha !== "" && sha === tip.trim() && (typeof number === "number" || typeof number === "string")) {
      return String(number);
    }
  }
  return null;
}

/**
 * Whether `--remove` may proceed, and why not when it may not.
 *
 * `{ ok: true }`, or `{ ok: false, reason }` where reason is `"open-pr"`, `"folder-gone"` or
 * `"stranded"`. The order is the point: `open-pr` is checked FIRST and is not overridable by any
 * safety signal, because a branch can be both fully backed up and still carrying somebody's open PR.
 *
 * 🔴 `folder-gone` COMES SECOND, AND IT IS NOT A SAFETY SIGNAL — IT IS THE ABSENCE OF THE FOLDER THE
 * OTHER SIGNALS WERE READ FROM. Every answer in the gate comes from `git` run INSIDE the worktree, so
 * when the folder stops being a git checkout part-way through (the session that owns it retired it
 * in the same minute), the reads after that point fail, come back `null`, and null means "refuse".
 * The gate then blamed STRANDED commits that were sitting safely on a merged PR's head. Measured
 * 2026-10-19 retiring `_wt-weekly-plan-followups` (PR 6099, merged at that tip): it printed "commits
 * here are on no remote branch and no merged PR" about a folder that no longer existed.
 * Nothing in a folder that is not there can be lost by removing it, so this verdict is neither a pass
 * nor a refusal about the work: the caller prunes the dead registration and says so.
 */
export function removalVerdict(signals) {
  const s = signals && typeof signals === "object" ? signals : {};
  if (s.openPrOnHead) return { ok: false, reason: "open-pr", pr: String(s.openPrOnHead) };
  if (s.folderGone) return { ok: false, reason: "folder-gone" };
  if (!s.unpushed) return { ok: true };
  // Any ONE of these is enough: the commits are on origin under this name or another, a merged PR
  // carries this exact tip, their patch-ids are upstream, or every file they touch is already
  // byte-identical on main (the roll-up-member case, which lands CLOSED and so has no merged PR of
  // its own and no matching patch-id).
  if (s.pushed || s.mergedPr || s.onAnotherRemoteBranch || s.contentBackedUp || s.filesIdenticalOnMain) {
    return { ok: true };
  }
  return { ok: false, reason: "stranded" };
}

/**
 * Whether a string is shaped like a git object id — the test that stops a failed read passing for a
 * sha.
 *
 * 🔴 IT LIVES HERE SO IT CAN BE EXERCISED. `headSha` in `new-session.mjs` is module-private, and that
 * file runs its CLI at import, so a test cannot call it. The predicate is the half worth proving and
 * the one the defect turned on: `headSha` used to answer the string `"HEAD"` when git could not say
 * — a value that reads as a sha, prints as a sha, and is not one. It reached the reader on
 * 2026-10-02 as "its headRefOid equal to HEAD", in the one line whose whole job was to name a commit.
 *
 * Deliberately NOT length-40-only: `git rev-parse --short` is legitimate and this guards both forms.
 * Deliberately case-SENSITIVE: git emits lowercase, and accepting uppercase would admit `DEADBEEF`
 * and friends — words that look like hex — which is the class being closed.
 */
export function isShaLike(value) {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value);
}
