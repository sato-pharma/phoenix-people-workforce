#!/usr/bin/env node
// The FALLBACK route to production — an image built on GitHub, for the day Railway cannot build (owner, 2026-10-21).
//
// WHY. On 20 Oct 2026 Railway paused every build for hours (five merges sat unserved), and on 21 Oct it did it again
// (status page: "Dashboard and API unavailable, builds paused"; five more merges unserved from 10:17 Cairo). The old
// version kept serving both times — only NEW code could not go live. The normal route needs Railway's builder and the
// urgent route (`railway up`) needs it too, so neither helps. This route moves the BUILD to GitHub's own runners,
// stores the image in ghcr.io, and points the Railway service at that image — a deploy of a finished image needs no
// builder. Account and rules: docs/deployment.md, "The fallback route".
//
//   node scripts/fallback-image-deploy.mjs read     [--env production]                    (read-only)
//   node scripts/fallback-image-deploy.mjs build-values [--from-env] --out <file>         (the NEXT_PUBLIC values to bake)
//   node scripts/fallback-image-deploy.mjs switch   --sha <40 hex> [--services web,worker]  (production, from the workflow)
//   node scripts/fallback-image-deploy.mjs restore  [--services web,worker]               (back to the git source)
//   node scripts/fallback-image-deploy.mjs rehearse --sha <40 hex>                        (a throwaway service in STAGING)
//   node scripts/fallback-image-deploy.mjs cleanup                                        (delete leftover rehearsal services)
//
// 🔴 THE GIT SOURCE IS SERVICE-LEVEL, SHARED BY EVERY ENVIRONMENT (AGENTS.md §2.3: `railway service source connect
// --environment staging` once repointed PRODUCTION). Staging and production are two instances of the SAME service, so
// `switch` and `restore` refuse `--env staging` — a "staging test" of a source change would be a production change.
// The rehearsal therefore creates its OWN service and deletes it, and touches nothing else.
//
// 🔴 A CLI/DASHBOARD IS NOT NEEDED, AND NEITHER IS A SECRET PRINTED. Everything goes through Railway's public GraphQL
// (introspected 2026-10-21: serviceInstanceUpdate takes `source {image repo}` and `registryCredentials`, serviceConnect
// takes `{repo branch image}`). The pull credential goes only into the request body and is scrubbed from every message.

import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";
import { GITHUB_OWNER, REPO as OWNED_REPO } from "./required-check-names.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs): `--sha` mistyped as `--shaa`
// would otherwise be read as absent, and a switch to production is the last place for that. Every flag any command takes:
//   --env <production|staging>   --sha <40 hex>   --services <web,worker>   --out <file>   --from-env
// The copy beside the workflow (RUNNER_TEMP) cannot import ./lib, so the workflow copies the helper along with the script.
refuseUnknownFlags({
  name: "fallback-image-deploy",
  entry: import.meta.url,
  known: ["--env", "--sha", "--services", "--out", "--from-env"],
});

// The owner comes from the one place the scripts read it (scripts/required-check-names.mjs); a registry path is lower-case.
export const REPO = OWNED_REPO;
export const IMAGE_REPO = `ghcr.io/${GITHUB_OWNER.toLowerCase()}/phoenix-people-workforce`;
export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
export const PROJECT_ID = "dc218ad3-99b7-4aff-be38-953a57524a71";
export const PRODUCTION_URL = "https://phoenix-hr.satopharma.com";
export const ENVIRONMENTS = Object.freeze({
  production: "cd5600e6-99dd-4b1c-80b2-16af8770abef",
  staging: "c766d42b-9e0b-4027-b00f-b13a1651b214",
});
// Ids AND names: the name is re-read from Railway before anything changes, so a stale id fails loudly.
export const SERVICES = Object.freeze({
  web: { id: "30356676-116b-4886-ac6e-89041d80185e", name: "phoenix-people-workforce" },
  worker: { id: "b955f4dc-a597-4972-953b-410e3c91bc81", name: "phoenix-workforce-worker" },
});
/** Where a service lives when it is healthy: the repository's `main`. `restore` reconnects exactly this. */
export const GIT_SOURCE = Object.freeze({ repo: REPO, branch: "main" });
export const REHEARSAL_PREFIX = "fallback-rehearsal-";
/** Pull + start + the container's own 15-minute readiness window (.railway/railway.ts healthcheckTimeout: 900). */
export const DEPLOY_WAIT_MINUTES = 25;
/** How long to wait for Railway to start a deployment by itself before asking for one. */
export const START_GRACE_SECONDS = 90;

// ── Pure helpers (pinned by tests/fallback-image-deploy.test.ts) ──────────────────────────────────────────────────

export const isFullSha = (value) => /^[0-9a-f]{40}$/.test(String(value ?? ""));

/** The image a commit is published under. Lower-case, as a registry requires. */
export function imageRef(sha) {
  if (!isFullSha(sha)) throw new Error(`Not a full 40-character commit sha: ${sha}`);
  return `${IMAGE_REPO}:${sha}`;
}

/** The two things `serviceInstanceUpdate` changes to move a service onto the image. Nothing else is touched. */
export function switchInput({ sha, username, password }) {
  if (!username || !password) throw new Error("A registry username and password are required — Railway cannot pull a private image without them.");
  return { source: { image: imageRef(sha) }, registryCredentials: { username, password } };
}

/** Roll a deployment's status up to what the waiter does with it. */
export function classifyStatus(status) {
  const s = String(status ?? "").toUpperCase();
  if (s === "SUCCESS") return "live";
  if (["FAILED", "CRASHED", "REMOVED", "REMOVING", "SKIPPED"].includes(s)) return "failed";
  return "pending";
}

/** Scrub every secret value out of a message before it is printed. */
export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret && String(secret).length >= 4) out = out.split(String(secret)).join("***");
  return out;
}

/** `--services web,worker` → ["web","worker"]; unknown names are an error, never ignored. Web always comes first. */
export function parseServices(value) {
  const asked = String(value ?? "web").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = asked.filter((s) => !(s in SERVICES));
  if (unknown.length) throw new Error(`Unknown service(s): ${unknown.join(", ")} (use web and/or worker).`);
  const unique = [...new Set(asked)];
  return ["web", "worker"].filter((s) => unique.includes(s));
}

/** switch / restore change a SERVICE-LEVEL setting, so they may only be asked for production. */
export function assertProductionOnly(env, command) {
  if (env !== "production") {
    throw new Error(
      `${command} refuses --env ${env}: the git/image source is service-level, shared by every environment, so a "${env}" change would change PRODUCTION ` +
        "(the 2026-08-13 and 2026-09-16 repoints). Use `rehearse` to test the image route on a service of its own.",
    );
  }
}

/** Did the live revision reach the wanted commit? Equality for a pinned image; ancestry is the caller's business. */
export const revisionMatches = (live, sha) => Boolean(live) && live === sha;

export function parseArgs(argv) {
  const [command = "read", ...rest] = argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(arg.slice(2), "true");
    else {
      flags.set(arg.slice(2), next);
      i += 1;
    }
  }
  return { command, flags };
}

/**
 * The browser-visible values `next build` inlines into the client bundle. They must arrive as --build-arg (the Dockerfile
 * declares exactly these), and an empty one ships an empty value to every browser with no build error — so a missing
 * one of the first three is a refusal, not a warning.
 */
export const BUILD_VALUE_NAMES = Object.freeze([
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY",
  "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID",
  "NEXT_PUBLIC_SMI_USE_FACT_TABLES",
  "NEXT_PUBLIC_ONESIGNAL_APP_ID",
  "NEXT_PUBLIC_SENTRY_DSN",
]);
export const REQUIRED_BUILD_VALUES = Object.freeze(["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]);

/** POSIX single-quoting, so a DSN or a key with any character survives `. file`. */
export const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

/**
 * `NAME='value'` lines for every build value that is set. Values are TRIMMED — the GitHub copy of NEXT_PUBLIC_APP_URL
 * carried a leading space on 2026-10-21, which read as "different from Railway" until it was looked at.
 */
export function renderBuildValues(source, names = BUILD_VALUE_NAMES) {
  const lines = [];
  const missing = [];
  for (const name of names) {
    const value = String(source[name] ?? "").trim();
    if (value === "") missing.push(name);
    else lines.push(`${name}=${shellQuote(value)}`);
  }
  return { text: lines.length ? lines.join("\n") + "\n" : "", missing, present: lines.length };
}

// ── Railway GraphQL ───────────────────────────────────────────────────────────────────────────────────────────────

const secretsInUse = () => [process.env.RAILWAY_API_TOKEN, process.env.RAILWAY_TOKEN, process.env.REGISTRY_PASSWORD];
let workingHeaders = null;

// The repo's one Railway secret may be an ACCOUNT token (Authorization: Bearer) or a PROJECT token
// (Project-Access-Token) — scripts/sync-railway-production-secrets.mjs explains the failure that reads like expiry.
// Try both in that order and remember the one that works.
function headerSets() {
  const token = process.env.RAILWAY_API_TOKEN?.trim() || process.env.RAILWAY_TOKEN?.trim();
  if (!token) throw new Error("RAILWAY_API_TOKEN or RAILWAY_TOKEN is required.");
  return [
    { "content-type": "application/json", authorization: `Bearer ${token}` },
    { "content-type": "application/json", "project-access-token": token },
  ];
}

async function gql(query, variables) {
  const candidates = workingHeaders ? [workingHeaders] : headerSets();
  let last = null;
  for (const headers of candidates) {
    const response = await fetch(RAILWAY_API, { method: "POST", headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Railway answered HTTP ${response.status} with something that is not JSON: ${redact(text.slice(0, 200), secretsInUse())}`);
    }
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join("; ");
      last = new Error(`Railway refused: ${redact(message, secretsInUse())}`);
      if (/not authorized|unauthorized|invalid.*token/i.test(message)) continue; // try the other header kind
      throw last;
    }
    workingHeaders = headers;
    return body.data;
  }
  if (!last) throw new Error("Railway could not be reached.");
  throw new Error(`${last.message} (${await diagnoseCredential()})`);
}

// Said once when every header kind was refused, so a "Not Authorized" names the credential's kind and reach
// instead of leaving the owner to guess whether it expired, is the wrong kind, or is scoped to another environment.
async function diagnoseCredential() {
  const ask = async (headers, query) => {
    try {
      const response = await fetch(RAILWAY_API, { method: "POST", headers, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000) });
      return await response.json();
    } catch (error) {
      return { errors: [{ message: String(error?.message ?? error) }] };
    }
  };
  const [bearer, project] = headerSets();
  const account = await ask(bearer, "{ me { id } }");
  const scoped = await ask(project, "{ projectToken { projectId environmentId } }");
  const envName = (id) => Object.entries(ENVIRONMENTS).find(([, value]) => value === id)?.[0] ?? "an environment this script does not know";
  const asAccount = account.data?.me?.id ? "accepted as an account token" : `refused as an account token (${account.errors?.[0]?.message ?? "no answer"})`;
  const asProject = scoped.data?.projectToken
    ? `accepted as a project token for ${scoped.data.projectToken.projectId === PROJECT_ID ? "this project" : "another project"}, scoped to ${envName(scoped.data.projectToken.environmentId)}`
    : `refused as a project token (${scoped.errors?.[0]?.message ?? "no answer"})`;
  return redact(`credential check: ${asAccount}; ${asProject}`, secretsInUse());
}

async function readInstance(envId, serviceId) {
  const data = await gql(
    `query($e:String!,$s:String!){service(id:$s){name} serviceInstance(environmentId:$e,serviceId:$s){source{image repo} rootDirectory builder healthcheckPath latestDeployment{id status createdAt meta}}}`,
    { e: envId, s: serviceId },
  );
  return { name: data.service?.name ?? null, ...data.serviceInstance };
}

const describe = (instance) =>
  `source=${JSON.stringify(instance.source)} root=${JSON.stringify(instance.rootDirectory)} latest=${instance.latestDeployment?.status ?? "none"}@${instance.latestDeployment?.id?.slice(0, 8) ?? "-"}`;

async function liveRevision() {
  try {
    const response = await fetch(`${PRODUCTION_URL}/api/healthz`, { signal: AbortSignal.timeout(10_000) });
    return (await response.json())?.revision ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

/**
 * Wait for the deployment a source change caused. Railway usually starts one by itself (the 20 Oct rootDirectory
 * update did); when none appears inside the grace period, ask for one — once.
 */
async function waitForNewDeployment({ envId, serviceId, beforeId, label }) {
  const started = Date.now();
  let asked = false;
  let seenId = null;
  while (Date.now() - started < DEPLOY_WAIT_MINUTES * 60_000) {
    const { latestDeployment: latest } = await readInstance(envId, serviceId);
    if (latest && latest.id !== beforeId) {
      if (seenId !== latest.id) {
        seenId = latest.id;
        note(`- ${label}: deployment ${latest.id.slice(0, 8)} started (${latest.status})`);
      }
      const verdict = classifyStatus(latest.status);
      if (verdict === "live") return latest;
      if (verdict === "failed") throw new Error(`${label}: deployment ${latest.id.slice(0, 8)} ended ${latest.status}. The previous version keeps serving.`);
    } else if (!asked && Date.now() - started > START_GRACE_SECONDS * 1000) {
      asked = true;
      note(`- ${label}: Railway started no deployment by itself in ${START_GRACE_SECONDS}s — asking for one`);
      await gql(`mutation($e:String!,$s:String!){serviceInstanceDeployV2(environmentId:$e,serviceId:$s)}`, { e: envId, s: serviceId });
    }
    await sleep(10_000);
  }
  throw new Error(`${label}: no finished deployment within ${DEPLOY_WAIT_MINUTES} minutes.`);
}

async function waitForRevision(sha, label) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    const live = await liveRevision();
    if (revisionMatches(live, sha)) return Date.now() - started;
    await sleep(10_000);
  }
  throw new Error(`${label}: production did not report ${sha.slice(0, 9)} on /api/healthz within 10 minutes of the deployment finishing.`);
}

async function assertServiceNames(names) {
  for (const key of names) {
    const svc = SERVICES[key];
    const { name } = await readInstance(ENVIRONMENTS.production, svc.id);
    if (name !== svc.name) throw new Error(`Service ${key}: id ${svc.id} answers to "${name}", expected "${svc.name}". Refusing to change anything.`);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function read(flags) {
  const env = flags.get("env") ?? "production";
  if (!(env in ENVIRONMENTS)) throw new Error(`Unknown --env ${env}`);
  for (const [key, svc] of Object.entries(SERVICES)) {
    try {
      note(`- ${env} / ${key} (${svc.name}): ${describe(await readInstance(ENVIRONMENTS[env], svc.id))}`);
    } catch (error) {
      note(`- ${env} / ${key}: unreadable — ${error.message}`);
    }
  }
}

function registryCredentials() {
  const username = process.env.REGISTRY_USERNAME?.trim();
  const password = process.env.REGISTRY_PASSWORD?.trim();
  if (!username || !password) throw new Error("REGISTRY_USERNAME and REGISTRY_PASSWORD are required (the workflow supplies them).");
  return { username, password };
}

async function switchServices(flags) {
  const env = flags.get("env") ?? "production";
  assertProductionOnly(env, "switch");
  const sha = flags.get("sha");
  const services = parseServices(flags.get("services"));
  const image = imageRef(sha);
  const input = switchInput({ sha, ...registryCredentials() });
  await assertServiceNames(services);

  // The snapshot is what `restore` puts back, and the proof of what was changed. Credentials are never in it.
  const snapshot = {};
  for (const key of services) snapshot[key] = await readInstance(ENVIRONMENTS.production, SERVICES[key].id);
  writeFileSync("fallback-snapshot.json", `${JSON.stringify({ takenAt: new Date().toISOString(), image, snapshot }, null, 2)}\n`);
  note(`### Switching ${services.join(" + ")} to ${image}`);
  for (const key of services) note(`- before ${key}: ${describe(snapshot[key])}`);

  for (const key of services) {
    const svc = SERVICES[key];
    const before = snapshot[key].latestDeployment?.id ?? null;
    await gql(`mutation($e:String!,$s:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$e,serviceId:$s,input:$i)}`, {
      e: ENVIRONMENTS.production,
      s: svc.id,
      i: input,
    });
    note(`- ${key}: source switched to the image`);
    await waitForNewDeployment({ envId: ENVIRONMENTS.production, serviceId: svc.id, beforeId: before, label: key });
    if (key === "web") {
      const ms = await waitForRevision(sha, "web");
      note(`- web: production reports ${sha.slice(0, 9)} (${Math.round(ms / 1000)}s after the deployment finished)`);
    }
  }
  note(`**Done.** ${services.join(" + ")} now run ${image}. When Railway builds again, run the workflow with deploy = restore.`);
}

async function mainHead() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const sha = (await response.json())?.sha;
  if (!isFullSha(sha)) throw new Error(`Could not read main's head from GitHub (HTTP ${response.status}).`);
  return sha;
}

async function restore(flags) {
  const env = flags.get("env") ?? "production";
  assertProductionOnly(env, "restore");
  const services = parseServices(flags.get("services") ?? "web,worker");
  await assertServiceNames(services);
  const head = await mainHead();
  note(`### Restoring ${services.join(" + ")} to ${GIT_SOURCE.repo}@${GIT_SOURCE.branch} (main is ${head.slice(0, 9)})`);
  for (const key of services) {
    const svc = SERVICES[key];
    const before = (await readInstance(ENVIRONMENTS.production, svc.id)).latestDeployment?.id ?? null;
    await gql(`mutation($s:String!,$i:ServiceConnectInput!){serviceConnect(id:$s,input:$i)}`, { s: svc.id, i: { repo: GIT_SOURCE.repo, branch: GIT_SOURCE.branch } });
    note(`- ${key}: reconnected to the git source`);
    await waitForNewDeployment({ envId: ENVIRONMENTS.production, serviceId: svc.id, beforeId: before, label: key });
    if (key === "web") {
      const live = await liveRevision();
      note(`- web: production reports ${String(live).slice(0, 9)}`);
    }
  }
  note("**Done.** Back on Railway's own builds. Confirm /api/healthz `revision` is main's head or newer.");
}

async function rehearse(flags) {
  const sha = flags.get("sha");
  const image = imageRef(sha);
  const credentials = registryCredentials();
  const name = `${REHEARSAL_PREFIX}${sha.slice(0, 8)}`;
  note(`### Rehearsal: a throwaway service "${name}" in STAGING pulls ${image} with the same credentials`);
  const created = await gql(
    `mutation($i:ServiceCreateInput!){serviceCreate(input:$i){id name}}`,
    { i: { projectId: PROJECT_ID, environmentId: ENVIRONMENTS.staging, name, source: { image }, registryCredentials: credentials } },
  );
  const id = created.serviceCreate.id;
  let failure = null;
  try {
    // A brand-new service has no earlier deployment, so any deployment it shows is the one being waited for.
    await waitForNewDeployment({ envId: ENVIRONMENTS.staging, serviceId: id, beforeId: null, label: "rehearsal" });
    note("- the rehearsal service pulled the private image and its container started — the credentials and the image route work");
  } catch (error) {
    failure = error;
  } finally {
    // Delete only what this run created, re-checked by name.
    const again = await readInstance(ENVIRONMENTS.staging, id).catch(() => null);
    if (again?.name === name) {
      await gql(`mutation($e:String!,$s:String!){serviceDelete(environmentId:$e,id:$s)}`, { e: ENVIRONMENTS.staging, s: id });
      note(`- rehearsal service "${name}" deleted`);
    } else {
      note(`- NOT deleting service ${id}: it no longer answers to "${name}" — check Railway by hand.`);
    }
  }
  if (failure) throw failure;
}

async function cleanup() {
  const data = await gql(`query($p:String!){project(id:$p){services{edges{node{id name}}}}}`, { p: PROJECT_ID });
  const leftovers = data.project.services.edges.map((e) => e.node).filter((s) => s.name.startsWith(REHEARSAL_PREFIX));
  if (!leftovers.length) return note("- no rehearsal service is left over");
  for (const svc of leftovers) {
    await gql(`mutation($e:String!,$s:String!){serviceDelete(environmentId:$e,id:$s)}`, { e: ENVIRONMENTS.staging, s: svc.id });
    note(`- deleted leftover rehearsal service ${svc.name}`);
  }
}

async function buildValues(flags) {
  const out = flags.get("out") ?? "build-values.env";
  const fromEnv = flags.has("from-env");
  let source = process.env;
  if (!fromEnv) {
    const data = await gql(
      `query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}`,
      { p: PROJECT_ID, e: ENVIRONMENTS.production, s: SERVICES.web.id },
    );
    source = data.variables ?? {};
  }
  const { text, missing, present } = renderBuildValues(source);
  const lacking = REQUIRED_BUILD_VALUES.filter((name) => missing.includes(name));
  if (lacking.length) throw new Error(`Required build value(s) not set in ${fromEnv ? "GitHub" : "Railway"}: ${lacking.join(", ")}. Baking an empty one would ship it empty to every browser.`);
  writeFileSync(out, text);
  note(`- build values from ${fromEnv ? "GitHub" : "Railway"}: ${present} set; not set (feature off): ${missing.join(", ") || "none"}`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const commands = { read, "build-values": buildValues, switch: switchServices, restore, rehearse, cleanup };
  if (!(command in commands)) throw new Error(`Unknown command "${command}". Use read | build-values | switch | restore | rehearse | cleanup.`);
  await commands[command](flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[fallback-image-deploy] ${redact(error.message, secretsInUse())}`);
    process.exit(1);
  });
}
