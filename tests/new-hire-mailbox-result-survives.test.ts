/**
 * A mailbox run's own account must survive the run.
 *
 * ## The measurement this exists for
 *
 * Production, 2026-10-03, 23:02:13 Cairo. A live invite-inbox adoption failed. `router.refresh()`
 * fired on the non-dry path, the card came back remounted with `result` at its initial `null`, and
 * the sentence naming what had stopped the run was gone from the screen before anyone read it. The
 * audit row for that same run held `adopted: false, refusal: null` and nothing else, so the
 * diagnostic existed nowhere at all. The run cannot simply be repeated: three live runs an hour.
 *
 * It is worse on the happy path. `handover` is what the employee has to be told, and for a new hire
 * the company password becomes their real password — so a refresh on success can erase a credential
 * that is not recoverable from that screen. On the adopt card a `locked_out` outcome is the same
 * shape: the password is already reset and the hand-over is the only thing between that person and
 * a mailbox they cannot open.
 *
 * What the refresh bought was a pending-queue list being one click fresher. The trade was always
 * the wrong way round.
 *
 * 🔴 ASSERTED ON COMMENT-STRIPPED SOURCE, AND HERE THAT IS LOAD-BEARING RATHER THAN HYGIENE. The
 * comments that explain the removal name `router.refresh()` in both files, so this guard read
 * against raw source would fail on the very prose documenting the fix. That direction is a false
 * ALARM rather than a false pass — but it would make the suite unfixable without deleting the
 * explanation, which is how the explanation gets deleted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

const CARDS = [
  "src/components/new-hire-mailbox/invite-inbox-card.tsx",
  "src/components/new-hire-mailbox/adopt-mailbox-card.tsx",
];

function runResultSurvivesCases(): void {
  const root = new URL("../", import.meta.url);

  for (const path of CARDS) {
    const raw = readFileSync(new URL(path, root), "utf8");
    const code = stripComments(raw).replace(/\s+/g, " ");

    // The baseline first: if the strip ate the component, every assertion below passes for the
    // wrong reason. `tests/no-unsafe-comment-stripping.test.ts` guards the helper itself; this
    // guards THIS read of THIS file.
    assert.match(
      code, /setResult\(payload\.result \?\? null\)/,
      `${path}: the stripped source no longer contains the result assignment, so this test is `
      + "reading the wrong text — fix the test before trusting it",
    );

    assert.equal(
      /router\s*\.\s*refresh/.test(code), false,
      `${path}: must not refresh the route after a run — it remounts this card and erases the `
      + "result, which on a failure is the only account of what stopped it and on a success is the "
      + "hand-over sentence the employee has to be told (measured on production 2026-10-03)",
    );
    assert.equal(
      /useRouter/.test(code), false,
      `${path}: the router is no longer used, and leaving the hook in invites the refresh back`,
    );

    // And the run's account must still be RENDERED — removing the refresh is pointless if the
    // thing it was erasing is not on screen in the first place.
    //
    // 🔴 MATCHED AS A BRACED JSX CHILD, `{result.handover}`, NOT AS THE BARE PROPERTY. Written the
    // loose way first, and both breaks that delete the render went GREEN: each value is read twice
    // in these files — once as the `x.handover ?` guard and once as the child it guards — so a
    // pattern that accepts the bare property is satisfied by the CONDITION while nothing is drawn.
    // Same family as asserting an object key and calling it a pin.
    assert.match(
      code, /\{(result|outcome)\.handover\}/,
      `${path}: the hand-over sentence must still be rendered — it is what the person is told, and `
      + "for a new hire it carries the password that becomes their real one",
    );
    assert.match(
      code, /\{(result|outcome)\.detail\}/,
      `${path}: the reason must still be rendered — it is what a failed run leaves behind, and the `
      + "audit row holds nothing but adopted:false without it",
    );
  }
}

export async function runNewHireMailboxResultSurvivesTests(): Promise<void> {
  runResultSurvivesCases();
}
