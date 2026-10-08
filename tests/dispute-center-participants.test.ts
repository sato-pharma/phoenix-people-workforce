import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveParticipant } from "../src/lib/dispute-center/participants.ts";

/**
 * WHO MAY READ, AND WHO MAY DECIDE — the Dispute Center's real gate.
 *
 * The routes are registered on `attendance:read`, which is wide on purpose: it only decides who
 * reaches the ROUTE. Which CASES a caller may then read, and whether they may answer or decide one,
 * is each module's own long-standing rule, applied per case here. The danger this pins is the
 * opposite of a locked-out manager: a colleague's pay-affecting dispute leaking to everyone holding
 * attendance:read, which most of the sales hierarchy does.
 */

const EMPLOYEE = "B-77";

export async function runDisputeCenterParticipantsTests() {
  // CALENDAR — the employee who raised it, and the Super Admin. Nobody else, not even the CEO:
  // assertDisputeDecisionActor refuses anybody but Super Admin end to end.
  const calendarOwner = resolveParticipant({ kind: "calendar", ownerHrId: EMPLOYEE, role: "Medical Rep", viewerHrId: EMPLOYEE });
  assert.equal(calendarOwner.isOwner, true, "the employee who raised a calendar dispute is its owner");
  assert.equal(calendarOwner.isReviewer, false, "…and never its reviewer");
  assert.equal(calendarOwner.canRead, true);

  const calendarAdmin = resolveParticipant({ kind: "calendar", ownerHrId: EMPLOYEE, role: "Super Admin", viewerHrId: "B-10" });
  assert.equal(calendarAdmin.isReviewer, true, "the Super Admin decides a calendar dispute");

  for (const role of ["CEO", "National Sales Manager", "District Manager", "HR Operations", "Finance Manager"]) {
    const outsider = resolveParticipant({ kind: "calendar", ownerHrId: EMPLOYEE, role, viewerHrId: "B-99" });
    assert.equal(outsider.canRead, false, `${role} cannot read somebody else's calendar dispute`);
    assert.equal(outsider.isReviewer, false, `${role} cannot decide a calendar dispute`);
  }

  // DEDUCTION — the employee it belongs to; the Super Admin decides; the CEO, the Finance Manager
  // and HR Operations READ the module company-wide and must not be able to write.
  const deductionOwner = resolveParticipant({ kind: "deduction", ownerHrId: "B77", role: "Medical Rep", viewerHrId: "B-77" });
  assert.equal(deductionOwner.isOwner, true, "a deduction case matches its owner on the COMPACT hr id — B-77 and B77 are one person");
  assert.equal(deductionOwner.isReviewer, false);

  const deductionAdmin = resolveParticipant({ kind: "deduction", ownerHrId: "B77", role: "Super Admin", viewerHrId: "B-10" });
  assert.equal(deductionAdmin.isReviewer, true, "the Super Admin decides a deduction dispute");

  for (const role of ["CEO", "Finance Manager", "HR Operations"]) {
    const reader = resolveParticipant({ kind: "deduction", ownerHrId: "B77", role, viewerHrId: "B-99" });
    assert.equal(reader.canRead, true, `${role} reads the deductions module company-wide`);
    assert.equal(reader.isReviewer, false, `${role} must not answer or decide a deduction dispute`);
  }
  const salesManager = resolveParticipant({ kind: "deduction", ownerHrId: "B77", role: "District Manager", viewerHrId: "B-99" });
  assert.equal(salesManager.canRead, false, "a line manager cannot read a rep's deduction dispute");

  // DIGEST — the employee whose week it is, plus the Super Admin and the NAMED reviewers. A named
  // reviewer never rules on their own pay; the Super Admin is exempt because nobody is above him.
  const digestOwner = resolveParticipant({ digestReviewer: false, kind: "digest", ownerHrId: EMPLOYEE, role: "Medical Rep", viewerHrId: EMPLOYEE });
  assert.equal(digestOwner.isOwner, true);
  assert.equal(digestOwner.isReviewer, false);

  const namedReviewer = resolveParticipant({ digestReviewer: true, kind: "digest", ownerHrId: EMPLOYEE, role: "HR Operations", viewerHrId: "B-55" });
  assert.equal(namedReviewer.isReviewer, true, "a named weekly-review reviewer answers a digest dispute");

  const reviewerOwnWeek = resolveParticipant({ digestReviewer: true, kind: "digest", ownerHrId: "B-55", role: "HR Operations", viewerHrId: "B-55" });
  assert.equal(reviewerOwnWeek.isOwner, true, "a reviewer's own week is still their own case");
  assert.equal(reviewerOwnWeek.isReviewer, false, "…and they cannot rule on their own pay");

  const adminOwnWeek = resolveParticipant({ digestReviewer: true, kind: "digest", ownerHrId: "B-10", role: "Super Admin", viewerHrId: "B-10" });
  assert.equal(adminOwnWeek.isReviewer, true, "the Super Admin decides his own week too — nobody is above him");

  const notAReviewer = resolveParticipant({ digestReviewer: false, kind: "digest", ownerHrId: EMPLOYEE, role: "District Manager", viewerHrId: "B-99" });
  assert.equal(notAReviewer.canRead, false, "attendance:read alone does not open a colleague's attendance dispute");

  // An unknown viewer is nobody: a case must never fall open because the HR id could not be resolved.
  const anonymous = resolveParticipant({ kind: "calendar", ownerHrId: EMPLOYEE, role: "Medical Rep", viewerHrId: null });
  assert.equal(anonymous.isOwner, false, "a caller with no resolvable HR id is not the owner of anything");
  assert.equal(anonymous.canRead, false, "…and reads nothing");
  const anonymousDeduction = resolveParticipant({ kind: "deduction", ownerHrId: "B77", role: "Medical Rep", viewerHrId: null });
  assert.equal(anonymousDeduction.isOwner, false, "the compact-id path fails closed on a null viewer as well");

  // EVERY write path asserts the participant INSIDE the domain helper, not in the route — a route is
  // one `if` away from serving the whole of attendance:read, and there are three modules behind each
  // one. So the assertion is on the helpers: every decide and every reopen-grant demands a reviewer,
  // and every reopen REQUEST demands the owner (owner's ruling: "employee asks, reviewer reopens").
  const helpers = {
    "src/lib/dispute-center/calendar.ts": ["requestCalendarReopen", "decideCalendarReopen"],
    "src/lib/dispute-center/deduction.ts": ["decideDeductionDispute", "requestDeductionReopen", "decideDeductionReopen"],
    "src/lib/dispute-center/digest.ts": ["addDigestDisputeMessage", "decideDigestDispute", "requestDigestReopen", "decideDigestReopen"],
  };
  for (const [file, functions] of Object.entries(helpers)) {
    const source = readFileSync(file, "utf8");
    for (const name of functions) {
      const start = source.indexOf(`export async function ${name}`);
      assert.ok(start > 0, `${name} exists in ${file}`);
      const body = source.slice(start, start + 1400);
      assert.ok(
        body.includes("resolveCaseParticipant("),
        `${name} resolves who the caller is to this case before it changes anything`,
      );
      const gate = /request\w*Reopen/.test(name)
        ? /!participant\.isOwner/
        : /!participant\.isReviewer|!participant\.isOwner && !participant\.isReviewer/;
      assert.match(body, gate, `${name} refuses a caller who is not entitled to it`);
      assert.ok(
        body.indexOf("participant.is") < body.indexOf("await record") || !body.includes("await record"),
        `${name} checks the caller BEFORE it writes anything`,
      );
    }
  }

  // Each route still resolves the caller itself, and every mutation is same-origin checked.
  for (const route of [
    "app/api/dispute-center/cases/route.ts",
    "app/api/dispute-center/cases/[kind]/[ref]/route.ts",
    "app/api/dispute-center/cases/[kind]/[ref]/messages/route.ts",
    "app/api/dispute-center/cases/[kind]/[ref]/decide/route.ts",
    "app/api/dispute-center/cases/[kind]/[ref]/reopen/route.ts",
    "app/api/dispute-center/cases/[kind]/[ref]/assist/route.ts",
    "app/api/dispute-center/attachments/[id]/route.ts",
  ]) {
    const source = readFileSync(route, "utf8");
    assert.ok(source.includes("resolveAccessContext"), `${route} resolves the caller before anything else`);
    if (source.includes("export async function POST")) {
      assert.ok(source.includes("assertSameOriginMutation(request)"), `${route} refuses a cross-origin POST`);
    }
  }

  // The case briefing is Super Admin only — his own answer when asked who should have it ("only
  // me"). The route must not be the only thing saying so.
  const assist = readFileSync("src/lib/dispute-center/assist.ts", "utf8");
  assert.match(
    assist,
    /export function assertAssistActor[\s\S]{0,400}role !== "Super Admin"/,
    "the case briefing refuses anybody but the Super Admin inside the domain helper",
  );
  for (const name of ["runDisputeAssist", "listDisputeAssistEntries"]) {
    const start = assist.indexOf(`export async function ${name}`);
    assert.ok(start > 0, `${name} exists`);
    assert.ok(
      assist.slice(start, start + 900).includes("assertAssistActor(access)"),
      `${name} asserts the Super Admin gate itself`,
    );
  }

  // The registry rows exist for all of them — an unregistered route is refused at runtime by the
  // access registry, which is how this would otherwise show up: as a dead screen.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  for (const pattern of [
    "/api/dispute-center/cases",
    "/api/dispute-center/cases/:kind/:ref",
    "/api/dispute-center/cases/:kind/:ref/messages",
    "/api/dispute-center/cases/:kind/:ref/decide",
    "/api/dispute-center/cases/:kind/:ref/reopen",
    "/api/dispute-center/cases/:kind/:ref/assist",
    "/api/dispute-center/attachments/:id",
  ]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `${pattern} is registered in the access registry`);
  }
  for (const pattern of ["/decide", "/reopen", "/messages"]) {
    const row = registry.split("\n").find((line) => line.includes(`pattern: "/api/dispute-center/cases/:kind/:ref${pattern}"`));
    assert.ok(row && row.includes("csrfRequired: true"), `the ${pattern} route requires a CSRF token`);
    assert.ok(row && row.includes('classification: "mutation"'), `the ${pattern} route is audited as a mutation`);
  }
}
