import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isRolePermissionWithinHardBoundary,
  permissionMatrix,
  phoenixRoles,
} from "../src/lib/auth/permissions.ts";
import {
  disambiguateQuestionKey,
  slugifyQuestionKey,
} from "../src/lib/recruitment/inbound/whatsapp-screening-questions-admin.ts";

/**
 * The admin CRUD service behind /admin/screening-questions.
 *
 * WHO MAY OPEN IT, and why that changed. It was Super Admin alone, via `admin:update`. The owner
 * asked on 2026-09-01 for the HR Business Partner to reach it. `admin:update` was the wrong door
 * to widen - it also gates module locks, scope visibility, salary flags, the email-notification
 * configuration and a notification TEST-SEND endpoint, and firing a test email is a standing
 * prohibition here - so the PAGE was re-gated to `recruitment:update`, with the admin assertion
 * kept underneath as the fallback that still produces the refusal for everyone else. The two
 * totality checks below pin BOTH halves: that `admin:update` stayed Super-Admin-only, and that
 * the effective audience is exactly Super Admin plus HR Advisory and nobody else.
 *
 * The pure pieces (key generation, the permission gate) are tested directly. Everything else in
 * whatsapp-screening-questions-admin.ts touches the database, and — like every other DB-touching
 * service in this suite (see candidate-merge-service's own tests) — is pinned against its SOURCE
 * rather than exercised against a live Supabase project from a local run: `.env.local` points at
 * PRODUCTION here, so a hand-run test that actually inserted/deleted rows would write real data.
 * Each assertion below names the exact invariant it is standing in for, so a refactor that keeps the
 * words but drops the behavior still has somewhere to be caught in review.
 */

export function runWhatsAppScreeningQuestionsAdminTests() {
  // ── slugifyQuestionKey ──────────────────────────────────────────────────────────────────────────
  assert.equal(slugifyQuestionKey("Do you have a driving license?"), "do_you_have_a_driving_license");
  assert.equal(slugifyQuestionKey("  Leading and trailing spaces  "), "leading_and_trailing_spaces");
  assert.equal(
    slugifyQuestionKey("2 years of experience?"),
    "q_2_years_of_experience",
    "a slug that would start with a digit gets a letter prefix, so it stays a valid question key",
  );
  assert.equal(
    slugifyQuestionKey("???"),
    "q_",
    "a prompt with no letters or digits at all still produces a valid, non-empty key via the q_ prefix",
  );
  assert.ok(
    slugifyQuestionKey("x".repeat(200)).length <= 50,
    "a very long prompt must still produce a bounded key — question keys sit in row ids and a CHECK constraint",
  );
  // The generated key must always satisfy the SAME format screeningQuestionViolations checks, or
  // every brand-new question would fail its own save.
  assert.ok(/^[a-z][a-z0-9_]{1,62}$/.test(slugifyQuestionKey("Do you have a driving license?")));
  assert.ok(/^[a-z][a-z0-9_]{1,62}$/.test(slugifyQuestionKey("???")));
  assert.ok(/^[a-z][a-z0-9_]{1,62}$/.test(slugifyQuestionKey("2 years of experience?")));

  // ── disambiguateQuestionKey ─────────────────────────────────────────────────────────────────────
  assert.equal(disambiguateQuestionKey("has_license", new Set()), "has_license", "no collision, no suffix");
  assert.equal(disambiguateQuestionKey("has_license", new Set(["has_license"])), "has_license_2");
  assert.equal(
    disambiguateQuestionKey("has_license", new Set(["has_license", "has_license_2"])),
    "has_license_3",
    "keeps counting past a collision on the first suffix too",
  );

  // ── Permission gate, half one: admin:update is STILL a hard boundary, Super Admin only ─────
  // This is the assertion proving the 2026-09-01 widening did not take the easy route. Opening
  // this screen to the HR Business Partner by granting her `admin:update` would have handed her
  // sixteen other assertions with it, one of which sends a test email. If this line ever goes
  // red for a second role, that is what happened.
  for (const role of phoenixRoles) {
    assert.equal(
      isRolePermissionWithinHardBoundary(role, "admin", "update"),
      role === "Super Admin",
      `admin:update must be allowed for Super Admin and refused for every other role — got the wrong answer for "${role}"`,
    );
  }

  // ── Permission gate, half two: the EFFECTIVE audience of this screen ───────────────────
  // `assertScreeningQuestionsAccess` admits `recruitment:update` OR `admin:update`, so the real
  // boundary is the union of the two. A totality check across every role, with the answer listed
  // by name: the owner asked for ONE seat, and this is where a later grant that quietly adds a
  // second one — by widening `recruitment:update` somewhere else entirely — has to go red.
  const holdsUpdate = (role: (typeof phoenixRoles)[number], resource: "admin" | "recruitment") =>
    (permissionMatrix[role]?.[resource] ?? []).includes("update");
  const effectiveAudience = phoenixRoles.filter(
    (role) => holdsUpdate(role, "recruitment") || holdsUpdate(role, "admin"),
  );
  assert.deepEqual(
    [...effectiveAudience].sort(),
    ["HR Advisory", "Super Admin"],
    "exactly two seats may edit the questions an applicant is asked on WhatsApp: the Super Admin, and the HR Business Partner the owner named on 2026-09-01",
  );

  // ── The DB-touching half, pinned against its own source ────────────────────────────────────────
  // Same style as recruitment-candidate-merge.test.ts's childTables ordering pin: these properties
  // are invisible to a pure unit test, so a later edit that keeps the code compiling but drops the
  // behavior needs somewhere else to go red.
  const service = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-screening-questions-admin.ts", import.meta.url),
    "utf8",
  );

  assert.ok(
    service.includes("screeningQuestionViolations("),
    "saveScreeningQuestionSet stopped validating against screeningQuestionViolations before writing — an admin could then save a question that 400s on the very first real applicant",
  );
  // Validation must happen BEFORE any write — an admin's save is all-or-nothing, never half-applied.
  const validateIndex = service.indexOf("screeningQuestionViolations(question)");
  const firstWriteIndex = Math.min(
    ...[".update(payload)", ".insert({"].map((needle) => {
      const at = service.indexOf(needle);
      return at === -1 ? Infinity : at;
    }),
  );
  assert.ok(
    validateIndex !== -1 && validateIndex < firstWriteIndex,
    "every row must be validated BEFORE the first database write, so a save either fully succeeds or changes nothing",
  );

  assert.ok(
    /sort_order:\s*index \+ 1/.test(service),
    "sort_order must be recomputed from array position server-side — trusting a client-sent sort_order would let a stale tab silently reorder every question",
  );

  assert.ok(
    (service.match(/invalidateScreeningQuestionCache\(\)/g) ?? []).length >= 2,
    "both saveScreeningQuestionSet and deleteScreeningQuestion must invalidate the question cache — a stale cache means the bot keeps asking a question an admin just changed or removed",
  );

  // The hard-delete guard: never delete an already-answered question.
  const deleteFn = service.slice(service.indexOf("export async function deleteScreeningQuestion"));
  assert.ok(
    /countAnswers\(questionKey\)\) > 0/.test(deleteFn),
    "deleteScreeningQuestion must refuse to delete a question that already has recorded answers",
  );
  assert.ok(
    /throw new Error/.test(deleteFn),
    "the delete guard must actually refuse (throw), not just log — a UI-only guard is not enforcement",
  );

  // Never delete-all-reinsert on a whole-array save: that would risk destroying an already-answered
  // question the moment any client's copy of the array goes stale.
  const saveFn = service.slice(
    service.indexOf("export async function saveScreeningQuestionSet"),
    service.indexOf("export async function deleteScreeningQuestion"),
  );
  assert.ok(
    !/\.delete\(\)/.test(saveFn),
    "saveScreeningQuestionSet must never delete a row — only deleteScreeningQuestion may, and only when unanswered",
  );

  // ── The gate itself: one function, two steps, and a fallback that cannot be dropped ────────
  // The page and both save routes call this and not a copy of it, so the three cannot drift. If
  // the `canAccess` line is ever widened past `recruitment:update` the totality check above goes
  // red; if the `assertPermission` fallback is ever deleted, this does.
  const gateStart = service.indexOf("export async function assertScreeningQuestionsAccess");
  assert.ok(gateStart !== -1, "the shared gate must stay exported — the page and both routes call it by name");
  const gateBody = service.slice(gateStart, service.indexOf("\n}", gateStart));
  assert.ok(
    /canAccess\(access, "recruitment", "update"\)/.test(gateBody),
    "the gate's first step is recruitment:update — the honest description of editing the questions an applicant is asked",
  );
  assert.ok(
    /assertPermission\(access, "admin", "update"\)/.test(gateBody),
    "the gate must keep the admin:update fallback — it is what produces the refusal, and its message, for every role outside the audience",
  );
  // ── The route and page both re-assert the boundary themselves, not just import it ──────────
  const route = readFileSync(new URL("../app/api/admin/screening-questions/route.ts", import.meta.url), "utf8");
  for (const verb of ["GET", "POST", "DELETE"]) {
    const fnStart = route.indexOf(`export async function ${verb}(`);
    assert.ok(fnStart !== -1, `route.ts is missing a ${verb} handler`);
    const fnBody = route.slice(fnStart, route.indexOf("\n}", fnStart));
    assert.ok(
      /assertScreeningQuestionsAccess\(access\)/.test(fnBody),
      `${verb} must assert the screen's own gate itself — a page that hides the link is not the security boundary`,
    );
  }
  for (const verb of ["POST", "DELETE"]) {
    const fnStart = route.indexOf(`export async function ${verb}(`);
    const fnBody = route.slice(fnStart, route.indexOf("\n}", fnStart));
    assert.ok(
      /assertSameOriginMutation\(request\)/.test(fnBody),
      `${verb} must run the CSRF check — every mutating route in this codebase does`,
    );
  }

  const page = readFileSync(
    new URL("../app/(admin)/admin/screening-questions/page.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    /assertScreeningQuestionsAccess\(access\)/.test(page),
    "the page must also assert the gate server-side, not rely on the route alone",
  );
}
