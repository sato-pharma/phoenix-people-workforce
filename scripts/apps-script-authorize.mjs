#!/usr/bin/env node
// One-time: get the refresh token that lets CI write the live sheets' Apps Scripts, and store it
// in GitHub Actions secrets without it ever being typed, printed, or written to disk.
//
// Writing into somebody's Google account requires that person's consent — there is no way around
// that and there should not be. This script reduces the owner's part to clicking Approve once.
//
// WHAT IT NEVER DOES. It never prints the refresh token, the access token or the client secret; it
// never writes them to a file; and it never passes them as command-line arguments — a permission
// allow-rule in this project stores the LITERAL command, so a credential in argv ends up saved in
// plaintext in settings.local.json. Everything is piped through stdin instead.
//
// BEFORE RUNNING (the part only the owner can do):
//   1. In Google Cloud Console, on any project, enable the "Apps Script API".
//      (The old phoenix-workforce GCP project is billing-disabled and cannot be used.)
//   2. Create an OAuth client, type "Desktop app".
//   3. Put the two values it gives you in `.env.local` — that file is gitignored:
//        GOOGLE_APPS_SCRIPT_CLIENT_ID=...
//        GOOGLE_APPS_SCRIPT_CLIENT_SECRET=...
//   4. Turn on the Apps Script API for your account, once, at
//      https://script.google.com/home/usersettings
//
// Then:
//   node scripts/apps-script-authorize.mjs
//
// It prints a link, waits for you to approve, and stores the result straight into this
// repository's Actions secrets with `gh`. Nothing is left on this machine.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { APPS_SCRIPT_SCOPE, OAUTH_ENV } from "./apps-script-manifest.mjs";

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

function credential(name, fromFile) {
  const value = process.env[name] || fromFile[name];
  if (!value) {
    console.error(`${name} is not set. Put it in .env.local — see the header of this file.`);
    process.exit(1);
  }
  return value;
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
  const fromFile = envLocal();
  const clientId = credential(OAUTH_ENV.clientId, fromFile);
  const clientSecret = credential(OAUTH_ENV.clientSecret, fromFile);

  const port = 8731;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const consent =
    `${AUTH_URL}?` +
    new URLSearchParams({
      access_type: "offline",
      client_id: clientId,
      // Without this Google returns a refresh token only on the FIRST ever approval, and a second
      // run would succeed while handing back nothing to store — the failure that looks like success.
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: APPS_SCRIPT_SCOPE,
    }).toString();

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

  console.log("\nStored. Remaining step — the script id of each sheet you want connected:");
  console.log("  Sheet → Extensions → Apps Script → Project Settings → Script ID");
  console.log("  Then: gh secret set CV_LIFECYCLE_APPS_SCRIPT_ID   (paste when prompted)");
  console.log("\nA script id is not a secret, but keeping it beside the others keeps it in one place.");
}

main().catch((error) => {
  console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
