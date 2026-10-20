import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { scopeForRole, type AccessContext, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { assertWorkspaceWorker } from "../src/lib/recruitment/workspace/candidate-actions.ts";
import { workspaceViewer } from "../src/lib/recruitment/workspace/role-tabs.ts";
import {
  TYPED_ROLE_HR_REFUSAL,
  TYPED_ROLE_TAB_REFUSAL,
  typedRoleRefusal,
} from "../src/lib/recruitment/workspace/typed-role-filing.ts";
import { roleFamilyForTypedRole } from "../src/lib/recruitment/whatsapp-answer-edit.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * TYPING A ROLE IS FILING A CV (found by a risk review of the Recruitment table PR, 20 Oct 2026).
 *
 * `PATCH /api/recruitment/candidates/<id>/whatsapp-answer` saves one WhatsApp answer from the pool. When
 * the key is the role (`job_title`) the saver re-files the person into the tab that role maps to. The
 * route used to ask only `candidates: update` and `assertCandidateVisible`, so:
 *   (a) the Talent Acquisition seat could type "HR Section Head" or "Talent Acquisition" and file a
 *       person into an HR tab she is never allowed (owner, 2026-10-20: she never sees an HR applicant);
 *   (b) the CEO's read-only seat was not refused by the workspace's own worker gate, which every other
 *       workspace write calls.
 *
 * Pinned: (1) the refusal itself, for the seat that is fenced and for the seats that are not; (2) the
 * worker gate; (3) that the ROUTE calls both, in the right order, before the save.
 */

const root = process.cwd();
const ROUTE = "app/api/recruitment/candidates/[id]/whatsapp-answer/route.ts";
const code = (relative: string) => stripComments(readFileSync(path.join(root, relative), "utf8"));

const accessFor = (role: PhoenixRole): AccessContext =>
  ({ hrId: "B-TEST", loginId: "test.login", role, scope: scopeForRole(role) }) as unknown as AccessContext;
const TALENT_ACQUISITION = accessFor("HR Resourcing");
const SUPER_ADMIN = accessFor("Super Admin");
const CEO = accessFor("CEO");

/** The words a reader types as the role, resolved the way the route resolves them. */
const refusalFor = (access: AccessContext, typed: string | null) =>
  typedRoleRefusal(workspaceViewer(access), roleFamilyForTypedRole(typed));

function runRefusalTests() {
  // Her two closed tabs, typed as words, as the family code the workspace sends, and as a near-miss
  // the family reader still files there ("Recruiter" reads as Talent Acquisition).
  for (const typed of ["HR Section Head", "Talent Acquisition", "talent_acquisition", "hr_section_head", "Recruiter"]) {
    assert.equal(
      refusalFor(TALENT_ACQUISITION, typed),
      TYPED_ROLE_TAB_REFUSAL,
      `the Talent Acquisition seat cannot file a CV by typing "${typed}"`,
    );
  }
  // The retired Human Resources tap files in NO tab, yet makes the person an HR applicant — hidden from
  // her on the next read. That is the same vanishing act by another door.
  for (const typed of ["Human Resources", "HR", "human_resources"]) {
    assert.equal(
      refusalFor(TALENT_ACQUISITION, typed),
      TYPED_ROLE_HR_REFUSAL,
      `typing "${typed}" would hide the person from her, so it is refused`,
    );
  }
  assert.equal(TYPED_ROLE_TAB_REFUSAL, "You cannot file a CV in that tab.", "the wording is the Place form's refusal");

  // Every other role she works, and a role that names no family, stay free to type.
  for (const typed of [
    "Medical Representative",
    "District Manager",
    "Product Manager",
    "Area Manager",
    "National Sales Manager",
    "Office Coordinator",
    "Pharmacist",
    "Chef",
    "medical_rep",
  ]) {
    assert.equal(refusalFor(TALENT_ACQUISITION, typed), null, `"${typed}" files in a tab she sees`);
  }
  // Clearing the answer files nowhere.
  assert.equal(refusalFor(TALENT_ACQUISITION, null), null, "no value, no filing");
  assert.equal(refusalFor(TALENT_ACQUISITION, "   "), null, "a blank value, no filing");

  // The seats that see every tab are not held back.
  for (const typed of ["HR Section Head", "Talent Acquisition", "Human Resources", "Medical Representative"]) {
    assert.equal(refusalFor(SUPER_ADMIN, typed), null, `the Super Admin may type "${typed}"`);
  }
}

function runWorkerGateTests() {
  assert.doesNotThrow(() => assertWorkspaceWorker(TALENT_ACQUISITION), "the Talent Acquisition seat works the workspace");
  assert.doesNotThrow(() => assertWorkspaceWorker(SUPER_ADMIN), "the Super Admin works the workspace");
  assert.throws(
    () => assertWorkspaceWorker(CEO),
    (error: unknown) => (error as { status?: number }).status === 403,
    "the CEO's read-only seat is refused with a 403",
  );
}

/** The route, as text, comments stripped — a comment that explains a call must never satisfy the pin. */
function runRouteTests() {
  const route = code(ROUTE);
  const at = (needle: string) => {
    const index = route.indexOf(needle);
    assert.ok(index >= 0, `the route contains ${needle}`);
    assert.equal(route.indexOf(needle, index + 1), -1, `the route contains ${needle} once`);
    return index;
  };

  const access = at('requireRecruitmentAccess(request, "candidates", "update")');
  const worker = at("assertWorkspaceWorker(access)");
  const visible = at("assertCandidateVisible(access, id)");
  const payload = at("whatsAppAnswerEditPayload(key,");
  at("roleFamilyForTypedRole(");
  const refusal = at("typedRoleRefusal(viewer,");
  const refuse = at("recruitmentProblem(refusal, 400)");
  const save = at("saveCandidateWhatsAppAnswer(candidateId,");

  assert.ok(access < worker, "the worker gate comes right after the permission check");
  assert.ok(worker < visible, "the worker gate comes before anything is read about the candidate");
  assert.ok(visible < payload && visible < save, "assertCandidateVisible stays ahead of the save");
  assert.ok(payload < refusal, "the role is judged after the answer itself is checked");
  assert.ok(refusal < refuse, "a refusal is answered with a 400");
  assert.ok(refuse < save, "the refusal comes BEFORE the save — a refused role writes nothing");

  assert.match(
    route,
    /typedRoleRefusal\(viewer, roleFamilyForTypedRole\(typedRole\)\)/,
    "the refusal judges the family the typed words read as, resolved the way the saver resolves them",
  );
  assert.match(route, /const viewer = assertWorkspaceWorker\(access\);/, "the viewer the refusal judges is the worker gate's own");
  assert.match(route, /if \(key === "job_title"\) \{/, "only the role answer is judged for a tab");
  assert.match(route, /typeof body\.value === "string" \? body\.value : null/, "a non-text value is left to the answer check, never read as a role");
}

export async function runRecruitmentAnswerEditFenceTests() {
  runRefusalTests();
  runWorkerGateTests();
  runRouteTests();
}
