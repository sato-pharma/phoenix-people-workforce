import { strict as assert } from "node:assert";

import {
  checkLaunchReadiness,
  draftLaunchCopy,
  extractLaunchTasks,
  generateOwnerChecklists,
} from "../src/lib/launch-desk/tools.ts";
import type { LaunchDeskInput } from "../src/lib/launch-desk/types.ts";

const referenceDate = new Date("2026-06-19T00:00:00.000Z");

export function runLaunchDeskToolTests() {
  const completeInput: LaunchDeskInput = {
    productBrief:
      "Launch a release-planning assistant for engineering teams that turns rough product ideas into release tasks, risks, launch copy, and follow-up questions. The first release should be guarded by a feature flag and used by a small pilot group before wider rollout.",
    audience: "Engineering managers, product managers, QA leads, and support leads.",
    launchDate: "2026-07-15",
    constraints: "Needs a rollback switch, observability, security review, and a support FAQ before launch.",
    assets: "Product brief, draft changelog, pilot customer list, and Figma screen.",
  };

  const taskResult = extractLaunchTasks(completeInput, referenceDate);
  assert.ok(taskResult.tasks.length >= 7, "extracts a practical task list");
  assert.ok(taskResult.tasks.some((task) => task.id === "security-review"), "adds security review when constraints require it");
  assert.ok(taskResult.tasks.some((task) => task.ownerRole === "Engineering lead"), "assigns engineering owner role");
  assert.ok(taskResult.tasks.every((task) => task.priority && task.phase && task.dueHint), "tasks include priority, phase, and due hint");

  const readiness = checkLaunchReadiness(completeInput, referenceDate);
  assert.ok(readiness.score >= 75, "complete launch input receives a strong readiness score");
  assert.ok(readiness.riskRegister.some((risk) => risk.id === "security-delay"), "security constraints create a security risk");
  assert.equal(readiness.followUpQuestions.some((question) => /rollback/i.test(question)), false, "rollback question is absent when rollback is provided");

  const checklists = generateOwnerChecklists(completeInput, referenceDate);
  assert.ok(checklists.owners.some((owner) => owner.ownerRole === "Engineering lead"), "owner checklist includes engineering lead");
  assert.ok(checklists.owners.some((owner) => owner.checklist.some((item) => /Risk:/i.test(item))), "risk mitigations are routed to owners");

  const copy = draftLaunchCopy(completeInput);
  assert.deepEqual(
    copy.drafts.map((draft) => draft.channel).sort(),
    ["changelog", "customer_email", "executive_update", "internal_slack"].sort(),
    "drafts all expected launch copy channels",
  );

  const incompleteInput: LaunchDeskInput = {
    productBrief: "Launch a new dashboard for beta customers, but details are still rough.",
    audience: "",
    launchDate: "",
    constraints: "",
    assets: "",
  };

  const incompleteReadiness = checkLaunchReadiness(incompleteInput, referenceDate);
  assert.equal(incompleteReadiness.verdict, "blocked", "missing critical details blocks readiness");
  assert.ok(incompleteReadiness.followUpQuestions.some((question) => /audience/i.test(question)), "asks for missing audience");
  assert.ok(incompleteReadiness.followUpQuestions.some((question) => /launch date/i.test(question)), "asks for missing launch date");
  assert.ok(incompleteReadiness.riskRegister.some((risk) => risk.id === "rollback-gap"), "missing rollback creates high risk");
}
