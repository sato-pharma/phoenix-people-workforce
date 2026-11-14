import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SIGN_IN_STEP_ID,
  SIGN_IN_STEP_NAME,
  SIGN_IN_STEP_ROLE,
  SIGN_IN_STEP_ROUTE,
  normalizeSignInStep,
} from "../src/lib/synthetic-journeys/sign-in-step.ts";

/**
 * The code the Synthetic Journeys page records for the smoke suite's sign-in step.
 *
 * Owner, 14 November 2026: "Fix the sign-in code". Every check has a readable code ("admin-shell",
 * "payroll-report") except the sign-in step, a setup step that never names itself: all 1,120 of its
 * records carried the test runner's internal code, and its 35 failed ones showed
 * "/login · 24f9ee9347290e4420b0-02d86117bff6d4aae124" in the details panel.
 */

const RUNNER_CODE = "24f9ee9347290e4420b0-02d86117bff6d4aae124";

const signIn = {
  journeyId: RUNNER_CODE,
  journeyName: "authenticate as synthetic admin",
  route: "unknown",
  role: "unknown",
  status: "failed" as const,
  durationMs: 60_000,
  errors: ["Timed out"],
};

export function runSyntheticJourneySignInStepTests() {
  // ── The defect. The sign-in step arrives with the runner's code and leaves with its own.
  const saved = normalizeSignInStep(signIn);
  assert.equal(saved.journeyId, "sign-in", "the sign-in step is saved under its own code, not the test runner's internal hash");
  assert.equal(saved.route, "/login", "its page, as it was already saved");
  assert.equal(saved.role, "Super Admin", "and its role, as it was already saved");

  // ── Nothing else about the step moves.
  assert.equal(saved.journeyName, signIn.journeyName, "the name is how the step is found, and stays");
  assert.equal(saved.status, "failed", "a failed sign-in is still failed");
  assert.equal(saved.durationMs, 60_000);
  assert.deepEqual(saved.errors, ["Timed out"], "and keeps its error");
  assert.equal(signIn.journeyId, RUNNER_CODE, "the report it came from is not changed in place");

  // ── Every other check keeps the code it gave itself.
  const exportCheck = {
    journeyId: "outstation-expenses-export",
    journeyName: "Outstation Expenses export produces a workbook",
    route: "/admin/outstation/expenses",
    role: "Super Admin",
  };
  assert.equal(normalizeSignInStep(exportCheck), exportCheck, "a check that named itself is returned as it came");
  const lookalike = { ...exportCheck, journeyName: "Authenticate as synthetic admin " };
  assert.equal(normalizeSignInStep(lookalike).journeyId, "outstation-expenses-export", "only the step's exact name is matched");

  // ── The code matches the others: short, lowercase, words joined by hyphens.
  assert.match(SIGN_IN_STEP_ID, /^[a-z]+(-[a-z0-9]+)*$/, "spelled like admin-shell and payroll-report");
  assert.equal(SIGN_IN_STEP_NAME, "authenticate as synthetic admin");
  assert.equal(SIGN_IN_STEP_ROUTE, "/login");
  assert.equal(SIGN_IN_STEP_ROLE, "Super Admin");

  // ── The name matched here is the name the step is given, and every saved report goes through it.
  const setup = readFileSync(new URL("./synthetic/helpers/auth.setup.ts", import.meta.url), "utf8");
  assert.ok(setup.includes(`setup("${SIGN_IN_STEP_NAME}"`), "a renamed sign-in step would slip past this and carry the runner's code again");
  const service = readFileSync(new URL("../src/lib/synthetic-journeys/service.ts", import.meta.url), "utf8");
  assert.ok(service.includes("journeyResults.map(normalizeSignInStep)"), "the save step runs every result through it before anything is written");
}
