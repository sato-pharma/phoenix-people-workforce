import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The validation screen is a form of steps (owner, 2026-10-14): one thing at a time, in the order the rep
 * does it, with Next to the one after. It wears the same step form as Add visit and the weekly plan.
 *
 * Source-reading, with single-line anchors only: a `\n` inside an anchor is red on a CRLF working tree
 * and green on CI.
 */
export function runPhoenixCrmValidateStepsTests() {
  const screens = stripComments(readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8"));
  const start = screens.indexOf("export function ValidateScreen(");
  const end = screens.indexOf("function knownSpecialities(");
  assert.ok(start > 0 && end > start, "the validate screen is found");
  const validate = screens.slice(start, end);

  // ── One step form, six steps, never the long page ──────────────────────────────────────────────
  assert.ok(validate.includes("<CrmStepForm"), "the validate screen wears the shared step form");
  assert.equal((validate.match(/\{ label: "/g) ?? []).length, 8, "six steps are named, the polyclinic and clinic doors each naming their own third and fourth");
  for (const label of ["Customer", "Where", "Building", "Signboard", "Timetable", "Location", "Hours", "Save"]) {
    assert.ok(validate.includes(`label: "${label}"`), `the rail names the ${label} step`);
  }
  assert.ok(!validate.includes("<SaveBar"), "the old one-page Save bar is gone from the validate screen");
  assert.ok(!validate.includes('firstStep={subject.mode === "new" ? 2 : 1}'), "no editor numbers itself down a long page any more");

  // ── Next waits for the step's own answer; the rail never skips an unanswered step ──────────────
  assert.ok(validate.includes("<CrmStepNext disabled={gap !== null || venueAdding}"), "Next is held until the step is answered");
  assert.ok(validate.includes("const reach = [1, 2, 3, 4, 5].find((at) => stepGap(at) !== null) ?? 6;"), "the furthest step is the first unanswered one");
  assert.ok(validate.includes("canJump={(at) => !venueAdding && !saving && at <= reach}"), "the rail opens only the answered steps, and not while a building is being captured");
  assert.ok(validate.includes("const owner = !draft.photo ? 3 : !draft.pin ? 4 : 5;"), "a missing clinic photo holds step 3, a missing pin step 4, the hours step 5");

  // ── A tap on the door IS the answer; the last step saves ──────────────────────────────────────
  const chooseDoor = /function chooseDoor\([^)]*\) \{([\s\S]*?)\n  \}/.exec(validate);
  assert.ok(chooseDoor, "the door has its own handler");
  assert.ok(chooseDoor[1].includes("goStep(3);"), "choosing the door moves him on to step 3");
  assert.ok(validate.includes("className={crmStepFinishClassName}"), "the last step ends in the step form's finishing button");
  assert.ok(validate.includes("onClick={() => void save(false)}"), "and that button is what saves");
  assert.ok(validate.includes('goStep(door === "shared" ? 4 : 3);'), "a refused photo sends him back to the step that retakes it");

  // ── The shared editors draw one piece at a time, and print no number of their own there ───────
  const place = stripComments(readFileSync("src/components/phoenix-crm/place-editor.tsx", "utf8"));
  assert.ok(place.includes('export type PlaceEditorPart = "photo" | "pin" | "timings" | "details";'), "the clinic editor names its pieces");
  for (const drawn of ['capture && shows("photo")', 'capture && shows("pin")', '{shows("timings") ? (', '{shows("details") ? (', '{shows("pin") ? (']) {
    assert.ok(place.includes(drawn), `the clinic editor draws its piece only when asked: ${drawn}`);
  }
  const seated = stripComments(readFileSync("src/components/phoenix-crm/shared-place-screens.tsx", "utf8"));
  assert.ok(seated.includes('export type SharedPlaceEditorPart = "venue" | "photo" | "timings" | "details";'), "the polyclinic editor names its pieces");
  for (const piece of ["venue", "photo", "timings", "details"]) {
    assert.ok(seated.includes(`shows("${piece}")`), `the polyclinic editor can draw just the ${piece} piece`);
  }
  assert.ok(seated.includes("onAddingChange?.(adding);"), "the polyclinic editor tells the form while the building capture is open");
  assert.ok(validate.includes("<CrmUntitledBlocks>{body}</CrmUntitledBlocks>"), "the steps print no numbered block titles under their own heading");
  const ui = stripComments(readFileSync("src/components/phoenix-crm/ui.tsx", "utf8"));
  assert.ok(ui.includes("const shownTitle = untitled ? undefined : title;"), "a block inside a step leaves its title off");

  console.log("phoenix-crm validate steps: OK");
}
