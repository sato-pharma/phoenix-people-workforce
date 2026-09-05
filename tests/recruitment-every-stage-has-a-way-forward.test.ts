import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { applicationStages, terminalApplicationStages } from "../src/lib/recruitment/types.ts";

/**
 * A pipeline stage a person cannot leave is a dead end, and it looks exactly like low adoption.
 *
 * ── WHAT THIS FOUND ───────────────────────────────────────────────────────────────────────────
 *
 * Measured on production 2026-09-05: 745 candidates, 14 applications, 1 interview, 0 offers,
 * 0 hires. The plan called the offer work "mostly wiring" and read the zeros as adoption.
 *
 * They are not adoption. The offer chain is COMPLETE on the server —  saveOfferDraft,
 * submitOfferForApproval, decideOfferApproval, markOfferSent, recordOfferResponse — and has NO UI
 * at all. `app_select` moves an application INTO `offer_initiated`, and from there
 * `app_offer_extend`, `app_offer_accept`, `app_offer_decline` and `app_to_pre_boarding` have
 * ZERO references in the recruitment components. Whoever pressed "select for offer" first would
 * have reached a screen with no next step and no way back except rejection.
 *
 * That is why nobody has: the furthest any of the 14 applications ever reached is `hr_interview`.
 *
 * ── WHY A TEST AND NOT JUST A FIX ─────────────────────────────────────────────────────────────
 *
 * The gap is TEN stages wide of 28 - measured, not estimated: 5 are terminal, 9 are reachable
 * through the workspace's two stage maps, 4 through dedicated cards, and 10 have nothing. Nine of
 * those ten are the offer chain end to end. Closing it is a UI build, not an edit, so recording it
 * as a counted list means the next session cannot mistake the zeros for disinterest again, and
 * cannot add an ELEVENTH without this going red. The list may shrink; it may never grow.
 */
export function runRecruitmentEveryStageHasAWayForwardTests() {
  const workspace = readFileSync("src/components/recruitment/recruitment-workspace.tsx", "utf8");

  // Stages the workspace can move forward through its two declared maps. Read out of the source
  // rather than restated here, so editing the map moves this test with it.
  const declared = new Set<string>();
  const nextStageBlock = workspace.slice(
    workspace.indexOf("const nextStageAction:"),
    workspace.indexOf("const holdingStageActions:"),
  );
  const holdingBlock = workspace.slice(
    workspace.indexOf("const holdingStageActions:"),
    workspace.indexOf("const rejectableStages"),
  );
  assert.ok(nextStageBlock.length > 0 && holdingBlock.length > 0, "the workspace's stage maps must be findable");
  for (const block of [nextStageBlock, holdingBlock]) {
    for (const match of block.matchAll(/^\s{2}(\w+):/gm)) declared.add(match[1]);
  }

  // Stages the workspace handles with a dedicated card instead of a map entry. Named in the
  // source's own comment above nextStageAction; kept in step with it by the assertion below.
  const DEDICATED_CARD_STAGES = [
    "cv_screening",
    "phone_screening",
    "hiring_manager_interview",
    "final_selection",
  ];
  for (const stage of DEDICATED_CARD_STAGES) {
    assert.ok(
      workspace.includes(stage),
      `${stage} is claimed to have a dedicated card but does not appear in the workspace at all`,
    );
  }

  // ── THE RECORDED GAP ────────────────────────────────────────────────────────────────────────
  //
  // Ten stages with no forward control anywhere in the recruitment UI. Listed rather than hidden,
  // with the server function that already exists for each, because the work is to BUILD the
  // controls and this is the specification for it.
  const NO_FORWARD_CONTROL_YET: Record<string, string> = {
    application_received: "app_add exists; nothing in the workspace offers it",
    offer_initiated: "saveOfferDraft / submitOfferForApproval exist server-side",
    offer_draft: "submitOfferForApproval exists server-side",
    offer_pending_approval: "decideOfferApproval exists server-side",
    offer_approved: "markOfferSent exists server-side",
    offer_generated: "markOfferSent exists server-side",
    offer_sent: "recordOfferResponse exists server-side",
    offer_accepted: "app_to_pre_boarding is in the transition map; no button calls it",
    offer_negotiation: "app_offer_negotiation is referenced; no forward path out of it",
    pre_boarding: "markApplicationHired exists and is reachable only via the convert route",
  };

  const terminal = new Set<string>(terminalApplicationStages);
  const unreachable: string[] = [];
  for (const stage of applicationStages) {
    if (terminal.has(stage)) continue;
    if (declared.has(stage)) continue;
    if (DEDICATED_CARD_STAGES.includes(stage)) continue;
    unreachable.push(stage);
  }

  // A positive control: if the maps stop being parseable, every stage reads as unreachable and the
  // recorded list would silently look complete.
  assert.ok(
    declared.size >= 8,
    `only ${declared.size} stages parsed out of the workspace's maps; the parse has broken and this `
      + "test is measuring nothing",
  );

  const unexpected = unreachable.filter((stage) => !(stage in NO_FORWARD_CONTROL_YET));
  assert.deepEqual(
    unexpected,
    [],
    "these application stages have no way forward in the UI and are not recorded as known gaps. A "
      + "stage a person cannot leave is a dead end that reads as low adoption - add a control, or "
      + `record it in NO_FORWARD_CONTROL_YET with the server function that already exists:\n${unexpected.join("\n")}`,
  );

  const recordedButNowReachable = Object.keys(NO_FORWARD_CONTROL_YET).filter(
    (stage) => !unreachable.includes(stage),
  );
  assert.deepEqual(
    recordedButNowReachable,
    [],
    "these stages now HAVE a forward control and must be removed from NO_FORWARD_CONTROL_YET, so the "
      + `gap is never reported as wider than it is:\n${recordedButNowReachable.join("\n")}`,
  );
}
