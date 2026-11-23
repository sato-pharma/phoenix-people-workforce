// Pins src/lib/recruitment/workspace/answer-place-options.ts and its wiring — the region and area
// answers are CHOSEN from the company's list on the workspace table, and a save that leaves the CV in
// Needs placing says why.
//
// Why each case matters (Talent Acquisition, 24 Nov 2026: "she does Needs placing but the count does
// not decrease"):
//   * Her typed areas — "kom hamada", "El snebllawein , Aga , meet ghamr" — are not company areas, so
//     the save answered "Saved" and filed nobody; the count never fell. The area list is the company's
//     active areas, by their canonical NAME (what `resolveAuArea` matches), each named with its region.
//   * The region list is all eight recruitment regions by CODE, so "Behiera 1" typed in the region box
//     can no longer be stored as words with no code.
//   * `placingGap` names the one thing still missing, and says nothing once the person is placed.
//   * The table really is handed the lists, and the answer route really returns the note.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateRegionCodes } from "../src/lib/recruitment/candidate-region.ts";
import { PLACING_ANSWER_KEYS, placeAnswerOptions, placingGap } from "../src/lib/recruitment/workspace/answer-place-options.ts";

export function runRecruitmentAnswerPlaceOptionsTests() {
  // ── The two lists ──
  const options = placeAnswerOptions({
    regions: [
      {
        areas: [
          { code: "AB4", name: "Behira 1", vacantSeats: 1 },
          { code: "AB5", name: "Behira 2", vacantSeats: 0 },
        ],
        code: "AB",
        name: "Alex-BHR",
        vacantSeats: 1,
      },
      { areas: [{ code: "CA3", name: "Cairo West", vacantSeats: 0 }], code: "CA", name: "Cairo", vacantSeats: 0 },
    ],
  });
  assert.deepEqual(
    options.region.map((option) => option.value),
    [...candidateRegionCodes],
    "every recruitment region is choosable, by its code",
  );
  assert.equal(options.region.find((option) => option.value === "AB")?.label, "Alex-BHR", "a region reads by the company's own name");
  assert.deepEqual(
    options.area,
    [
      { label: "Behira 1 · Alex-BHR", value: "Behira 1" },
      { label: "Behira 2 · Alex-BHR", value: "Behira 2" },
      { label: "Cairo West · Cairo", value: "Cairo West" },
    ],
    "every company area, saved by its canonical name and shown with its region",
  );
  assert.deepEqual(placeAnswerOptions(null).area, [], "no places read: no area list (the cell stays as it was)");
  assert.equal(placeAnswerOptions(null).region.length, candidateRegionCodes.length, "the regions never depend on a read");

  // ── Why a save left the CV in Needs placing ──
  const rep = { regionCode: null, regionWords: null, roleFamily: "medical_rep" } as const;
  assert.match(
    placingGap({ ...rep, areaKnown: false, areaName: "kom hamada", placed: false }) ?? "",
    /“kom hamada” is not one of the company's areas/,
    "a typed area that is no company area is named back",
  );
  assert.match(
    placingGap({ ...rep, areaKnown: false, areaName: null, placed: false, regionCode: "AB" }) ?? "",
    /a Medical Rep needs an area as well/,
    "a Medical Rep with a region and no area is told the area is missing",
  );
  assert.equal(placingGap({ ...rep, areaKnown: true, areaName: "Behira 1", placed: true }), null, "placed: nothing to say");
  assert.match(
    placingGap({ areaKnown: false, areaName: null, placed: false, regionCode: null, regionWords: "Behiera 1", roleFamily: "district_manager" }) ?? "",
    /“Behiera 1” is not one of the regions/,
    "a District Manager's typed region is named back",
  );
  assert.match(
    placingGap({ areaKnown: false, areaName: null, placed: false, regionCode: null, roleFamily: null }) ?? "",
    /choose what they are applying for/,
    "no role: the role comes first",
  );
  assert.equal(
    placingGap({ areaKnown: false, areaName: null, placed: false, regionCode: null, roleFamily: "product_manager" }),
    null,
    "a role that files with the role alone has no gap to name",
  );
  assert.deepEqual([...PLACING_ANSWER_KEYS], ["job_title", "region", "area"], "the three answers that file a person");

  // ── The wiring ──
  const workspace = readFileSync("src/components/recruitment/workspace/role-workspace.tsx", "utf8");
  assert.match(workspace, /out\.region = props\.placeOptions\.region/, "the region cell is handed the region list");
  assert.match(workspace, /out\.area = props\.placeOptions\.area/, "the area cell is handed the area list");
  const page = readFileSync("app/(admin)/recruitment/page.tsx", "utf8");
  assert.match(page, /placeAnswerOptions\(await loadWorkspacePlaces\("medical_rep"\)\)/, "the page reads the company's areas for the lists");
  assert.match(page, /placeOptions=\{placeOptions\?\.ok \? placeOptions\.value : null\}/, "and hands them to the workspace");
  const route = readFileSync("app/api/recruitment/candidates/[id]/whatsapp-answer/route.ts", "utf8");
  assert.match(route, /placingGapAfterAnswer\(candidateId\)/, "the answer route says whether the save placed the person");
  assert.match(route, /NextResponse\.json\(\{ candidate, placing, success: true \}\)/, "and returns it");
  const actions = readFileSync("src/components/recruitment/workspace/use-workspace-actions.ts", "utf8");
  assert.match(actions, /stillNeeds \? `\. \$\{stillNeeds\}`/, "the save's message carries the reason");
}
