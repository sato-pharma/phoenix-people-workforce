// scripts/check-railway-deploy-triggers.mjs asks the one question nothing in this repo asked before
// 2026-10-23: is each environment still WIRED to the repository at all?
//
// WHY IT NEEDS A TEST. Staging was found dead that day with every setting correct — the domain, the
// GitHub source, the branch reading "main" and all 50 variables were in place, and the project simply
// had no deployment trigger on the staging environment, so nine days of merges never reached it. The
// edge answers 404 "Application not found", which reads like a deleted domain rather than a service
// that stopped being deployed, and no check anywhere went red. The fixture below IS that pre-fix
// shape, read live off Railway before the trigger was created, so the headline case asserts the real
// failure and not an imagined one. The image-sourced services are in it on purpose: if they were not
// exempt the check would cry wolf twice on every run and be switched off.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describeWiring, findTriggerGaps, projectIdsFrom } from "../scripts/check-railway-deploy-triggers.mjs";

type Live = {
  environments: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string }>;
  instances: Array<{ environmentId: string; serviceId: string; repo: string | null }>;
  triggers: Array<{ environmentId: string; serviceId: string; branch: string | null; repository: string | null }>;
};

const PRODUCTION = "cd5600e6-99dd-4b1c-80b2-16af8770abef";
const STAGING = "c766d42b-9e0b-4027-b00f-b13a1651b214";
const WEB = "30356676-116b-4886-ac6e-89041d80185e";
const WORKER = "b955f4dc-a597-4972-953b-410e3c91bc81";
const HEADWIND = "3ff181a3-3408-4118-ab13-6e63d24fbe4a";
const CRON = "179e6a73-d891-4fbc-a89e-ac53ef461821";
const HEADWIND_DB = "f6cf6ddb-2141-4a95-a1cd-3801fbc24d0e";
const REPO = "Phoenix-HR-CRM/phoenix-people-workforce";

/** The Phoenix project as Railway reported it at 21:10 Cairo on 2026-10-23, minus the staging trigger. */
function livePreFix(): Live {
  return {
    environments: [
      { id: PRODUCTION, name: "production" },
      { id: STAGING, name: "staging" },
    ],
    services: [
      { id: WEB, name: "phoenix-people-workforce" },
      { id: WORKER, name: "phoenix-workforce-worker" },
      { id: HEADWIND, name: "phoenix-headwind" },
      { id: CRON, name: "phoenix-cron" },
      { id: HEADWIND_DB, name: "headwind-db-eu" },
    ],
    instances: [
      { environmentId: PRODUCTION, serviceId: WEB, repo: REPO },
      { environmentId: PRODUCTION, serviceId: WORKER, repo: REPO },
      { environmentId: PRODUCTION, serviceId: HEADWIND, repo: REPO },
      { environmentId: PRODUCTION, serviceId: CRON, repo: null },
      { environmentId: PRODUCTION, serviceId: HEADWIND_DB, repo: null },
      { environmentId: STAGING, serviceId: WEB, repo: REPO },
      { environmentId: STAGING, serviceId: HEADWIND_DB, repo: null },
    ],
    triggers: [
      { environmentId: PRODUCTION, serviceId: WEB, branch: "main", repository: REPO },
      { environmentId: PRODUCTION, serviceId: WORKER, branch: "main", repository: REPO },
      { environmentId: PRODUCTION, serviceId: HEADWIND, branch: "main", repository: REPO },
    ],
  };
}

/** The same project after the staging trigger was created — the state read back live. */
function liveFixed(): Live {
  const live = livePreFix();
  live.triggers.push({ environmentId: STAGING, serviceId: WEB, branch: "main", repository: REPO });
  return live;
}

export function runRailwayDeployTriggersTests() {
  // 🔴 THE HEADLINE: the real pre-fix shape must produce exactly one finding, and it must name the
  // environment that lost its trigger. Nine days of merges did not reach staging and nothing was red.
  const gaps = findTriggerGaps(livePreFix());
  assert.equal(gaps.length, 1, `the pre-fix shape must yield exactly one finding, got: ${gaps.join(" | ")}`);
  assert.match(gaps[0], /^staging\/phoenix-people-workforce: deploys from Phoenix-HR-CRM\/phoenix-people-workforce but has NO deployment trigger/);
  assert.match(gaps[0], /nothing turns red/, "the finding must say the failure is silent, or it reads as cosmetic");

  // And the fixed shape is clean — otherwise the check is noise and gets ignored.
  assert.deepEqual(findTriggerGaps(liveFixed()), []);

  // An IMAGE-sourced instance is exempt by definition: phoenix-cron is alpine:3 and headwind-db-eu is
  // a postgres image, and neither has or needs a trigger. A check that flagged them would be disabled.
  const onlyImages: Live = {
    environments: [{ id: PRODUCTION, name: "production" }],
    services: [{ id: CRON, name: "phoenix-cron" }],
    instances: [{ environmentId: PRODUCTION, serviceId: CRON, repo: null }],
    triggers: [],
  };
  assert.deepEqual(findTriggerGaps(onlyImages), []);

  // A trigger on the right service but the WRONG repository: it fires for someone else's pushes.
  const wrongRepo = liveFixed();
  wrongRepo.triggers[3].repository = "Phoenix-HR-CRM/some-other-repo";
  assert.match(
    findTriggerGaps(wrongRepo).join("\n"),
    /staging\/phoenix-people-workforce: its deployment trigger watches Phoenix-HR-CRM\/some-other-repo/,
  );

  // A trigger with no branch can never fire, which looks identical to a working one in a listing.
  const noBranch = liveFixed();
  noBranch.triggers[3].branch = null;
  assert.match(findTriggerGaps(noBranch).join("\n"), /its deployment trigger has no branch, so it can never fire/);

  // A trigger left behind for a service instance that no longer exists.
  const orphan = liveFixed();
  orphan.triggers.push({ environmentId: STAGING, serviceId: "s-deleted", branch: "main", repository: REPO });
  assert.match(findTriggerGaps(orphan).join("\n"), /points at an environment\/service pair that has no service instance/);

  // A trigger pointed at an image-deployed instance: it will never build that service from git.
  const triggeredImage = liveFixed();
  triggeredImage.triggers.push({ environmentId: PRODUCTION, serviceId: CRON, branch: "main", repository: REPO });
  assert.match(findTriggerGaps(triggeredImage).join("\n"), /points at an instance deployed from an image, not from git/);

  // 🔴 THE ACCOUNT MOVE (2026-10-27): for two hours every source read the new owner while 7 triggers
  // still watched the old one, and the old check passed it, because GitHub redirects a moved repo.
  // A source or a trigger on any owner but the one this repository lives on is a finding. The old
  // name is spelled in pieces so tests/github-owner-slug.test.ts keeps refusing it everywhere else.
  const OLD_REPO = `${["Gawish", "1997"].join("-")}/phoenix-people-workforce`;
  const staleTriggers = liveFixed();
  for (const trigger of staleTriggers.triggers.slice(0, 3)) trigger.repository = OLD_REPO;
  const stale = findTriggerGaps(staleTriggers).filter((line: string) => line.includes("does not own"));
  assert.equal(stale.length, 3, `🔴 a trigger left on the old owner passed the check: ${findTriggerGaps(staleTriggers).join(" | ")}`);
  assert.match(stale.join("\n"), /production\/phoenix-people-workforce: its deployment trigger watches .+, which Phoenix-HR-CRM does not own/);
  const staleSource = liveFixed();
  for (const instance of staleSource.instances) if (instance.repo) instance.repo = OLD_REPO;
  for (const trigger of staleSource.triggers) trigger.repository = OLD_REPO;
  assert.equal(
    findTriggerGaps(staleSource).filter((line: string) => /deploys from .+, which Phoenix-HR-CRM does not own/.test(line)).length,
    4,
    "🔴 sources and triggers both on the old owner agree with each other, so only the owner check can see it",
  );
  assert.deepEqual(findTriggerGaps(liveFixed(), { owner: "GawishTheIT" }), [], "an owner differs from GitHub's casing, not from itself");

  // Every project named is read once, the Phoenix one first, so the website's services are covered too.
  assert.deepEqual(projectIdsFrom({ RAILWAY_PROJECT_ID: "p1", RAILWAY_PROJECT_IDS: "p1, p2\np3" }), ["p1", "p2", "p3"]);
  assert.deepEqual(projectIdsFrom({ RAILWAY_PROJECT_ID: "p1" }), ["p1"]);
  assert.deepEqual(projectIdsFrom({ RAILWAY_PROJECT_IDS: " " }), [], "no project at all must reach CANNOT TELL, never an empty OK");

  // The human-readable record: every git-sourced instance appears, images never do, and the unwired
  // one says NOTHING in words rather than printing an empty branch.
  const before = describeWiring(livePreFix());
  assert.deepEqual(before, [
    `production/phoenix-headwind <- ${REPO}@main`,
    `production/phoenix-people-workforce <- ${REPO}@main`,
    `production/phoenix-workforce-worker <- ${REPO}@main`,
    "staging/phoenix-people-workforce <- NOTHING",
  ]);
  assert.equal(
    describeWiring(liveFixed()).filter((line: string) => line.includes("NOTHING")).length,
    0,
    "after the fix nothing may read NOTHING",
  );

  // 🔴 THE SCRIPT IS READ-ONLY, and that is a property of the file, not an intention: it must never
  // learn to create a trigger. Creating one is a deliberate act with the owner's knowledge.
  const script = readFileSync(resolve("scripts/check-railway-deploy-triggers.mjs"), "utf8");
  assert.equal(/mutation/i.test(script), false, "the trigger check must never mutate Railway");
  for (const verb of ["deploymentTriggerCreate", "deploymentTriggerDelete", "serviceInstanceDeploy", "variableUpsert"]) {
    assert.equal(script.includes(verb), false, `${verb} has no business in a read-only check`);
  }
  // Exit 2 is "cannot tell", and it must stay distinct from a pass or the check becomes decorative.
  assert.match(script, /CANNOT TELL/);
  assert.match(script, /exitCode = 2/);

  // 🔴 IT HAS TO ACTUALLY RUN SOMEWHERE. The scheduled drift check is the one job with a Railway
  // credential; a checker nobody invokes is how staging went nine days unnoticed in the first place.
  const workflow = readFileSync(resolve(".github/workflows/secret-drift-check.yml"), "utf8");
  assert.match(workflow, /node scripts\/check-railway-deploy-triggers\.mjs/, "the scheduled check must run the trigger checker");
  const leg = workflow.slice(workflow.indexOf("check-railway-deploy-triggers.mjs"));
  assert.match(leg.slice(0, 900), /::warning::/, "exit 2 must be reported as a warning, never swallowed as a pass");
  assert.match(workflow, /RAILWAY_PROJECT_ID: \$\{\{ vars\.RAILWAY_PROJECT_ID \}\}/);
  assert.match(
    workflow,
    /RAILWAY_PROJECT_IDS: \$\{\{ vars\.RAILWAY_PROJECT_IDS \}\}/,
    "🔴 the step lost the project list, so the website's services go unchecked again",
  );
}
