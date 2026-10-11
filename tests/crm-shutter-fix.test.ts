import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// THE CRM VISIT PHOTO TAKES ITS OWN GPS READING (owner, 2026-09-29, asked directly and answered
// "Both" when the alternative was leaving the camera alone).
//
// Phoenix CRM already had the strongest capture design in the app and never had the copied-fix
// defect #4781 removed elsewhere. What it could not answer is whether the camera was still where
// the pin said when the shutter fired, because the visit stored ONE position. Now it stores two.
//
// GOLDEN RULE #1 GOVERNS THIS, and most of what is pinned below is the rule, not the feature:
// nothing new is asked of the rep, nothing is refused, no warning exists, and a missing reading
// never costs him a visit. The four ways this could go wrong are all silent ones:
//
//   1. killing the watch BEFORE reading it, which makes the fix null on every single capture
//      while everything still compiles, passes and saves;
//   2. holding the fix in component state, where a retake lets the discarded photo's reading
//      attach itself to the new one;
//   3. defaulting the photo fix to the pin when it is absent — the exact defect #4781 removed,
//      and downstream indistinguishable from a real second reading; and
//   4. refusing or warning the rep when the shutter reads nothing.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function runCameraTests() {
  const camera = read("../src/components/phoenix-crm/live-photo-capture.tsx");

  assert.ok(
    camera.includes('from "@/lib/evidence/read-shutter-fix"'),
    "the CRM camera must use the SHARED reader, not a private copy that can drift from the others",
  );
  assert.ok(
    camera.includes("const shutterFix = await readShutterFix();"),
    "the shutter must take its own reading",
  );

  // 1. THE ORDERING BUG. stopLocation() ends the watch the reading comes from. If it runs first,
  //    every capture records null and nothing anywhere complains — the quietest possible failure.
  const readIndex = camera.indexOf("const shutterFix = await readShutterFix();");
  const stopIndex = camera.indexOf("stopLocation();", camera.indexOf("async function takePhoto"));
  assert.ok(readIndex > -1 && stopIndex > -1, "could not locate the shutter read and the watch stop");
  assert.ok(
    readIndex < stopIndex,
    "the shutter fix must be read BEFORE the watch is stopped, or it is null on every capture",
  );

  // 2. It rides on the Shot. A retake replaces the whole Shot; component state would not be
  //    replaced, so a discarded photo's reading could attach itself to the new one.
  assert.ok(
    camera.includes("shutterFix: ShutterFix;"),
    "the fix must travel on the Shot, so a retake cannot carry the old one forward",
  );
  assert.ok(
    camera.includes("shutterLat: working.shutterFix.latitude,"),
    "the upload must read the fix off the shot it is uploading",
  );

  // 4. NOTHING REP-FACING. No refusal, no warning, no wording that a second reading exists.
  // The risk is a REFUSAL BRANCH on the fix — `if (shutterFix.latitude === null) { setError(...) }`
  // or an early return. Scanning for setError near the word "shutter" is too blunt: the upload's
  // own catch legitimately sits a few lines below the payload that names these fields.
  assert.ok(
    !/if\s*\(!?\s*shutterFix[\s\S]{0,200}(setError|setStage\("failed"\)|return)/.test(camera),
    "a missing shutter reading must never refuse, fail or short-circuit the capture",
  );
  assert.ok(
    !/shutterFix\.latitude === null[\s\S]{0,120}(setError|throw)/.test(camera),
    "a null shutter fix is normal — it must not be treated as an error condition",
  );
  assert.ok(
    !/Photo carries no location|could not read a position|location check/i.test(camera),
    "the rep is never told a check exists — golden rule #1",
  );

  // 5. 2026-10-11: iPhone Safari hands the camera an APPROXIMATE position (2,000 m, 650-1,900 m). The
  //    photo keeps the SHARPER of the one-shot read and the running watch. (A rough photo reading no
  //    longer refuses a place - the pin decides - so the shutter is never held waiting for it.)
  assert.ok(camera.includes("const shutterIsSharper ="), "the photo keeps the sharper of its two readings");
  assert.ok(!camera.includes("holdForPreciseFix"), "the shutter is never held: no extra wait in the rep's day");
}

function runServerTests() {
  const rules = read("../src/lib/phoenix-crm/entry-rules.ts");

  // 3. NEVER DEFAULTED TO THE PIN. `?? raw.lat` here would restore the copy bug silently.
  assert.ok(
    rules.includes("photoLat: isUsableFix(raw.shutterLat, raw.shutterLon) ? Number(raw.shutterLat) : null,"),
    "the photo fix is read from its OWN keys, through the same usability guard as the pin",
  );
  assert.ok(
    !/photoLat[^\n]*\?\?\s*(Number\()?raw\.lat/.test(rules),
    "the photo fix must never fall back to the pin",
  );
  // Half a pair is no pair: a body carrying only a latitude contributes no coordinate at all.
  assert.ok(
    rules.includes("photoLon: isUsableFix(raw.shutterLat, raw.shutterLon) ? Number(raw.shutterLon) : null,"),
    "both coordinates are gated together, so a lopsided pair is never stored",
  );
  // Accuracy goes through readAccuracyInput for the reason the pin does: Number("") is 0, which
  // would store a perfect 0 m fix the device never reported.
  assert.ok(
    rules.includes("readAccuracyInput(raw.shutterAccuracyMeters)"),
    "a blank shutter accuracy is unknown, not a perfect 0 m reading",
  );

  const visits = read("../src/lib/phoenix-crm/server/visits.ts");
  for (const column of ["photo_lat:", "photo_lon:", "photo_accuracy_meters:", "photo_captured_at:"]) {
    assert.ok(visits.includes(column), `the visit insert must persist ${column}`);
  }
  assert.ok(
    !/photo_lat:\s*visit\.photoLat\s*\?\?/.test(visits),
    "a null photo fix stays null on the way into the database",
  );
}

export function runCrmShutterFixTests() {
  runCameraTests();
  runServerTests();
}
