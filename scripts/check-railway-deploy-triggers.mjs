#!/usr/bin/env node
// Does every git-deployed Railway service instance still have a deployment trigger? Read-only.
//
// 🔴 WHY THIS EXISTS. On 2026-10-23 the staging application was found dead: the domain
// phoenix-people-workforce-staging.up.railway.app answered 404 with
// {"status":"error","code":404,"message":"Application not found"}. Nothing was misconfigured in the
// app and no variable was missing — the project had three deployment triggers and ALL THREE were on
// the production environment. Staging had none, so no merge had deployed it since 14 Oct 11:48 Cairo:
// nine days of merges, and staging simply stopped following them.
//
// THAT FAILURE IS SILENT IN EVERY DIRECTION, which is the whole reason for this file:
//   - the edge answers 404, not 502, so it reads like a DELETED DOMAIN rather than a stale service —
//     the domain, the service, the GitHub source and all 50 variables were present and correct;
//   - nothing turns red. No CI check, no deploy-failure alert and no drift check looked at whether an
//     environment is still WIRED to the repository, only at what it is wired WITH;
//   - railway status and the dashboard both show the source branch, and it still read "main" the
//     entire nine days. A source branch is not a trigger.
//
// WHAT IT CHECKS, and the invariant is DERIVED rather than listed, so it cannot rot as services come
// and go: every service instance whose source is a GIT REPOSITORY must have a deployment trigger in
// ITS OWN environment. An instance deployed from an IMAGE is exempt by definition — phoenix-cron
// (alpine:3) and headwind-db-eu (a postgres image) have no git source and are correctly untriggered.
// It also names a trigger pointing at a different repository than the instance deploys from, a trigger
// with no branch, and a trigger for an environment/service pair that has no git source at all.
//
// 🔴 SINCE THE ACCOUNT MOVE (2026-10-27) IT ALSO CHECKS THE OWNER. The move left 7 of the 8 triggers
// on the old GitHub account for two hours while every source already read the new one, and the old
// check passed them: it only compared a trigger's repository with its instance's, and both still
// named a repository that existed (GitHub redirects a moved one). A source or a trigger on any owner
// but the one its repository belongs on is a finding, because it stops deploying the day the old
// account's app is removed. Since 2026-11-06 that is GITHUB_OWNER for this repository and
// PERSONAL_OWNER for the rest (the website stayed there): expectedOwnerOf in required-check-names.mjs.
//
// It reads EVERY project in RAILWAY_PROJECT_ID plus RAILWAY_PROJECT_IDS (comma- or space-separated).
// Before 2026-10-27 it read Phoenix only, so the website's three services were never checked.
//
// Exit 0 = every git-sourced instance is wired · 1 = at least one is not (each line says which and
// what it costs) · 2 = cannot tell (no credential, or the API refused a project). A 2 is NEVER a pass.
//
// The credential is tried as an ACCOUNT token (Authorization: Bearer) and then as a PROJECT token
// (Project-Access-Token), the same two-way try scripts/check-railway-deploy-settings.mjs makes.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedOwnerOf, GITHUB_OWNER, PERSONAL_OWNER } from "./required-check-names.mjs";

const API = "https://backboard.railway.com/graphql/v2";

const ownerOf = (slug) => String(slug).split("/")[0].toLowerCase();

/** Every project to read: RAILWAY_PROJECT_ID first, then RAILWAY_PROJECT_IDS, each once. */
export function projectIdsFrom(env) {
  const ids = [env.RAILWAY_PROJECT_ID, ...String(env.RAILWAY_PROJECT_IDS || "").split(/[\s,]+/)]
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/**
 * The gaps between what deploys from git and what is wired to deploy. `live` is `{ environments: [{
 * id, name }], services: [{ id, name }], instances: [{ environmentId, serviceId, repo }], triggers:
 * [{ environmentId, serviceId, branch, repository }] }`, where `repo` is null for an image-sourced
 * instance. `owner` is the account this repository sits on and `personal` the account every other
 * repository of ours sits on; each source and trigger is held to its own repository's. Returns one
 * plain-words line per gap.
 */
export function findTriggerGaps(live, { owner = GITHUB_OWNER, personal = PERSONAL_OWNER } = {}) {
  const environmentName = new Map(live.environments.map((e) => [e.id, e.name]));
  const serviceName = new Map(live.services.map((s) => [s.id, s.name]));
  const where = (environmentId, serviceId) =>
    `${environmentName.get(environmentId) ?? environmentId}/${serviceName.get(serviceId) ?? serviceId}`;
  const ownerFor = (slug) => expectedOwnerOf(slug, owner, personal);
  const notOurs = (slug) => Boolean(slug) && ownerOf(slug) !== ownerFor(slug).toLowerCase();
  const gaps = [];

  for (const instance of live.instances) {
    if (!instance.repo) continue;
    if (notOurs(instance.repo)) {
      gaps.push(
        `${where(instance.environmentId, instance.serviceId)}: deploys from ${instance.repo}, which ${ownerFor(instance.repo)} does not own — ` +
          "it keeps deploying only while that account's GitHub app stays installed",
      );
    }
    const triggers = live.triggers.filter(
      (t) => t.environmentId === instance.environmentId && t.serviceId === instance.serviceId,
    );
    if (triggers.length === 0) {
      gaps.push(
        `${where(instance.environmentId, instance.serviceId)}: deploys from ${instance.repo} but has NO deployment trigger — ` +
          "no merge will ever deploy it, its source branch still reads correctly, and nothing turns red",
      );
      continue;
    }
    for (const trigger of triggers) {
      if (notOurs(trigger.repository)) {
        gaps.push(
          `${where(instance.environmentId, instance.serviceId)}: its deployment trigger watches ${trigger.repository}, ` +
            `which ${ownerFor(trigger.repository)} does not own — merges on ${ownerFor(trigger.repository)} will not fire it`,
        );
      }
      if (trigger.repository && trigger.repository !== instance.repo) {
        gaps.push(
          `${where(instance.environmentId, instance.serviceId)}: its deployment trigger watches ${trigger.repository}, ` +
            `but the instance deploys from ${instance.repo}`,
        );
      }
      if (!trigger.branch) {
        gaps.push(
          `${where(instance.environmentId, instance.serviceId)}: its deployment trigger has no branch, so it can never fire`,
        );
      }
    }
  }

  for (const trigger of live.triggers) {
    const instance = live.instances.find(
      (i) => i.environmentId === trigger.environmentId && i.serviceId === trigger.serviceId,
    );
    if (!instance) {
      gaps.push(
        `${where(trigger.environmentId, trigger.serviceId)}: a deployment trigger on branch ${trigger.branch ?? "(none)"} ` +
          "points at an environment/service pair that has no service instance",
      );
    } else if (!instance.repo) {
      gaps.push(
        `${where(trigger.environmentId, trigger.serviceId)}: a deployment trigger on branch ${trigger.branch ?? "(none)"} ` +
          "points at an instance deployed from an image, not from git",
      );
    }
  }

  return gaps;
}

/** One line per git-sourced instance and the branch that deploys it — the record a human reads. */
export function describeWiring(live) {
  const environmentName = new Map(live.environments.map((e) => [e.id, e.name]));
  const serviceName = new Map(live.services.map((s) => [s.id, s.name]));
  return live.instances
    .filter((instance) => instance.repo)
    .map((instance) => {
      const trigger = live.triggers.find(
        (t) => t.environmentId === instance.environmentId && t.serviceId === instance.serviceId,
      );
      const environment = environmentName.get(instance.environmentId) ?? instance.environmentId;
      const service = serviceName.get(instance.serviceId) ?? instance.serviceId;
      return `${environment}/${service} <- ${trigger ? `${instance.repo}@${trigger.branch}` : "NOTHING"}`;
    })
    .sort();
}

async function query(token, body) {
  let lastError = "no credential";
  for (const headers of [{ authorization: `Bearer ${token}` }, { "project-access-token": token }]) {
    const response = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query: body }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && json.data && !json.errors) return json.data;
    lastError = `HTTP ${response.status} ${JSON.stringify(json.errors ?? json).slice(0, 200)}`;
    if (!/not authorized|unauthorized|invalid/i.test(lastError) && response.status !== 401 && response.status !== 403) break;
  }
  throw new Error(lastError);
}

export async function readLiveWiring(token, projectId) {
  const data = await query(
    token,
    `query { project(id: ${JSON.stringify(projectId)}) {
      name
      environments { edges { node { id name } } }
      deploymentTriggers { edges { node { environmentId serviceId branch repository } } }
      services { edges { node { id name serviceInstances { edges { node {
        environmentId source { repo image } } } } } } }
    } }`,
  );
  const project = data.project;
  const services = [];
  const instances = [];
  for (const { node } of project.services.edges) {
    services.push({ id: node.id, name: node.name });
    for (const { node: instance } of node.serviceInstances.edges) {
      instances.push({
        environmentId: instance.environmentId,
        serviceId: node.id,
        repo: instance.source?.repo ?? null,
      });
    }
  }
  return {
    name: project.name ?? projectId,
    environments: project.environments.edges.map((e) => ({ id: e.node.id, name: e.node.name })),
    services,
    instances,
    triggers: project.deploymentTriggers.edges.map((e) => e.node),
  };
}

async function main() {
  const token = (process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN || "").trim();
  const projectIds = projectIdsFrom(process.env);
  if (!token || projectIds.length === 0) {
    console.log(
      "[railway-deploy-triggers] CANNOT TELL — RAILWAY_API_TOKEN (or RAILWAY_TOKEN) and RAILWAY_PROJECT_ID are required. This is not a pass.",
    );
    process.exitCode = 2;
    return;
  }
  const gaps = [];
  const unread = [];
  let deployedCount = 0;
  for (const projectId of projectIds) {
    let live;
    try {
      live = await readLiveWiring(token, projectId);
    } catch (error) {
      unread.push(`${projectId}: Railway's API refused or failed: ${error.message}`);
      continue;
    }
    const deployed = live.instances.filter((instance) => instance.repo);
    if (deployed.length === 0) {
      unread.push(`${live.name}: the project reports no git-sourced service instance at all, so nothing was compared`);
      continue;
    }
    deployedCount += deployed.length;
    console.log(`  [${live.name}]`);
    for (const line of describeWiring(live)) console.log(`    ${line}`);
    for (const line of findTriggerGaps(live)) gaps.push(`${live.name} · ${line}`);
  }
  if (gaps.length) {
    console.log(`[railway-deploy-triggers] UNWIRED — ${gaps.length} problem(s):`);
    for (const line of gaps) console.log(`  - ${line}`);
    for (const line of unread) console.log(`  - and could not read ${line}`);
    console.log(
      '  Fix: add the missing trigger on the environment that lost it, or repoint the source and trigger to the owner named above (docs/deployment.md, "Staging stopped deploying because its trigger was gone").',
    );
    process.exitCode = 1;
    return;
  }
  if (unread.length) {
    console.log(`[railway-deploy-triggers] CANNOT TELL — ${unread.length} of ${projectIds.length} project(s) could not be read. This is not a pass:`);
    for (const line of unread) console.log(`  - ${line}`);
    process.exitCode = 2;
    return;
  }
  console.log(
    `[railway-deploy-triggers] OK — all ${deployedCount} git-sourced service instances across ${projectIds.length} project(s) deploy from the owner their repository belongs on (${GITHUB_OWNER} for this one, ${PERSONAL_OWNER} for the rest) and have a deployment trigger in their own environment.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
