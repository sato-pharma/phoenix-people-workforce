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
 * `{ ok: true }`, or `{ ok: false, reason }` where reason is `"open-pr"` or `"stranded"`. The order
 * is the point: `open-pr` is checked FIRST and is not overridable by any safety signal, because a
 * branch can be both fully backed up and still carrying somebody's open PR.
 */
export function removalVerdict(signals) {
  const s = signals && typeof signals === "object" ? signals : {};
  if (s.openPrOnHead) return { ok: false, reason: "open-pr", pr: String(s.openPrOnHead) };
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
