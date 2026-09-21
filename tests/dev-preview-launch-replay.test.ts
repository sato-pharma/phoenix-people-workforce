import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isDevPreviewReplay } from "../src/lib/auth/dev-preview.ts";

// Regression guard for "Launch preview on /admin/dev-preview landed on a raw {"error":"forbidden"}".
//
// On 2026-09-21 the Super Admin launched a Medical Rep preview twice and got the 403 both times. The
// dev-server log showed the same trace in both runs: preview 307, dev-auth 307, "Compiling
// /employee-portals" (30 to 60 seconds here), then the SAME preview address again, answered 403. The
// launch's first two hops replace the caller — the preview route deletes the real session and
// dev-auth sets the preview cookie — so a second click or a reload during the slow first compile
// reached the Super Admin gate as the Medical Rep it had just minted. Two fixes, both pinned here:
//   1. /api/dev-auth/preview answers a replay of the preview the caller is already in with that
//      preview's landing page, and it mints nothing to do so.
//   2. The picker locks its Launch button after the first click.
export function runDevPreviewLaunchReplayTests() {
  const rep = { hrId: "CN-0006", role: "Medical Rep" as const };

  assert.equal(isDevPreviewReplay(rep, rep), true, "the launch the preview came from is a replay");
  assert.equal(
    isDevPreviewReplay({ hrId: "cn-0006", role: "Medical Rep" }, { hrId: "CN0006", role: "Medical Rep" }),
    true,
    "the person key ignores case and punctuation, as the role guard's does",
  );
  assert.equal(
    isDevPreviewReplay(rep, { hrId: "CN-0007", role: "Medical Rep" }),
    false,
    "a different person is not a replay — switching previews still needs the Super Admin",
  );
  assert.equal(
    isDevPreviewReplay(rep, { hrId: "CN-0006", role: "District Manager" }),
    false,
    "the same person under another role is not a replay",
  );
  assert.equal(
    isDevPreviewReplay({ hrId: null, role: "Medical Rep" }, { hrId: "CN-0006", role: "Medical Rep" }),
    false,
    "a role-only preview never matches a named person",
  );
  assert.equal(
    isDevPreviewReplay({ hrId: "", role: "Medical Rep" }, { hrId: " ", role: "Medical Rep" }),
    false,
    "two blank ids are not the same person",
  );

  const route = readFileSync("app/api/dev-auth/preview/route.ts", "utf8");
  const gateAt = route.indexOf('if (access.role !== "Super Admin") {');
  const replayAt = route.indexOf("const replay = await replayLandingUrl(access,");
  const forbiddenAt = route.indexOf('return NextResponse.json({ error: "forbidden" }, { status: 403 });', gateAt);
  assert.ok(gateAt > 0, "the Super Admin gate is still the route's gate");
  assert.ok(replayAt > gateAt && replayAt < forbiddenAt, "a refused caller is checked for a replay before the 403");

  const helperAt = route.indexOf("async function replayLandingUrl(");
  const helper = route.slice(helperAt, route.indexOf("\n}\n", helperAt) + 2);
  assert.ok(helperAt > 0 && helper.trimEnd().endsWith("}"), "the replay helper's body is found whole");
  assert.match(helper, /if \(!isPreviewSession\(access\)\) return null;/, "only a preview session can replay");
  assert.match(helper, /if \(role !== access\.role\) return null;/, "a replay asks for the role the preview already wears");
  assert.match(helper, /isDevPreviewReplay\(access, \{ hrId: candidate\.hrId, role \}\)/, "and for the same person");
  assert.match(helper, /resolveLandingPathForRole\(role\)/, "it goes to the landing page the first launch was heading to");
  for (const minted of ["cookies", "createDevPreviewSessionToken", "revokeAppSession", "writeAuthAudit", "/api/dev-auth"]) {
    assert.ok(!helper.includes(minted), `a replay grants nothing: the replay path never touches ${minted}`);
  }

  const picker = readFileSync("src/components/admin/dev-preview-picker.tsx", "utf8");
  assert.match(picker, /if \(launching\) \{\s*event\.preventDefault\(\);/, "a second click on Launch does nothing");
  assert.match(picker, /setLaunching\(true\);/, "the first click locks the button");
  assert.match(picker, /if \(event\.persisted\) setLaunching\(false\);/, "coming back from the page cache unlocks it");
  assert.doesNotMatch(picker, /\brounded(-|\b)/, "the picker has no rounded corner anywhere (square-edge golden rule)");
  const nameField = picker.slice(picker.indexOf('id="dev-preview-name"'), picker.indexOf("</SearchableSelect>", picker.indexOf('id="dev-preview-name"')));
  assert.match(nameField, /\bwrapValue\b/, "the Name field wraps a long value instead of clipping it on a phone");
}
