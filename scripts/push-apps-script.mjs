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

import { APPS_SCRIPT_TARGETS, OAUTH_ENV } from "./apps-script-manifest.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "push-apps-script",
  entry: import.meta.url,
  known: ["--check", "--only"],
});

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CONTENT_URL = (scriptId) => `https://script.googleapis.com/v1/projects/${scriptId}/content`;

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
  return json.access_token;
}

async function readProject(token, scriptId) {
  const response = await fetch(CONTENT_URL(scriptId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `could not read the Apps Script project (${json?.error?.message ?? `HTTP ${response.status}`})`,
    );
  }
  return json;
}

async function writeProject(token, scriptId, files) {
  const response = await fetch(CONTENT_URL(scriptId), {
    body: JSON.stringify({ files }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "PUT",
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `could not write the Apps Script project (${json?.error?.message ?? `HTTP ${response.status}`})`,
    );
  }
  return json;
}

async function pushTarget(token, target) {
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
    return;
  }

  const delta = plan.to - plan.from;
  const summary =
    `${target.key} — ${target.sheet}: ${plan.from} → ${plan.to} bytes ` +
    `(${delta >= 0 ? "+" : ""}${delta})`;

  if (checkOnly) {
    console.log(`would  ${summary}`);
    return;
  }

  await writeProject(token, scriptId, plan.files);
  console.log(`push   ${summary}`);
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

  const token = await accessToken();
  for (const target of targets) {
    try {
      await pushTarget(token, target);
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
