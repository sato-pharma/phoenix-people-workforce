import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { devPreviewRoleMismatch } from "../src/lib/auth/dev-preview.ts";

// Regression guard for "a local preview showed a real District Manager a medical rep's portal".
//
// On 2026-09-21 a preview opened with `/api/dev-auth?role=Medical Rep&hrId=<a Pedia District
// Manager>` rendered the medical rep command center under his real name with no team on it, and it
// was read as his real account being broken — every one of his real sign-ins had been as a District
// Manager. The bare dev-auth route took any role for any hrId, and the activity tracker then wrote
// 433 of those preview page views into PRODUCTION activity_events under his name, because .env.local
// points at production. Two fixes, both pinned here:
//   1. /api/dev-auth refuses (409 role_mismatch) a role the named person does not really hold.
//   2. /api/activity/track records only a real signed-in session (source "session").
export function runDevPreviewRoleGuardTests() {
  const dm = [{ hrId: "PD-0014", role: "District Manager" as const }];

  assert.equal(
    devPreviewRoleMismatch("Medical Rep", "PD-0014", dm),
    "District Manager",
    "previewing a District Manager as a Medical Rep is refused and names his real role",
  );
  assert.equal(devPreviewRoleMismatch("District Manager", "PD-0014", dm), null, "his own role is allowed");
  assert.equal(
    devPreviewRoleMismatch("Medical Rep", "PHASE23-DM", dm),
    null,
    "a synthetic hrId with no active login is still allowed",
  );
  assert.equal(devPreviewRoleMismatch("Medical Rep", "pd-0014", dm), "District Manager", "the key ignores case");
  assert.equal(devPreviewRoleMismatch("Medical Rep", "PD0014", dm), "District Manager", "the key ignores punctuation");
  assert.equal(
    devPreviewRoleMismatch("Medical Rep", "PD-0014", [...dm, { hrId: "pd-0014", role: "Medical Rep" as const }]),
    null,
    "a person with several active logins may be previewed as any role one of them holds",
  );
  assert.equal(devPreviewRoleMismatch("Medical Rep", "  ", dm), null, "a blank hrId is a role-only preview");

  const devAuth = readFileSync("app/api/dev-auth/route.ts", "utf8");
  const guardAt = devAuth.indexOf("findDevPreviewRoleMismatch(role, hrId)");
  const cookieAt = devAuth.indexOf("response.cookies.set(");
  assert.ok(guardAt > 0, "the dev-auth route checks the requested role against the person's real one");
  assert.ok(cookieAt > guardAt, "the check runs before the preview cookie is set");
  assert.match(devAuth, /error: "role_mismatch"/, "a mismatch answers role_mismatch");
  assert.match(devAuth, /status: 409/, "a mismatch answers 409, never a redirect into the wrong portal");

  const track = readFileSync("app/api/activity/track/route.ts", "utf8");
  const sessionOnlyAt = track.indexOf('if (access.source !== "session")');
  assert.ok(sessionOnlyAt > 0, "the activity tracker ignores every caller that is not a real signed-in session");
  assert.ok(
    sessionOnlyAt < track.indexOf("recordPageView("),
    "the session-only check runs before any page view is written",
  );
}
