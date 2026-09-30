import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — no save bar takes two presses to discard.
 *
 * Owner, 2026-09-30, twice in one sitting: "make Discard changes one press on the plan board", then
 * "make Discard changes one press on the Settings tab too".
 *
 * Both bars used to set a `discarding` flag and wait for a second press, and that is how the control
 * came to look broken rather than merely slow: one press changed the bar's WORDING and left every tick
 * (or every box) exactly where it was. That reads as a button that did nothing — it is what was first
 * reported against the plan board as a state bug, with the database untouched and a reload "fixing" it.
 *
 * What this pins, on each bar:
 *   - the press calls the discard itself, with no confirm flag in between;
 *   - the retired second step is gone — its question and its "Keep them" escape;
 *   - the sentence that step used to carry is said BEFORE the press instead, since there is no later
 *     step left to say it in;
 *   - the button keeps the `danger` variant the confirm's own button wore, because the single press IS
 *     the destructive act now.
 *
 * It is one file for both bars deliberately: the rule is about every CRM save bar, and a rule pinned
 * per-surface is the shape that lets the next bar be built with a confirm nobody notices.
 */

/** The two save bars this rule governs, and the discard each one's button must call. */
const BARS: ReadonlyArray<{ file: string; discard: string; warning: string }> = [
  {
    file: "src/components/phoenix-crm/plan-board.tsx",
    discard: "onDiscard",
    warning: "Discard changes puts each week back to what was last saved.",
  },
  {
    file: "src/components/phoenix-crm/settings-tab.tsx",
    discard: "discardNumbers",
    warning: "Discard changes puts every box back to what was last saved.",
  },
];

export function runPhoenixCrmDiscardOnePressTests(): void {
  for (const bar of BARS) {
    const source = stripComments(readFileSync(bar.file, "utf8"));
    const name = bar.file.split("/").pop();

    // The press discards. Nothing stands between the click and the act.
    assert.ok(
      source.includes(`onClick={${bar.discard}}`),
      `${name}: the Discard changes button must call ${bar.discard} on the press itself — a second press is what made this control read as broken`,
    );
    assert.doesNotMatch(source, /setDiscarding/, `${name}: no confirm flag may stand between the press and the discard`);
    assert.doesNotMatch(source, /Discard your (unsaved ticks|changes to the numbers)/, `${name}: the retired second step's question stays gone`);
    assert.doesNotMatch(source, /Keep them/, `${name}: and so does the button that cancelled it`);

    // With no second step to warn in, the bar says what the press will do before it is pressed.
    assert.ok(source.includes(bar.warning), `${name}: the warning the confirm used to carry must be said ahead of the press — "${bar.warning}"`);

    // And the single press is marked destructive, the way the confirm's own Discard was.
    assert.match(
      source,
      new RegExp(`<CrmButton disabled=\\{locked\\} onClick=\\{${bar.discard}\\} variant="danger">`),
      `${name}: the one press keeps the danger variant, since it is the destructive act now`,
    );

    // A bar that still branched on a confirm would carry TWO discard buttons, one per branch. Counting
    // the button form only, never the bare words — "Discard changes" is also inside the warning above.
    assert.equal(
      (source.match(/Discard changes\s*<\/CrmButton>/g) ?? []).length,
      1,
      `${name}: exactly one button is labelled Discard changes — a second means a confirm branch survived`,
    );
  }
}
