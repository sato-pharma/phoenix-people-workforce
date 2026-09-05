import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { offerStages } from "../src/lib/recruitment/offer-rules.ts";
import { applicationStages, terminalApplicationStages } from "../src/lib/recruitment/types.ts";

/**
 * A pipeline stage a person cannot leave is a dead end, and it looks exactly like low adoption.
 *
 * ── THIS TEST SHIPPED WRONG AND WAS CORRECTED THE SAME DAY, 2026-09-05 ────────────────────────
 *
 * The first version claimed TEN stages had no way forward — the whole offer chain plus
 * pre_boarding — and concluded that 0 offers and 0 hires were a dead end rather than adoption.
 * That was false, and the mistake is kept written down because it is subtle and cheap to repeat.
 *
 * It searched the components for the registry ACTION KEYS (`app_offer_accept`,
 * `app_to_pre_boarding`, …) and found none. But the UI does not use action keys: it posts an
 * INTENT to `/api/recruitment/applications/[id]/offer` — `save_draft`, `submit_approval`,
 * `approve`, `reject_approval`, `mark_sent`, `record_response` — and the route maps those onto the
 * service. The offer chain has had a complete UI all along: `OfferCard`, rendered whenever
 * `isOfferStage(stage)` holds, plus a "Mark as hired" card on `offer_accepted`, `offer_initiated`
 * and `pre_boarding`.
 *
 * MEASURING THE WRONG SIGNAL AND FINDING ZERO LOOKS EXACTLY LIKE MEASURING THE RIGHT ONE AND
 * FINDING A GAP. Both produce an empty result and a confident conclusion. The guard is the
 * positive control below: if a coverage source stops being parseable, every stage reads as
 * uncovered — which is precisely how the first version talked itself into a ten-stage dead end.
 *
 * ── WHAT THIS TEST IS FOR ─────────────────────────────────────────────────────────────────────
 *
 * Every non-terminal stage must be covered by one of the four sources the workspace actually uses.
 * A stage added to `applicationStages` with no control anywhere fails here, rather than becoming a
 * quiet dead end that reads as nobody being interested.
 */
export function runRecruitmentEveryStageHasAWayForwardTests() {
  const workspace = readFileSync("src/components/recruitment/recruitment-workspace.tsx", "utf8");

  // ── sources 1 and 2: the two stage → action maps, parsed out of the workspace ───────────────
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

  // ── source 3: stages with a dedicated card instead of a map entry ───────────────────────────
  const DEDICATED_CARD_STAGES = ["cv_screening", "phone_screening", "hiring_manager_interview", "final_selection"];
  for (const stage of DEDICATED_CARD_STAGES) {
    assert.ok(workspace.includes(stage), `${stage} claims a dedicated card but is absent from the workspace`);
  }

  // ── source 4: the offer panel, and the hire card behind it ──────────────────────────────────
  //
  // OfferCard is gated on isOfferStage, so its coverage IS offerStages — imported rather than
  // restated here, so widening that rule widens this test with it.
  assert.match(
    workspace,
    /isOfferStage\(selected\.stage\) \? \(\s*<OfferCard/,
    "OfferCard must be rendered for every offer stage - it is the only control the offer chain has",
  );
  const HIRE_CARD_STAGES = ["offer_accepted", "offer_initiated", "pre_boarding"];
  for (const stage of HIRE_CARD_STAGES) {
    assert.ok(
      workspace.includes(`selected.stage === "${stage}"`),
      `the "Mark as hired" card must render on ${stage}; without it an accepted offer cannot become a hire`,
    );
  }

  const covered = new Set<string>([...declared, ...DEDICATED_CARD_STAGES, ...offerStages, ...HIRE_CARD_STAGES]);

  // ── the one stage with no control, and the reason it needs none ─────────────────────────────
  //
  // `application_received` is transient by construction: applications.ts creates the row at that
  // stage and immediately runs `app_add` to move it to in_candidate_pool within the same call. No
  // application has ever been observed sitting there, and none can be selected in it.
  const TRANSIENT_BY_CONSTRUCTION = ["application_received"];
  assert.match(
    readFileSync("src/lib/recruitment/applications.ts", "utf8"),
    /stage: "application_received"[\s\S]{0,2000}runApplicationTransition\([^)]*"app_add"/,
    "application_received is exempt only because creation moves straight on from it - if that stops "
      + "being true it needs a control like every other stage",
  );

  const terminal = new Set<string>(terminalApplicationStages);
  const uncovered = applicationStages.filter(
    (stage) => !terminal.has(stage) && !covered.has(stage) && !TRANSIENT_BY_CONSTRUCTION.includes(stage),
  );

  // THE POSITIVE CONTROL. If a coverage source stops being readable, every stage reads as
  // uncovered — exactly how the first version of this test invented a ten-stage dead end.
  assert.ok(
    covered.size >= 20,
    `only ${covered.size} stages resolved as covered; a coverage source has stopped being readable and `
      + "this test is about to report a gap that is not there",
  );

  assert.deepEqual(
    uncovered,
    [],
    "these application stages have no control in the workspace. A stage a person cannot leave is a "
      + "dead end that reads as low adoption - add a control, or, if it is transient like "
      + `application_received, exempt it with the code that proves it:\n${uncovered.join("\n")}`,
  );
}
