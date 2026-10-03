import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canUseEmployeePortalMilestones,
  resolveEmployeePortalNavVisibility,
} from "@/lib/employee-portal/navigation";
import { listEmployeeMilestones } from "@/lib/milestones/service";

// ─────────────────────────────────────────────────────────────────────────────
// My Milestones — the medical rep's OWN keepsake cards, self-scoped (owner, 2026-09-30:
// "in medical reps side bar show /milestones and make able to export only his milestones").
//
// The Super-Admin workspace at /milestones prints ANY employee's card across the company; that is a
// publishing right behind `milestones:export`. This portal page is a different thing: it lists only
// the signed-in rep's own occasions, and /api/milestones/my-card builds only the CALLER's card. The
// properties that would fail QUIETLY — a rep pointing the export at a colleague, the audience
// widening, a self-print corrupting the admin "already congratulated" tick, an unreachable row — are
// pinned here.
// ─────────────────────────────────────────────────────────────────────────────

export async function runRepMilestonesPortalTests() {
  const route = readFileSync(new URL("../app/api/milestones/my-card/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/lib/milestones/service.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/employee-portals/milestones/page.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../src/components/employee-portal/employee-portal-layout.tsx", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/components/employee-portal/employee-portal-nav-registry.ts", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");

  // ── THE HEADLINE: the audience is medical reps, and only medical reps ─────────────────────────
  assert.equal(canUseEmployeePortalMilestones("Medical Rep"), true, "a medical rep may open My Milestones");
  for (const role of ["District Manager", "National Sales Manager", "Super Admin", "CEO", "Employee"] as const) {
    assert.equal(canUseEmployeePortalMilestones(role), false, `${role} is not offered the rep's My Milestones page`);
  }

  // ── The sidebar flag follows the same predicate ──────────────────────────────────────────────
  assert.equal(
    resolveEmployeePortalNavVisibility(null, "Medical Rep").showMilestonesTab,
    true,
    "the Medical Rep sidebar shows the My Milestones row",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility(null, "District Manager").showMilestonesTab,
    false,
    "no other role gets the row",
  );

  // ── THE EXPORT IS SELF-SCOPED — the subject is always the caller ──────────────────────────────
  // A rep must never be able to point the card at a colleague, so the subject is pinned to
  // access.hrId and the route must not read an hrId off the request body.
  assert.match(route, /const hrId = access\.hrId/, "the subject is pinned to the caller");
  assert.match(route, /buildMilestoneCardInput\(\{\s*\n?\s*hrId,/, "the card is built for the caller, always");
  assert.match(route, /milestonePhotoFocus\(hrId,/, "the focus read is for the caller, always");
  assert.doesNotMatch(
    route,
    /body[?.]*\.hrId/,
    "the self-card route must never read an hrId off the wire — that would let a rep print a colleague",
  );
  // It must gate on the same audience as the sidebar.
  assert.match(route, /canUseEmployeePortalMilestones\(access\.role\)/, "the route admits the same audience the sidebar offers");
  // It must NOT write the shared print ledger — that log means "the company congratulated this
  // person", and its marks drive the Super Admin's "already congratulated" tick. A rep printing his
  // own keepsake is not a congratulation, so recording it would put a false tick on the admin list.
  assert.doesNotMatch(route, /recordMilestonePrint|buildMilestonePrintRow/, "a self-print never touches the shared print ledger");

  // ── The rep gets the admin's photo control: PDF or picture, focus drag, upload, no-photo ───────
  assert.match(route, /format === "png"/, "the rep can export a picture, not only a PDF");
  assert.match(route, /format === "focus"/, "the framing box can read where the card frames the photo");
  assert.match(route, /renderMilestoneCardImage/, "the picture export renders a PNG");
  assert.match(route, /photoUpload/, "the rep can hand in a different picture for the card");
  assert.match(route, /withoutPhoto/, "the rep can print the monogram plate instead of a photo");
  assert.match(route, /photoFocus: readFocus/, "a dragged framing reaches the card");

  // ── THE MISSING-PHOTO FIX: the card falls back to the bundled static photo ─────────────────────
  // A portal photo resolves uploaded → bundled static → initials, but the card only ever read the
  // uploaded one, so an account whose portal photo is a bundled static file exported with NO picture.
  // The service now falls the card back to that same static file, so portal and card finally agree.
  assert.match(service, /export async function loadMilestonePhotoBytes/, "one photo resolver feeds the card and the focus");
  assert.match(service, /readStaticProfilePhoto/, "the card falls back to the bundled static photo");
  assert.match(service, /employeeProfileImageForHrId/, "the static fallback reads the same file the portal shows");

  // ── The page gates by role predicate, never the company-wide milestones permission ────────────
  // A rep does not hold `milestones` — asserting it here would bounce him at the door (the exact
  // "offered but bounced" defect every-offered-link-opens.test.ts exists to catch).
  assert.match(page, /canUseEmployeePortalMilestones\(access\.role\)/, "the page uses the rep-audience predicate");
  assert.doesNotMatch(page, /assertPermission\([^)]*"milestones"/, "the page never asserts the Super-Admin milestones permission");

  // ── Reachable: a sidebar row, a nav-registry entry, and a catalog entry ───────────────────────
  assert.match(
    layout,
    /showMilestonesTab \? \[\{ href: "\/employee-portals\/milestones"/,
    "the rail renders the My Milestones row behind its flag",
  );
  assert.match(
    registry,
    /href: "\/employee-portals\/milestones"[^}]*flags: \["showMilestonesTab"\]/,
    "the nav registry carries the entry with its flag",
  );
  // No `permission` on the registry entry — the page has no machine-readable permission gate, so
  // employee-portal-nav-permission-matches-page.test.ts requires the field be absent.
  const registryLine = registry.split("\n").find((line) => line.includes('href: "/employee-portals/milestones"')) ?? "";
  assert.doesNotMatch(registryLine, /permission:/, "the registry entry carries no permission (the page gates by role predicate)");
  assert.match(catalog, /href: "\/employee-portals\/milestones"/, "the command-palette catalog can find the page");

  // ── THE FRAMING IS THE ADMIN EDITOR'S, INCLUDING WHAT ZOOM KEEPS ──────────────────────────────
  // The portal card editor is a deliberate COPY of the admin one (milestones-workspace.tsx), and the
  // component header claims the two are "pinned equal by tests/rep-milestones-portal.test.ts" —
  // which, until 2026-10-03, pinned nothing about the geometry at all. The copy had drifted in one
  // token: `setZoom` fell through to CENTRE instead of to `focusDefault`, so the first touch of the
  // Zoom slider snapped the picture back to the middle and discarded the SERVER's resolved crop —
  // the face-aware framing the printed card actually uses. Nothing failed and nothing logged; the
  // rep simply got a differently-cropped card from the one he had been looking at.
  const portalEditor = readFileSync(
    new URL("../src/components/employee-portal/my-milestones.tsx", import.meta.url),
    "utf8",
  );
  const adminEditor = readFileSync(
    new URL("../src/components/milestones/milestones-workspace.tsx", import.meta.url),
    "utf8",
  );
  const editors = [
    ["the portal card editor", portalEditor],
    ["the admin card editor", adminEditor],
  ] as const;
  for (const [label, source] of editors) {
    assert.match(
      source,
      /const base = current \?\? focusDefault \?\? CENTRE;/,
      `${label} keeps the server-resolved framing when only the zoom changes`,
    );
    assert.doesNotMatch(
      source,
      /const base = current \?\? CENTRE;/,
      `${label} never falls straight through to centre — that discards the resolved crop`,
    );
    // The frame itself is the same fixed 4:5 rectangle in both, which is what makes a crop portable.
    assert.match(source, /const FRAME_RATIO = "4 \/ 5";/, `${label} draws the fixed 4:5 frame`);
    assert.match(source, /const MAX_ZOOM = 4;/, `${label} caps the zoom at the same multiple`);
  }

  // ── DB-free contract of the service helper ───────────────────────────────────────────────────
  // An empty id short-circuits before any directory read, so this is safe with no database.
  assert.deepEqual(await listEmployeeMilestones(""), [], "an empty id yields no milestones, without touching the directory");
}
