import assert from "node:assert/strict";

import {
  createAccessContext,
  isDesignatedHrManagerIdentity,
  isDesignatedHrSpecialist,
  designatedHrManagerHrId,
  designatedHrSpecialistHrId,
} from "../src/lib/auth/permissions.ts";

const OFFER_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runSecurityPermissionsTests() {
  // --- Designated HR Manager auto-elevation ---
  const managerCtx = createAccessContext({ hrId: designatedHrManagerHrId, loginId: designatedHrManagerHrId, role: "HR Specialist" });
  assert.equal(managerCtx.role, "Super Admin", "Designated HR manager HR ID must be elevated to Super Admin regardless of stored role");

  const managerByLogin = createAccessContext({ hrId: "zzz", loginId: designatedHrManagerHrId, role: "Employee" });
  assert.equal(managerByLogin.role, "Super Admin", "Designated HR manager login ID must also trigger elevation");

  // --- Designated HR Specialist scope ---
  const specialistCtx = createAccessContext({ hrId: designatedHrSpecialistHrId, loginId: "a16", role: "HR Specialist" });
  assert.notEqual(specialistCtx.scope, "self", "Designated HR specialist must not be confined to self-scope");

  // Non-designated HR Specialist stays on self scope
  const regularHr = createAccessContext({ hrId: "z99", loginId: "z99", role: "HR Specialist" });
  assert.equal(regularHr.scope, "self", "Non-designated HR specialist must be scoped to self");

  // --- isDesignatedHrSpecialist helper ---
  assert.ok(isDesignatedHrSpecialist({ hrId: designatedHrSpecialistHrId, role: "HR Specialist" }), "a16 HR Specialist must be designated specialist");
  assert.ok(!isDesignatedHrSpecialist({ hrId: "c99", role: "HR Specialist" }), "Random HR ID must not be designated specialist");
  assert.ok(!isDesignatedHrSpecialist({ hrId: designatedHrSpecialistHrId, role: "Medical Rep" }), "Non-HR Specialist role must not be designated specialist even with matching HR ID");

  // --- isDesignatedHrManagerIdentity helper ---
  assert.ok(isDesignatedHrManagerIdentity({ hrId: designatedHrManagerHrId }), "Matching HR ID must be designated manager");
  assert.ok(isDesignatedHrManagerIdentity({ loginId: designatedHrManagerHrId }), "Matching login ID must be designated manager");
  assert.ok(!isDesignatedHrManagerIdentity({ hrId: "c99", loginId: "c99" }), "Non-matching IDs must not be designated manager");

  // --- Regular roles are not elevated ---
  const ceo = createAccessContext({ hrId: "x01", loginId: "x01", role: "CEO" });
  assert.equal(ceo.role, "CEO", "CEO role must not be altered");

  const medRep = createAccessContext({ hrId: "m55", loginId: "m55", role: "Medical Rep" });
  assert.equal(medRep.role, "Medical Rep", "Medical Rep role must not be altered");
  assert.equal(medRep.scope, "self", "Medical Rep must have self scope");

  // --- Offer reference format validation ---
  assert.ok(OFFER_REF_RE.test("550e8400-e29b-41d4-a716-446655440000"), "Valid UUID must pass offer ref check");
  assert.ok(OFFER_REF_RE.test("00000000-0000-0000-0000-000000000000"), "All-zero UUID must pass");
  assert.ok(!OFFER_REF_RE.test("../admin"), "Path traversal string must fail offer ref check");
  assert.ok(!OFFER_REF_RE.test("' OR 1=1--"), "SQL injection string must fail offer ref check");
  assert.ok(!OFFER_REF_RE.test(""), "Empty string must fail offer ref check");
  assert.ok(!OFFER_REF_RE.test("not-a-uuid"), "Non-UUID string must fail offer ref check");
  assert.ok(!OFFER_REF_RE.test("550e8400e29b41d4a716446655440000"), "UUID without dashes must fail offer ref check");

  // --- Env-var-configurable designated IDs produce consistent normalised values ---
  assert.equal(designatedHrSpecialistHrId, designatedHrSpecialistHrId.toLowerCase().replace(/[^a-z0-9]/g, ""), "Designated specialist ID must be normalised (lowercase alphanumeric)");
  assert.equal(designatedHrManagerHrId, designatedHrManagerHrId.toLowerCase().replace(/[^a-z0-9]/g, ""), "Designated manager ID must be normalised (lowercase alphanumeric)");
  assert.ok(designatedHrSpecialistHrId.length > 0, "Designated specialist ID must not be empty");
  assert.ok(designatedHrManagerHrId.length > 0, "Designated manager ID must not be empty");
}
