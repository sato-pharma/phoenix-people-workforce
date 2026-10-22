#!/usr/bin/env node
// Push a live sheet's Apps Script from this repository into Google.
//
// WHY THIS EXISTS. The scripts behind the three live Google Sheets run in Google, not in Phoenix,
// so merging an improvement to `docs/*-live-sheet.gs` changed nothing on the sheet — it only
// changed the review copy. Every fix needed ~2,000 lines pasted into the Apps Script editor by
// hand, which is exactly the manual work the owner does not do. With this in place a sheet fix
// ships like everything else: merge it, and the sheet has it.
//
// The alternative that was considered and REJECTED was a loader stub — a few lines pasted into
// Apps Script once, which downloaded the real script from Phoenix and ran it at refresh time. It
// worked, but it meant the sheet executed code fetched over the network on every run, which hands
// Phoenix the sheet's Google permissions on top of the candidate data it already serves. This
// route writes ordinary code into the project instead: nothing is fetched or evaluated at refresh
// time, the script stays readable in the editor, and the update happens once, in CI, under review.
//
// SAFETY. `projects.updateContent` REPLACES EVERY FILE in the project — there is no per-file
// write. So this reads the project first and sends every existing file back with only the managed
// one swapped. `planAppsScriptUpdate` holds that decision, separately from the network, and
// refuses two ways: an empty file list is never written (it would wipe the project), and the
// managed file must already exist by name (a typo in `remoteFile` would otherwise ADD a second
// file and leave the real one running, silently doing nothing).
//
// HEAD IS NOT WHAT THE WEB APP RUNS. `updateContent` writes the project's HEAD, which is what the
// sheet's own time-driven trigger runs. A web app `/exec` URL runs a saved VERSION instead, and a
// deployment stays on the version it was given until somebody points it at another. Until
// 22 Oct 2026 this script never did, so each sheet's `/exec` stayed on the version it was deployed
// with in August or September: the Direct Orders one answered Phoenix's instant refresh ping with a
// Google error page from version 5 (5 Aug), "You can't merge frozen and non-frozen columns", a
// defect HEAD had long since fixed. So after the content step the push now checks the ONE
// versioned web-app deployment, and when the version it serves differs from HEAD it creates a new
// version and updates THAT deployment to it. The deployment id is kept, so the `/exec` URL Phoenix
// holds never changes, and no deployment is ever created: none to update is a skip, more than one
// is a refusal, because guessing which URL Phoenix calls is how the wrong one moves.
// `planWebAppDeployment` holds that decision, pure, beside `planAppsScriptUpdate`.
//
// Usage:
//   node scripts/push-apps-script.mjs            # push every connected target
//   node scripts/push-apps-script.mjs --check    # report what WOULD change, write nothing
//   node scripts/push-apps-script.mjs --only cv-lifecycle
//
// Credentials come from the environment and are never logged, never passed on a command line, and
// never written to disk.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { APPS_SCRIPT_DEPLOYMENTS_SCOPE, APPS_SCRIPT_TARGETS, OAUTH_ENV } from "./apps-script-manifest.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "push-apps-script",
  entry: import.meta.url,
  known: ["--check", "--only"],
});

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROJECT_URL = (scriptId) => `https://script.googleapis.com/v1/projects/${scriptId}`;
const CONTENT_URL = (scriptId) => `${PROJECT_URL(scriptId)}/content`;

/**
 * One file inside an Apps Script project. Apps Script stores a name and a type rather than a
 * filename, so `Code` + `SERVER_JS` is what the editor shows as `Code.gs`.
 *
 * @typedef {object} AppsScriptFile
 * @property {string} name
 * @property {string} type
 * @property {string} source
 */

/**
 * Decide what to do with one project's files. Pure — no network, no filesystem — so every refusal
 * below is covered by tests/apps-script-push.test.ts rather than discovered against a live sheet.
 *
 * @param {AppsScriptFile[] | null | undefined} files
 * @param {{key: string, remoteFile: string, sheet: string}} target
 * @param {string} localSource
 * @returns {{action: "refuse", reason: string}
 *          |{action: "current", bytes: number}
 *          |{action: "update", files: AppsScriptFile[], from: number, to: number}}
 */
export function planAppsScriptUpdate(files, target, localSource) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      action: "refuse",
      reason:
        `the project read back with no files at all. Refusing to write, because updateContent ` +
        `replaces every file and this would empty ${target.sheet}'s script.`,
    };
  }

  const existing = files.find((file) => file.name === target.remoteFile && file.type === "SERVER_JS");
  if (!existing) {
    const present = files.map((file) => `${file.name} (${file.type})`).join(", ");
    return {
      action: "refuse",
      reason:
        `no SERVER_JS file named "${target.remoteFile}" in ${target.sheet}'s script — it holds: ` +
        `${present}. Writing would ADD a file and leave the real one running, so nothing was ` +
        `changed. Fix \`remoteFile\` for "${target.key}" in scripts/apps-script-manifest.mjs.`,
    };
  }

  if (existing.source === localSource) {
    return { action: "current", bytes: localSource.length };
  }

  return {
    action: "update",
    // Every other file goes back untouched — the manifest file appsscript.json above all, which
    // carries the project's timezone, runtime and OAuth scopes.
    files: files.map((file) => (file === existing ? { ...file, source: localSource } : file)),
    from: existing.source.length,
    to: localSource.length,
  };
}

/**
 * One deployment as `projects.deployments.list` returns it. The HEAD deployment (the editor's
 * `/dev` test URL) carries no `versionNumber`; every real `/exec` deployment carries one.
 *
 * @typedef {object} AppsScriptDeployment
 * @property {string} deploymentId
 * @property {{scriptId?: string, versionNumber?: number, manifestFileName?: string, description?: string}} [deploymentConfig]
 * @property {{entryPointType?: string}[]} [entryPoints]
 */

/** Two file lists hold the same code — order-blind, because the API does not promise an order. */
export function sameAppsScriptFiles(left, right) {
  const key = (files) =>
    JSON.stringify(
      (files ?? [])
        .map((file) => [file.name, file.type, file.source])
        .sort((a, b) => `${a[0]}\u0000${a[1]}`.localeCompare(`${b[0]}\u0000${b[1]}`)),
    );
  return key(left) === key(right);
}

/**
 * Find the ONE web-app deployment whose `/exec` URL Phoenix calls. Pure, like the plan above.
 *
 * None is a skip, never a create: making a deployment mints a NEW `/exec` URL that nothing in
 * Phoenix holds. More than one is a refusal: the API cannot say which URL Railway's
 * `*_SHEET_REFRESH_WEBHOOK_URL` names, and moving the wrong one leaves the real one stale while
 * the run reports success.
 *
 * @param {AppsScriptDeployment[] | null | undefined} deployments
 * @param {{key: string, sheet: string}} target
 * @returns {{action: "none"}
 *          |{action: "refuse", reason: string}
 *          |{action: "use", deployment: AppsScriptDeployment, versionNumber: number}}
 */
export function planWebAppDeployment(deployments, target) {
  const webApps = (deployments ?? []).filter(
    (deployment) =>
      Number.isInteger(deployment?.deploymentConfig?.versionNumber) &&
      (deployment.entryPoints ?? []).some((entry) => entry?.entryPointType === "WEB_APP"),
  );
  if (webApps.length === 0) return { action: "none" };
  if (webApps.length > 1) {
    return {
      action: "refuse",
      reason:
        `${target.sheet}'s script has ${webApps.length} versioned web-app deployments ` +
        `(${webApps.map((d) => `${d.deploymentId} on version ${d.deploymentConfig.versionNumber}`).join("; ")}). ` +
        `Refusing to guess which /exec URL Phoenix calls — compare them with the sheet's ` +
        `*_SHEET_REFRESH_WEBHOOK_URL and archive the one nothing uses.`,
    };
  }
  const [deployment] = webApps;
  return { action: "use", deployment, versionNumber: deployment.deploymentConfig.versionNumber };
}

/**
 * The body of `projects.deployments.update` that moves a deployment to a new version and changes
 * NOTHING else: the same script, manifest and description, and — because the deployment id is the
 * URL path, not a body field — the same `/exec` URL.
 *
 * @param {AppsScriptDeployment} deployment
 * @param {string} scriptId
 * @param {number} versionNumber
 */
export function deploymentUpdateBody(deployment, scriptId, versionNumber) {
  const config = deployment.deploymentConfig ?? {};
  return {
    deploymentConfig: {
      ...config,
      scriptId: config.scriptId ?? scriptId,
      versionNumber,
    },
  };
}

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const onlyIndex = argv.indexOf("--only");
const onlyKey = onlyIndex === -1 ? null : argv[onlyIndex + 1];

function fail(message) {
  console.error(`ERROR  ${message}`);
  process.exitCode = 1;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 *
 * The refresh token is the standing credential; the access token lasts an hour. Neither is
 * printed. On failure Google's own error body is shown because it distinguishes the two cases that
 * matter — a revoked grant (`invalid_grant`) from a wrong client secret (`invalid_client`) — and
 * neither message contains the secret.
 */
async function accessToken() {
  const response = await fetch(TOKEN_URL, {
    body: new URLSearchParams({
      client_id: requiredEnv(OAUTH_ENV.clientId),
      client_secret: requiredEnv(OAUTH_ENV.clientSecret),
      grant_type: "refresh_token",
      refresh_token: requiredEnv(OAUTH_ENV.refreshToken),
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(
      `Google refused the refresh token (HTTP ${response.status}: ${json.error ?? "unknown"}` +
        `${json.error_description ? ` — ${json.error_description}` : ""}). ` +
        `Re-run scripts/apps-script-authorize.mjs to issue a new one.`,
    );
  }
  // Google returns the scopes the grant actually carries. A grant issued before the deployment
  // scope was added (22 Oct 2026) still pushes HEAD, and only the web-app step can tell.
  const scopes = String(json.scope ?? "").split(/\s+/).filter(Boolean);
  return { token: json.access_token, scopes };
}

async function googleJson(token, url, what, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`could not ${what} (${json?.error?.message ?? `HTTP ${response.status}`})`);
  }
  return json;
}

function readProject(token, scriptId) {
  return googleJson(token, CONTENT_URL(scriptId), "read the Apps Script project");
}

function readVersionContent(token, scriptId, versionNumber) {
  return googleJson(
    token,
    `${CONTENT_URL(scriptId)}?versionNumber=${versionNumber}`,
    `read version ${versionNumber} of the Apps Script project`,
  );
}

async function listDeployments(token, scriptId) {
  const all = [];
  let pageToken = "";
  do {
    const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
    const page = await googleJson(token, `${PROJECT_URL(scriptId)}/deployments${query}`, "list the deployments");
    all.push(...(page.deployments ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return all;
}

function createVersion(token, scriptId, description) {
  return googleJson(token, `${PROJECT_URL(scriptId)}/versions`, "create a version", {
    body: JSON.stringify({ description }),
    method: "POST",
  });
}

function updateDeployment(token, scriptId, deploymentId, body) {
  return googleJson(
    token,
    `${PROJECT_URL(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`,
    `update deployment ${deploymentId}`,
    { body: JSON.stringify(body), method: "PUT" },
  );
}

function writeProject(token, scriptId, files) {
  return googleJson(token, CONTENT_URL(scriptId), "write the Apps Script project", {
    body: JSON.stringify({ files }),
    method: "PUT",
  });
}

/**
 * Keep the sheet's web app on the code HEAD now holds. Runs after the content step on EVERY push,
 * including one where the content was already current — that is the case that sat broken: HEAD
 * right, the `/exec` URL eleven weeks behind it.
 */
async function syncWebApp(auth, target, scriptId, headFiles) {
  if (!auth.scopes.includes(APPS_SCRIPT_DEPLOYMENTS_SCOPE)) {
    throw new Error(
      `the Google grant carries no ${APPS_SCRIPT_DEPLOYMENTS_SCOPE}, so ${target.sheet}'s web app ` +
        `could not be moved — its /exec URL still runs whatever version it was last deployed at, ` +
        `not the code just pushed. Re-run scripts/apps-script-authorize.mjs (it now asks for both scopes).`,
    );
  }

  const plan = planWebAppDeployment(await listDeployments(auth.token, scriptId), target);
  if (plan.action === "refuse") throw new Error(plan.reason);
  if (plan.action === "none") {
    console.log(`skip   ${target.key} — ${target.sheet}'s script has no versioned web app to keep current.`);
    return;
  }

  const { deployment, versionNumber } = plan;
  const served = await readVersionContent(auth.token, scriptId, versionNumber);
  if (sameAppsScriptFiles(served.files, headFiles)) {
    console.log(`ok     ${target.key} — ${target.sheet}'s web app already serves this code (version ${versionNumber}).`);
    return;
  }

  if (checkOnly) {
    console.log(`would  ${target.key} — ${target.sheet}'s web app is on version ${versionNumber}, behind HEAD: deploy a new version to it.`);
    return;
  }

  const sha = (process.env.GITHUB_SHA ?? "").slice(0, 9);
  const version = await createVersion(
    auth.token,
    scriptId,
    `Phoenix push${sha ? ` ${sha}` : ""} — ${target.localPath}`,
  );
  if (!Number.isInteger(version.versionNumber)) {
    throw new Error(`Google created a version for ${target.sheet} but returned no version number.`);
  }
  const updated = await updateDeployment(
    auth.token,
    scriptId,
    deployment.deploymentId,
    deploymentUpdateBody(deployment, scriptId, version.versionNumber),
  );
  // Read the answer, never assume it: the point of this step is that a deployment can silently
  // stay where it was.
  const landed = updated?.deploymentConfig?.versionNumber;
  if (landed !== version.versionNumber || updated?.deploymentId !== deployment.deploymentId) {
    throw new Error(
      `${target.sheet}'s deployment answered version ${landed} (id ${updated?.deploymentId}) after ` +
        `being moved to version ${version.versionNumber} — the web app may still serve the old code.`,
    );
  }
  console.log(
    `deploy ${target.key} — ${target.sheet}'s web app moved from version ${versionNumber} to ` +
      `${version.versionNumber}; same deployment, same /exec URL.`,
  );
}

export async function pushTarget(auth, target) {
  const { token } = auth;
  const scriptId = process.env[target.scriptIdEnv];
  if (!scriptId) {
    console.log(`skip   ${target.key} — ${target.scriptIdEnv} is not set, so this sheet is not connected yet.`);
    return;
  }

  const localSource = readFileSync(path.join(process.cwd(), target.localPath), "utf8");
  const project = await readProject(token, scriptId);
  const plan = planAppsScriptUpdate(project.files, target, localSource);

  if (plan.action === "refuse") throw new Error(plan.reason);

  if (plan.action === "current") {
    console.log(`ok     ${target.key} — ${target.sheet}'s script is already current (${plan.bytes} bytes).`);
  } else {
    const delta = plan.to - plan.from;
    const summary =
      `${target.key} — ${target.sheet}: ${plan.from} → ${plan.to} bytes ` +
      `(${delta >= 0 ? "+" : ""}${delta})`;

    if (checkOnly) {
      console.log(`would  ${summary}`);
    } else {
      await writeProject(token, scriptId, plan.files);
      console.log(`push   ${summary}`);
    }
  }

  // HEAD as it now stands (or, under --check, as it would). The web app is compared against this,
  // never against the local file alone, because a version snapshots EVERY file in the project.
  await syncWebApp(auth, target, scriptId, plan.action === "update" ? plan.files : project.files);
}

async function main() {
  const targets = APPS_SCRIPT_TARGETS.filter((target) => !onlyKey || target.key === onlyKey);
  if (onlyKey && targets.length === 0) {
    fail(`--only ${onlyKey} matches no target. Known: ${APPS_SCRIPT_TARGETS.map((t) => t.key).join(", ")}`);
    return;
  }

  if (targets.every((target) => !process.env[target.scriptIdEnv])) {
    console.log("Nothing to do — no sheet has its script id set, so none is connected yet.");
    console.log(`Set one of: ${targets.map((t) => t.scriptIdEnv).join(", ")}`);
    return;
  }

  const auth = await accessToken();
  for (const target of targets) {
    try {
      await pushTarget(auth, target);
    } catch (error) {
      fail(`${target.key} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Only run when invoked directly, so the test can import planAppsScriptUpdate without the script
// trying to reach Google. Compared as file URLs rather than paths: on Windows the two spellings
// differ by a leading slash and a drive-letter case, and a path comparison quietly never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
