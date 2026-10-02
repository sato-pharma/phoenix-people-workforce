import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isShaLike, pickMergedPrForTip, removalVerdict } from "../scripts/lib/remove-gate.mjs";

/**
 * `new-session.mjs --remove` must not accept a merged PR that merely SHARES THE BRANCH NAME, and
 * must refuse outright while an open PR carries the head.
 *
 * WHY THIS EXISTS. The gate asked `gh pr list --head <branch> --state merged --jq '.[0].number'` —
 * a question about a STRING, never compared with the branch tip and never paired with an open-PR
 * check. Branch names here are derived from task slugs and a recurring task reuses one.
 *
 * Measured 2026-10-02, twice in one session:
 *   · removing `codex/agents-trim` printed *"PR #3588 merged them — squash residue, not stranded
 *     work"*. #3588 had used that name on 2026-09-09; the branch in hand was `ef184cc84`, whose
 *     work had landed through a roll-up. The gate vouched, and it was right by accident.
 *   · the same shape on `codex/agents-footprint` named #3734 from 2026-09-12 while that night's
 *     #5089 was still OPEN. Deleting on that answer would have closed #5089 and thrown the work
 *     away. Once #5089 merged, the same query returned both PRs — so re-running it afterwards
 *     looks fine, which is why this can go unnoticed.
 *
 * THE THIRD SIGNAL IS NOT OPTIONAL. A roll-up member lands CLOSED, not merged, and its commits are
 * a SUBSET of one larger squash — so the merged-PR test answers null and the patch-id test answers
 * no. Without the file-content test, the normal end state of a batched merge is a worktree the gate
 * refuses to retire, which is how a guard becomes something people step around.
 *
 * WHAT IS PINNED WITH FIXTURES rather than by reading source: which PR is picked, and the ORDER of
 * the decision. A source-reading test cannot see that `open-pr` outranks every safety signal, and
 * that precedence is the half that protects somebody else's work.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

export function runWorktreeRemoveHeadShaGateTests() {
  const TIP = "ef184cc845a4a171de79e92864242e06b7cdebbf";
  const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  // ── 1. The PR must be picked by SHA, never by position ──────────────────────────────────────
  {
    // The incident: an older PR on the same name, listed first, with a different head.
    assert.equal(
      pickMergedPrForTip([{ headRefOid: OTHER, number: 3588 }], TIP),
      null,
      "a merged PR that reused the branch name must NOT vouch for a tip it never contained",
    );
    assert.equal(
      pickMergedPrForTip([{ headRefOid: TIP, number: 5106 }], TIP),
      "5106",
      "a merged PR whose head IS the tip vouches",
    );
    // Both present, the stale one first — the exact ordering `.[0]` got wrong.
    assert.equal(
      pickMergedPrForTip(
        [
          { headRefOid: OTHER, number: 3588 },
          { headRefOid: TIP, number: 5106 },
        ],
        TIP,
      ),
      "5106",
      "with a stale PR listed first, the sha must still decide which one is named",
    );
    // Whitespace from `@tsv`, and a numeric vs string `number`, must not change the answer.
    assert.equal(pickMergedPrForTip([{ headRefOid: ` ${TIP} `, number: "5106" }], ` ${TIP} `), "5106");

    // ── Shapes that must read as "cannot tell", never as "nothing merged" ──
    // A gh upgrade that renames the field, or a jq that printed one column, must refuse rather
        // than clear: the dangerous direction here is a confident no.
    assert.equal(pickMergedPrForTip([{ number: 5106 }], TIP), null, "a row with no headRefOid vouches for nothing");
    assert.equal(pickMergedPrForTip([{ headRefOid: "", number: 5106 }], TIP), null, "an empty sha vouches for nothing");
    assert.equal(pickMergedPrForTip([{ headRefOid: TIP }], TIP), null, "a row with no number cannot be named");
    assert.equal(pickMergedPrForTip([], TIP), null);
    assert.equal(pickMergedPrForTip(null as never, TIP), null, "a non-array must not throw inside the gate");
    assert.equal(pickMergedPrForTip([{ headRefOid: TIP, number: 1 }], ""), null, "an unknown tip matches nothing");
    // 🔴 `headSha` now answers NULL when git cannot say, and this is the call that receives it. The
    // gate must then refuse rather than accept the first merged PR on the name — a vouch granted
    // because the tip was UNREADABLE is the original defect with a different cause.
    assert.equal(
      pickMergedPrForTip([{ headRefOid: TIP, number: 5106 }], null as never),
      null,
      "an unreadable tip must vouch for nothing — not even for a PR whose head really is this branch's",
    );
  }

  // ── 2. An OPEN PR outranks every safety signal ──────────────────────────────────────────────
  {
    // The whole point of the precedence: a branch can be fully backed up AND still carry an open
    // PR. Every signal below says "safe", and the answer is still no.
    const safeEverything = {
      contentBackedUp: true,
      filesIdenticalOnMain: true,
      mergedPr: "5106",
      onAnotherRemoteBranch: "claude/something",
      pushed: true,
      unpushed: "abc123 some commit",
    };
    assert.deepEqual(
      removalVerdict({ ...safeEverything, openPrOnHead: "5089" }),
      { ok: false, pr: "5089", reason: "open-pr" },
      "an open PR on the head refuses the removal even when every safety signal passes",
    );
    // And it refuses on a worktree with nothing unpushed at all, where the safety signals are moot.
    assert.equal(removalVerdict({ openPrOnHead: "5089", unpushed: "" }).reason, "open-pr");
    assert.deepEqual(removalVerdict({ ...safeEverything, openPrOnHead: null }), { ok: true });
  }

  // ── 3. Any ONE safety signal clears it; none of them means stranded ─────────────────────────
  {
    const base = {
      contentBackedUp: false,
      filesIdenticalOnMain: false,
      mergedPr: null,
      onAnotherRemoteBranch: null,
      openPrOnHead: null,
      pushed: false,
      unpushed: "abc123 some commit",
    };
    assert.deepEqual(removalVerdict(base), { ok: false, reason: "stranded" }, "no signal at all is stranded work");
    for (const key of ["pushed", "mergedPr", "onAnotherRemoteBranch", "contentBackedUp", "filesIdenticalOnMain"]) {
      const value = key === "mergedPr" ? "5106" : key === "onAnotherRemoteBranch" ? "origin/x" : true;
      assert.deepEqual(
        removalVerdict({ ...base, [key]: value }),
        { ok: true },
        `${key} alone must clear the removal — each is a sufficient proof on its own`,
      );
    }
    // 🔴 THE ROLL-UP MEMBER, which is the case the third signal exists for: it landed CLOSED, so no
    // merged PR carries its head and its patch-id is inside a larger squash — only the file
    // comparison can answer, and without it the gate refuses a worktree that is safe to retire.
    assert.deepEqual(
      removalVerdict({ ...base, filesIdenticalOnMain: true }),
      { ok: true },
      "a roll-up member must be retirable on file content alone",
    );
    // Nothing unpushed is cleared without consulting a safety signal at all.
    assert.deepEqual(removalVerdict({ ...base, unpushed: "" }), { ok: true });
    // A missing/garbage argument must not throw inside the gate; it reads as nothing unpushed.
    assert.deepEqual(removalVerdict(undefined as never), { ok: true });
  }

  // ── 4. The script actually uses them, and the misleading advice is gone ─────────────────────
  {
    const source = read("scripts/new-session.mjs");
    assert.match(source, /from "\.\/lib\/remove-gate\.mjs"/, "the gate must import the shared decision");
    assert.match(source, /pickMergedPrForTip\(rows, headSha\(dir\)\)/, "and pick the merged PR by this tip's sha");
    assert.match(source, /"number,headRefOid"/, "which means asking gh for headRefOid, not only number");
    assert.match(source, /verdict\.reason === "open-pr"/, "the open-PR refusal must be wired to the decision");
    assert.match(source, /verdict\.reason === "stranded"/, "and so must the stranded refusal");

    // The condition must no longer be assembled inline, or the fixtures above pin a copy nobody runs.
    assert.doesNotMatch(
      source,
      /if \(unpushed && !pushed && !mergedPr/,
      "the inline refusal condition must be gone — two copies of a precedence rule is how they drift",
    );

    // 🔴 The advice printed after a removal was itself the defect: it sent the reader to the
    // name-based query. A test for the fix has to cover the words, because the words are what the
    // next session follows.
    const advice = source.slice(source.indexOf("still exists locally"), source.indexOf("still exists locally") + 900);
    assert.ok(advice.length > 100, "could not isolate the post-removal advice — this pin is measuring nothing");
    assert.match(advice, /headRefOid/, "the advice must tell the reader to compare the merged PR's head sha");
    assert.match(advice, /--state open/, "and to check for an open PR");
    assert.match(advice, /byte-identical/, "and to compare file content, for the roll-up-member case");
    assert.doesNotMatch(
      advice,
      /Delete it only once `gh pr list --head/,
      "the old name-based instruction must be gone — it is the exact query that vouched for #3588",
    );

    // 🔴 THE SHA MUST BE READ BEFORE THE FOLDER GOES. It is the one part of that advice the reader
    // cannot look up from the message, and `headSha(dir)` asks git with `cwd: dir` — so called
    // AFTER `worktree remove` it throws and returns its "HEAD" fallback, which printed as the
    // literal word: "its headRefOid equal to HEAD". Observed on the first real run of this advice,
    // retiring `_wt-banner-behind-main` on 2026-10-02. The fallback is right for its other caller
    // (the rescue command, printed while the folder still exists), so what was wrong is the timing.
    // The PROPERTY, not the adjacency: the advice interpolates the tip captured earlier, and never
    // re-asks git. Pinning the exact `" + retiredTip` spacing broke the moment a null fallback was
    // added between them, which is a test measuring its own formatting rather than the rule.
    assert.match(advice, /headRefOid equal to /, "the advice must still name what to compare");
    assert.match(advice, /retiredTip/, "and interpolate the tip captured earlier");
    assert.doesNotMatch(advice, /headSha\(dir\)/, "and must never ask git in a folder that has already been removed");
    const capture = source.indexOf("const retiredTip");
    const removal = source.indexOf('git(["worktree", "remove", dir])');
    assert.ok(capture !== -1 && removal !== -1, "could not locate the capture and the removal — this pin measures nothing");
    assert.ok(
      capture < removal,
      "the tip must be captured BEFORE `worktree remove`, or the advice names the fallback instead of a sha",
    );
  }

  // ── 5. A FAILED READ MUST NOT PASS FOR A SHA, ANYWHERE ──────────────────────────────────────
  //
  // `headSha` used to fall back to the string `"HEAD"` — a value that reads as a sha, prints as a
  // sha and is not one. #5119 fixed the one call site that printed it; this removes the class, so
  // the next caller to ask at a moment git cannot answer cannot be handed plausible nonsense.
  {
    const source = read("scripts/new-session.mjs");
    const fn = source.slice(source.indexOf("function headSha"), source.indexOf("function shortSha"));
    assert.ok(fn.length > 50, "could not isolate headSha — this pin is measuring nothing");
    assert.doesNotMatch(fn, /return "HEAD"/, "the string fallback must be gone — it is the whole defect");
    assert.match(fn, /return null/, "a failed read answers null");
    assert.match(
      fn,
      /isShaLike\(sha\)/,
      "and a truthy-but-not-a-sha answer is null too — the point is that nothing may look ok and not be",
    );

    // THE PREDICATE ITSELF, exercised. `headSha` is module-private and its file runs a CLI at
    // import, so the shape test lives in `remove-gate.mjs` where a fixture can reach it — the half
    // the defect actually turned on.
    assert.equal(isShaLike("HEAD"), false, "the exact string the old fallback returned must not pass for a sha");
    assert.equal(isShaLike("90f883597"), true, "a short sha is legitimate — rev-parse --short emits one");
    assert.equal(isShaLike("90f883597b9a7de986346712dbd41eafd56fc4f3"), true, "and so is the full form");
    assert.equal(isShaLike("DEADBEEF"), false, "uppercase is refused: git emits lowercase, words-that-look-like-hex do not");
    for (const bad of ["", "abc", "zzzzzzz", "not a sha", "  90f883597  ", null, undefined, 42, {}]) {
      assert.equal(isShaLike(bad as never), false, `${JSON.stringify(bad)} must not pass for a sha`);
    }

    // EVERY caller must handle it. A null reaching `.slice()` throws inside a cleanup command, which
    // is a worse failure than the wrong word it replaced.
    assert.doesNotMatch(source, /headSha\(dir\)\.slice\(/, "no caller may call .slice() straight on a possibly-null sha");

    // The advice: a reader who gets no sha must still get something runnable, and the branch is
    // right there at that moment, so this is never a dead end.
    assert.match(source, /retiredTip \?\?/, "the advice must have a fallback for an unreadable tip");
    assert.match(source, /git rev-parse " \+ entry\.branch/, "and it must be a command that still answers");

    // The detached-HEAD rescue: with no branch name AND no sha there is nothing to name, so it says
    // so rather than printing `git branch rescue/detached-null null`.
    assert.match(source, /detached && detachedSha === null/, "the rescue must handle an unreadable detached tip");
    assert.match(source, /rev-parse HEAD/, "and point the reader at the folder, which still exists there");
  }

  console.log("worktree remove head-sha gate: OK");
}
