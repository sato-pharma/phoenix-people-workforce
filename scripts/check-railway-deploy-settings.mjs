#!/usr/bin/env node
// Do the deploy settings Railway has STORED still match `.railway/railway.ts`? Read-only.
//
// 🔴 WHY THIS EXISTS. Since 2026-10-23 `.railway/railway.ts` is the only deploy config — both
// `railway.toml` files were retired (docs/deployment.md, "The cutover, 2026-10-23"). The toml was
// re-applied at EVERY deploy, so a setting changed in the dashboard snapped back on the next build. The
// authoring file is applied only when someone runs `railway config apply`, so a dashboard edit now
// STAYS — and nothing in this repo would see it. Measured the day of the cutover: the website's
// stored healthcheck window read 300 s while every file said 900, because the toml had been masking
// it. A window that short strands a deploy behind the release gate on a slow CI day, with nothing red.
//
// WHAT IT COMPARES, per service declared in the authoring file, against the PRODUCTION environment:
//   - healthcheckPath and healthcheckTimeout, where the file declares them;
//   - restartPolicyType and restartPolicyMaxRetries, where the file declares them;
//   - every volume the file mounts: the live volume must exist and be mounted on that service at that
//     path — a detached disk is how every tablet app download goes 404.
// It also names a live volume the file does not declare at all, because a plan from that file would
// try to detach it.
//
// 🔴 A SERVICE DECLARED AHEAD OF ITS CREATION IS NOT DRIFT (2026-11-14). The robot service's block was
// merged on 13 Nov with the service itself still to be created by the owner, by hand, and the next
// day's run reported "a dashboard edit" when nobody had touched Railway. A name in AWAITING_CREATION
// below that is absent from Railway is printed as a note and the run stays at exit 0. The moment the
// service exists it is compared like every other one, listed or not, and the note asks for the name
// to come off the list — while it stays there, that service vanishing again would read as "not created
// yet" instead of drift.
//
// Exit 0 = matches · 1 = drift (each line says what and where) · 2 = cannot tell (no credential, the
// API refused, or the authoring file could not be read). A 2 is NEVER a pass.
//
// The credential is tried as an ACCOUNT token (Authorization: Bearer) and then as a PROJECT token
// (Project-Access-Token), the same two-way try scripts/validate-railway-production-secrets.mjs makes,
// because the owner cannot be expected to know which kind he minted.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://backboard.railway.com/graphql/v2";

/**
 * Services `.railway/railway.ts` declares before they exist on Railway, each with where its creation
 * steps are written. Add a name in the change that declares the service; take it off in the change
 * that follows its creation. tests/railway-deploy-settings-drift.test.ts refuses a name the authoring
 * file does not declare. An entry is `["service-name", "where its creation steps are written"]`.
 *
 * Empty since 14 Nov 2026: `phoenix-workforce-robot`, the one name it has held, was created that day
 * and came off, so that service vanishing from Railway is reported as drift again.
 */
export const AWAITING_CREATION = new Map([]);

/** Full-line `//` comments out; the authoring file's prose names every field this reads. */
function stripLineComments(source) {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * The settings `.railway/railway.ts` declares, per service: `{ services: { name: { healthcheckPath?,
 * healthcheckTimeout?, restartPolicyType?, restartPolicyMaxRetries?, mounts: [{ path, volume }] } },
 * volumes: [name] }`. Only what the file states is returned — a field it leaves out is not compared.
 */
export function parseAuthoringFile(source) {
  const code = stripLineComments(source);
  const volumeVars = new Map();
  for (const [, variable, name] of code.matchAll(/const\s+(\w+)\s*=\s*volume\(\s*"([^"]+)"/g)) {
    volumeVars.set(variable, name);
  }
  const services = {};
  const starts = [...code.matchAll(/service\(\s*"([^"]+)"/g)];
  starts.forEach((match, index) => {
    const block = code.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : undefined);
    const entry = { mounts: [] };
    const path = /healthcheckPath:\s*"([^"]+)"/.exec(block);
    if (path) entry.healthcheckPath = path[1];
    const timeout = /healthcheckTimeout:\s*(\d+)/.exec(block);
    if (timeout) entry.healthcheckTimeout = Number(timeout[1]);
    const policy = /restartPolicyType:\s*"([A-Z_]+)"/.exec(block);
    if (policy) entry.restartPolicyType = policy[1];
    const retries = /restartPolicyMaxRetries:\s*(\d+)/.exec(block);
    if (retries) entry.restartPolicyMaxRetries = Number(retries[1]);
    const mounts = /volumeMounts:\s*\{([^}]*)\}/.exec(block);
    if (mounts) {
      for (const [, mountPath, variable] of mounts[1].matchAll(/"([^"]+)"\s*:\s*(\w+)/g)) {
        entry.mounts.push({ path: mountPath, volume: volumeVars.get(variable) ?? `(unknown variable ${variable})` });
      }
    }
    services[match[1]] = entry;
  });
  return { services, volumes: [...volumeVars.values()] };
}

/**
 * Compare what the file declares with what Railway stores. `live` is `{ services: { name: { id,
 * healthcheckPath, healthcheckTimeout, restartPolicyType, restartPolicyMaxRetries } }, volumes: [{
 * name, mountPath, serviceId }] }` for ONE environment. Returns one plain-words line per difference.
 * A declared service that is absent from Railway and named in `awaiting` is not a difference.
 */
export function compareDeploySettings(declared, live, awaiting = AWAITING_CREATION) {
  const drift = [];
  const nameById = new Map(Object.entries(live.services).map(([name, s]) => [s.id, name]));
  for (const [name, want] of Object.entries(declared.services)) {
    const have = live.services[name];
    if (!have) {
      if (awaiting.has(name)) continue;
      drift.push(`${name}: declared in .railway/railway.ts but not found on Railway (a service declared ahead of its creation is named in AWAITING_CREATION in scripts/check-railway-deploy-settings.mjs)`);
      continue;
    }
    for (const field of ["healthcheckPath", "healthcheckTimeout", "restartPolicyType", "restartPolicyMaxRetries"]) {
      if (!(field in want)) continue;
      if (have[field] !== want[field]) {
        drift.push(`${name}: ${field} is ${JSON.stringify(have[field] ?? null)} on Railway, ${JSON.stringify(want[field])} in .railway/railway.ts`);
      }
    }
    for (const mount of want.mounts) {
      const volume = live.volumes.find((v) => v.name === mount.volume);
      if (!volume) {
        drift.push(`${name}: volume ${mount.volume} is declared but does not exist on Railway`);
      } else if (volume.serviceId !== have.id || volume.mountPath !== mount.path) {
        const where = volume.serviceId ? `${nameById.get(volume.serviceId) ?? volume.serviceId} at ${volume.mountPath}` : "nothing (detached)";
        drift.push(`${name}: volume ${mount.volume} should be mounted at ${mount.path}, but Railway has it on ${where}`);
      }
    }
  }
  for (const volume of live.volumes) {
    if (!declared.volumes.includes(volume.name)) {
      drift.push(`volume ${volume.name} exists on Railway but .railway/railway.ts does not declare it — a plan from the file would detach it`);
    }
  }
  return drift;
}

/**
 * Which names in `awaiting` are still to be created (`pending`: declared, absent from Railway) and
 * which have been created since (`created`: on Railway, so compared in full and due off the list).
 */
export function servicesAwaitingCreation(declared, live, awaiting = AWAITING_CREATION) {
  const pending = [];
  const created = [];
  for (const name of awaiting.keys()) {
    if (!(name in declared.services)) continue;
    (live.services[name] ? created : pending).push(name);
  }
  return { pending, created };
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

export async function readLiveSettings(token, projectId, environmentName) {
  const data = await query(
    token,
    `query { project(id: ${JSON.stringify(projectId)}) {
      environments { edges { node { id name } } }
      volumes { edges { node { name volumeInstances { edges { node { mountPath serviceId environmentId } } } } } }
      services { edges { node { id name serviceInstances { edges { node {
        environmentId healthcheckPath healthcheckTimeout restartPolicyType restartPolicyMaxRetries } } } } } }
    } }`,
  );
  const environment = data.project.environments.edges.map((e) => e.node).find((e) => e.name === environmentName);
  if (!environment) throw new Error(`no environment named ${environmentName}`);
  const services = {};
  for (const { node } of data.project.services.edges) {
    const instance = node.serviceInstances.edges.map((e) => e.node).find((i) => i.environmentId === environment.id);
    if (instance) services[node.name] = { id: node.id, ...instance };
  }
  const volumes = [];
  for (const { node } of data.project.volumes.edges) {
    const instance = node.volumeInstances.edges.map((e) => e.node).find((i) => i.environmentId === environment.id);
    volumes.push({ name: node.name, mountPath: instance?.mountPath ?? null, serviceId: instance?.serviceId ?? null });
  }
  return { services, volumes };
}

async function main() {
  const token = (process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN || "").trim();
  const projectId = (process.env.RAILWAY_PROJECT_ID || "").trim();
  const environmentName = (process.env.RAILWAY_ENVIRONMENT || "production").trim();
  if (!token || !projectId) {
    console.log("[railway-deploy-settings] CANNOT TELL — RAILWAY_API_TOKEN (or RAILWAY_TOKEN) and RAILWAY_PROJECT_ID are required. This is not a pass.");
    process.exitCode = 2;
    return;
  }
  let declared;
  try {
    declared = parseAuthoringFile(readFileSync(resolve(".railway/railway.ts"), "utf8"));
  } catch (error) {
    console.log(`[railway-deploy-settings] CANNOT TELL — .railway/railway.ts could not be read: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const count = Object.keys(declared.services).length;
  if (count === 0) {
    console.log("[railway-deploy-settings] CANNOT TELL — no service(...) block was read out of .railway/railway.ts, so nothing was compared.");
    process.exitCode = 2;
    return;
  }
  let live;
  try {
    live = await readLiveSettings(token, projectId, environmentName);
  } catch (error) {
    console.log(`[railway-deploy-settings] CANNOT TELL — Railway's API refused or failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const drift = compareDeploySettings(declared, live);
  const { pending, created } = servicesAwaitingCreation(declared, live);
  for (const name of pending) {
    console.log(`[railway-deploy-settings] NOTE — ${name} is declared in .railway/railway.ts and has not been created on Railway yet (${AWAITING_CREATION.get(name)}). Not drift.`);
  }
  for (const name of created) {
    console.log(`[railway-deploy-settings] NOTE — ${name} now exists on Railway and is compared like every other service. Take it out of AWAITING_CREATION in scripts/check-railway-deploy-settings.mjs, so that its disappearing later is reported.`);
  }
  if (drift.length) {
    console.log(`[railway-deploy-settings] DRIFT — ${drift.length} stored setting(s) on ${environmentName} differ from .railway/railway.ts:`);
    for (const line of drift) console.log(`  - ${line}`);
    console.log("  Fix: put the intended value in .railway/railway.ts and apply it (docs/deployment.md, \"The cutover, 2026-10-23\"), or apply the file as it stands.");
    process.exitCode = 1;
    return;
  }
  console.log(`[railway-deploy-settings] OK — ${count - pending.length} services and ${declared.volumes.length} volumes on ${environmentName} match .railway/railway.ts.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
