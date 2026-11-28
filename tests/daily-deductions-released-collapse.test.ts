import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * "RELEASED TO EMPLOYEES" FOLDS AWAY AND OPENS AGAIN (owner, 2026-11-28: "make the withdrawn list
 * collapsible and expandable" — the released list, where every row carries a Withdraw button).
 *
 * Pins: the list starts OPEN (the screen reads as before until it is folded); one header button flips
 * it, says Collapse or Expand, and tells assistive tech through aria-expanded / aria-controls; folding
 * hides the list's body and nothing else; and "Withdraw all" leaves the header while the list it would
 * act on is folded away, so the bulk withdraw is never pressed blind.
 */
export async function runDailyDeductionsReleasedCollapseTests(): Promise<void> {
  const workspace = stripComments(
    readFileSync(new URL("../src/components/admin/daily-deductions-workspace.tsx", import.meta.url), "utf8"),
  );

  assert.match(
    workspace,
    /const \[releasedListOpen, setReleasedListOpen\] = useState\(true\);/,
    "the released list starts open",
  );
  assert.match(
    workspace,
    /onClick=\{\(\) => setReleasedListOpen\(\(open\) => !open\)\}/,
    "one header button flips the released list",
  );
  assert.match(workspace, /aria-expanded=\{releasedListOpen\}/, "the button reports its state");
  assert.match(workspace, /aria-controls="daily-deductions-released-list"/, "the button names the list it folds");
  assert.match(
    workspace,
    /\{releasedListOpen \? "Collapse" : "Expand"\}/,
    "the button says Collapse when open and Expand when folded",
  );
  assert.match(
    workspace,
    /<div className="space-y-3 p-4" hidden=\{!releasedListOpen\} id="daily-deductions-released-list">/,
    "folding hides the released list's body",
  );
  assert.match(
    workspace,
    /\{canPublish && active && !filtersOn && releasedListOpen \? \(/,
    "Withdraw all is not offered while the list is folded",
  );
}
