import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

export function runProbationEnhancementsPrereqTests() {
  // ── PF-1: probation read/row-level routes resolve to probation:read (not Super-Admin update) ──
  const readRoutes: Array<[string, "GET" | "POST" | "PATCH"]> = [
    ["/api/probation/feedback-tasks", "GET"],
    ["/api/probation/dashboard", "GET"],
    ["/api/probation/analytics", "GET"],
    ["/api/probation/cases/abc/report", "GET"],
    ["/api/probation/cases/abc/score", "GET"],
    ["/api/probation/cases/abc/assessments/sfe", "POST"],
    ["/api/probation/cases/abc/decision", "POST"],
    ["/api/probation/dv/abc/feedback", "POST"],
    ["/api/probation/dv-feedback/abc", "PATCH"],
  ];
  for (const [route, method] of readRoutes) {
    const entry = findAccessRegistryEntry(route, method);
    assert.ok(entry, `registry resolves ${method} ${route}`);
    assert.deepEqual(entry!.permission, { resource: "probation", action: "read" },
      `${method} ${route} must gate at probation:read (managers/CEO/SFE not blocked)`);
  }

  // Config editor stays admin-only.
  const cfg = findAccessRegistryEntry("/api/probation/config", "PATCH");
  assert.deepEqual(cfg!.permission, { resource: "probation", action: "update" }, "config editor stays probation:update");

  // Legacy mutation route still falls back to the update blanket.
  const legacy = findAccessRegistryEntry("/api/probation/some-legacy-id/workflow", "POST");
  assert.deepEqual(legacy!.permission, { resource: "probation", action: "update" }, "legacy probation mutations stay update");

  // Mutating probation routes keep CSRF.
  assert.equal(findAccessRegistryEntry("/api/probation/dv/abc/feedback", "POST")!.csrf.required, true, "feedback submit keeps CSRF");

  // ── PF-2: getProbationConfig select includes the previously-omitted columns ──
  const config = readFileSync("src/lib/probation/intelligence/config.ts", "utf8");
  assert.match(config, /\.select\("[^"]*scorecard_dimensions[^"]*"\)/, "config select includes scorecard_dimensions");
  assert.match(config, /\.select\("[^"]*hr_assessment_enabled[^"]*"\)/, "config select includes hr_assessment_enabled");
}
