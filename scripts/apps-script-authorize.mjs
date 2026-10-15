#!/usr/bin/env node
// One-time: get the refresh token that lets CI write the live sheets' Apps Scripts, and store it
// in GitHub Actions secrets without it ever being typed, printed, or written to disk.
//
// Writing into somebody's Google account requires that person's consent — there is no way around
// that and there should not be. This script reduces the owner's part to clicking Approve once.
//
// WHAT IT NEVER DOES. It never prints the refresh token, the access token or the client secret,
// and it never passes them as command-line arguments — a permission allow-rule in this project
// stores the LITERAL command, so a credential in argv ends up saved in plaintext in
// settings.local.json. Everything is piped through stdin instead.
//
// With `--write-env-local` it additionally writes the three values into `.env.local`, which is
// gitignored and already holds production credentials. That is opt-in for a reason, but it is what
// makes `node scripts/push-apps-script.mjs --check` runnable on this machine: Actions secrets are
// write-only, so without a local copy the setup can be stored but never actually tested.
//
// BEFORE RUNNING (the part only the owner can do):
//   1. In Google Cloud Console, on any project, enable the "Apps Script API".
//      (The old phoenix-workforce GCP project is billing-disabled and cannot be used.)
//   2. Create an OAuth client, type "Desktop app", and DOWNLOAD the JSON it offers. Google shows a
//      client secret exactly once — "viewing and downloading client secrets is no longer
//      available" — so dismissing that dialog means adding a second secret to get another copy.
//   3. Turn on the Apps Script API for your account, once, at
//      https://script.google.com/home/usersettings
//
// Then, pointing at the file from step 2 (preferred — the secret is never retyped):
//   node scripts/apps-script-authorize.mjs --client-file ~/Downloads/client_secret_….json
//
// Or, if the two values are already in `.env.local` (gitignored):
//   GOOGLE_APPS_SCRIPT_CLIENT_ID / GOOGLE_APPS_SCRIPT_CLIENT_SECRET
//   node scripts/apps-script-authorize.mjs
//
// It prints a link, waits for you to approve, and stores the result straight into this
// repository's Actions secrets with `gh`. Nothing is left on this machine.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { APPS_SCRIPT_SCOPE, OAUTH_ENV } from "./apps-script-manifest.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "apps-script-authorize",
  entry: import.meta.url,
  known: ["--client-file", "--reuse-consent", "--write-env-local"],
  hints: [
    "--client-file takes the OAuth client JSON path: --client-file <file>",
  ],
});

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Read `.env.local` without adding a dependency. Values there are never echoed. */
function envLocal() {
  const out = {};
  let raw = "";
  try {
    raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/**
 * Read the `client_secret_*.json` Google hands you when an OAuth client is created.
 *
 * This is the preferred route, and the reason is not convenience. Google shows a client secret
 * exactly once and no longer lets it be viewed or downloaded afterwards, so the alternative is
 * copying it by hand — through a clipboard, a chat window, or a shell command, all of which leave
 * a copy behind. Reading Google's own file means the value goes from disk into one HTTPS request
 * and nowhere else.
 *
 * @param {string} file Path to the downloaded JSON.
 * @returns {{clientId: string, clientSecret: string}}
 */
function readGoogleClientFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not read ${file}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  // Google nests it under "installed" for a Desktop client and "web" for a Web application.
  const block = parsed.installed ?? parsed.web;
  if (!block?.client_id || !block?.client_secret) {
    console.error(
      `${file} does not look like a Google OAuth client file — expected an "installed" or "web" ` +
        `object holding client_id and client_secret.`,
    );
    process.exit(1);
  }
  if (!parsed.installed) {
    console.error(
      `${file} is a WEB client. A loopback redirect needs a client of type "Desktop app"; a web ` +
        `client would refuse the callback this script listens on.`,
    );
    process.exit(1);
  }
  return { clientId: block.client_id, clientSecret: block.client_secret };
}

function credential(name, fromFile) {
  const value = process.env[name] || fromFile[name];
  if (!value) {
    console.error(`${name} is not set. Put it in .env.local, or pass --client-file <path> to the`);
    console.error(`client_secret_*.json Google gave you — see the header of this file.`);
    process.exit(1);
  }
  return value;
}

/**
 * Upsert keys into `.env.local` so the push can be exercised locally with `--check`.
 *
 * GitHub Actions secrets are write-only: once stored, nothing can read them back, so a run that
 * only stores them proves the storing and nothing else. A local copy is what makes the pusher
 * runnable — and therefore verifiable — before it is ever trusted in CI.
 *
 * This file also holds PRODUCTION credentials, so the write is deliberately conservative: every
 * line that is not one of the keys being set is carried through untouched, the result is checked
 * to have lost nothing, and it lands via a temporary file and a rename so an interrupted write
 * cannot leave a half-file behind. Values are never printed.
 */
function writeEnvLocal(values) {
  const file = path.join(process.cwd(), ".env.local");
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const keys = Object.keys(values);
  const kept = original.split(/\r?\n/).filter((line) => {
    const name = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    return !name || !keys.includes(name);
  });

  const removed = original.split(/\r?\n/).length - kept.length;
  if (removed > keys.length) {
    throw new Error(`refusing to write .env.local: it would drop ${removed} lines, expected at most ${keys.length}`);
  }

  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const next = [...kept, ...keys.map((key) => `${key}=${values[key]}`), ""].join("\n");

  const temp = `${file}.writing`;
  writeFileSync(temp, next, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
  console.log(`Wrote ${keys.length} keys into .env.local (${kept.length} existing lines untouched).`);
}

/** Store a value as a GitHub Actions secret, passing it on stdin so it never reaches argv. */
function storeSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["secret", "set", name], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh secret set ${name} exited ${code}`));
    });
    child.stdin.end(value);
  });
}

/** Serve the loopback redirect Google sends the authorization code back to. */
function waitForCode(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not here.");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Phoenix</title>` +
          `<body style="font:16px system-ui;padding:3rem;background:#fff;color:#0F172A">` +
          (code
            ? `<h1>Done.</h1><p>Phoenix can now update your sheet scripts. You can close this tab.</p>`
            : `<h1>Not authorised.</h1><p>Google said: ${error ?? "no code returned"}.</p>`) +
          `</body>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(error ?? "no authorization code was returned"));
    });
    server.listen(port, "127.0.0.1");
    server.on("error", reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf("--client-file");
  const clientFile = fileIndex === -1 ? null : argv[fileIndex + 1];

  let clientId;
  let clientSecret;
  if (clientFile) {
    ({ clientId, clientSecret } = readGoogleClientFile(clientFile));
    console.log(`Using the OAuth client in ${clientFile}`);
    // The id identifies the client and is not a secret; the secret is never printed.
    console.log(`Client: ${clientId}`);
  } else {
    const fromFile = envLocal();
    clientId = credential(OAUTH_ENV.clientId, fromFile);
    clientSecret = credential(OAUTH_ENV.clientSecret, fromFile);
  }

  const port = 8731;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const params = {
    access_type: "offline",
    client_id: clientId,
    // Without this Google returns a refresh token only on the FIRST ever approval, and a second
    // run would succeed while handing back nothing to store — the failure that looks like success.
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: APPS_SCRIPT_SCOPE,
  };
  // `--reuse-consent` drops that, so an account that has already approved is redirected straight
  // back with no screen to click. Installed-app clients still receive a refresh token this way, but
  // that is Google's behaviour rather than a guarantee — so the run still FAILS LOUDLY below if no
  // token comes back, instead of storing nothing and reporting success.
  if (argv.includes("--reuse-consent")) delete params.prompt;
  const consent = `${AUTH_URL}?${new URLSearchParams(params).toString()}`;

  console.log("\nOpen this link, sign in as the sheets' owner, and click Approve:\n");
  console.log(`  ${consent}\n`);
  console.log("Waiting for Google to call back…");

  const code = await waitForCode(port);

  const response = await fetch(TOKEN_URL, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.refresh_token) {
    console.error(
      `Google did not return a refresh token (HTTP ${response.status}: ${json.error ?? "unknown"}).`,
    );
    console.error("Nothing was stored. Re-run this script; the consent screen must be completed.");
    process.exit(1);
  }

  console.log("\nGot it. Storing three secrets in this repository (values are piped, never shown):");
  await storeSecret(OAUTH_ENV.clientId, clientId);
  await storeSecret(OAUTH_ENV.clientSecret, clientSecret);
  await storeSecret(OAUTH_ENV.refreshToken, json.refresh_token);

  if (argv.includes("--write-env-local")) {
    writeEnvLocal({
      [OAUTH_ENV.clientId]: clientId,
      [OAUTH_ENV.clientSecret]: clientSecret,
      [OAUTH_ENV.refreshToken]: json.refresh_token,
    });
  }

  console.log("\nStored. Remaining step — the script id of each sheet you want connected:");
  console.log("  Sheet → Extensions → Apps Script → Project Settings → Script ID");
  console.log("  Then: gh secret set CV_LIFECYCLE_APPS_SCRIPT_ID   (paste when prompted)");
  console.log("\nA script id is not a secret, but keeping it beside the others keeps it in one place.");
}

main().catch((error) => {
  console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
