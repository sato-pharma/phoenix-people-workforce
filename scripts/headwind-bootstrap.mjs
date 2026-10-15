#!/usr/bin/env node
/**
 * Create Phoenix's own account on the Headwind server and put its credentials into Railway — in one
 * command, with the only secret you type being the Headwind admin password you already have.
 *
 * WHY THIS EXISTS. Setting the bridge up by hand is seven form fields, two Railway variables and a
 * redeploy, and on 2026-09-26 it cost the owner an hour at 05:00: the console's mandatory Role field
 * silently refused a save, so `HEADWIND_MDM_LOGIN=phoenix` pointed at an account that did not exist,
 * and the server answered `errorCode=2` — "user not found" — which reads exactly like a wrong password.
 * Every step below is one the machine can take reliably and a tired person cannot.
 *
 * WHAT IT NEVER DOES. It never prints, logs or stores either password. The admin password is read from
 * a hidden prompt and used once. The new account's password is generated here, written straight into
 * Railway's secret store through the `railway` CLI, and then forgotten — nothing ever holds a copy, so
 * there is nothing to leak in a transcript, a log or a shell history. If you need it later, reveal it
 * in Railway or run this again with --reset.
 *
 *   node scripts/headwind-bootstrap.mjs
 *   node scripts/headwind-bootstrap.mjs --reset          # the account exists: give it a new password
 *   node scripts/headwind-bootstrap.mjs --skip-railway   # create the account only
 *
 * 🔴 THE HASH IS UPPER-CASE MD5, and that is read from the console the live server serves rather than
 * from its documentation: `login.controller.js` sends `md5(password).toUpperCase()` and
 * `users.controller.js` stores a new password the same way. Send lower-case and a correct password is
 * refused as wrong — see `headwindPasswordHash` in src/lib/devices/headwind/auth.ts.
 */

import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "headwind-bootstrap",
  entry: import.meta.url,
  known: ["--base", "--admin-login", "--login", "--name", "--service", "--environment", "--skip-railway", "--reset", "--role"],
});

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.indexOf(`--${name}`);
  if (hit === -1) return fallback;
  const next = args[hit + 1];
  return next && !next.startsWith("--") ? next : true;
};
const has = (name) => args.includes(`--${name}`);

const BASE = String(flag("base", "https://mdm.satopharma.com")).replace(/\/+$/, "");
const ADMIN_LOGIN = String(flag("admin-login", "admin"));
const LOGIN = String(flag("login", "phoenix"));
const NAME = String(flag("name", "Phoenix Workforce"));
const SERVICE = String(flag("service", "phoenix-people-workforce"));
const ENVIRONMENT = String(flag("environment", "production"));

const say = (line) => process.stdout.write(`${line}\n`);
const die = (line) => {
  process.stderr.write(`🔴 ${line}\n`);
  process.exit(1);
};

/** Headwind's wire form: upper-case hex MD5. Never the password itself. */
const wire = (password) => createHash("md5").update(password, "utf8").digest("hex").toUpperCase();

/**
 * Read a secret from the terminal without echoing it.
 *
 * Raw mode is what keeps the password off the screen and out of the scrollback. When stdin is not a
 * TTY (a pipe, CI) there is nothing to hide it with, so this refuses rather than echoing it.
 */
function askHidden(prompt) {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("stdin is not a terminal, so the password cannot be hidden — run this in your own shell"));
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const onData = (chunk) => {
      const char = chunk.toString("utf8");
      if (char === "\r" || char === "\n" || char === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        if (!value) reject(new Error("nothing typed"));
        else resolve(value);
        return;
      }
      if (char === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        reject(new Error("cancelled"));
        return;
      }
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    process.stdin.on("data", onData);
  });
}

/**
 * A password strong enough for any quality rule the console enforces, built from the crypto RNG.
 *
 * The console checks length and "strength" client-side (`passwordService.checkQuality`), so a password
 * that is long and carries every character class passes whatever the server is set to demand — and
 * nobody has to type it, which is the point.
 */
function generatePassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_=+"];
  const all = sets.join("");
  const chars = sets.map((set) => set[randomInt(set.length)]);
  while (chars.length < 24) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Headwind wraps every reply as `{status, message, data}` and answers 200 even when it refuses. */
async function api(path, { method = "GET", body = null, token = null } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    body: body === null ? undefined : JSON.stringify(body),
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { ok: response.ok, payload, status: response.status };
}

async function main() {
  say(`Headwind server : ${BASE}`);
  say(`Account to make : ${LOGIN}  ("${NAME}")`);
  say(`Railway target  : ${SERVICE} / ${ENVIRONMENT}${has("skip-railway") ? "  (skipped)" : ""}`);
  say("");

  const adminPassword = await askHidden(`Headwind password for "${ADMIN_LOGIN}" (not shown, not stored): `);

  // 1 · Sign in as the administrator.
  const signIn = await api("/rest/public/jwt/login", {
    body: { login: ADMIN_LOGIN, password: wire(adminPassword) },
    method: "POST",
  });
  // 🔴 `id_token` FIRST: on this server the JWT comes back at the TOP LEVEL under that name, with no
  //    envelope at all. Reading only the envelope shapes is what made a successful sign-in look like a
  //    refused one for a whole night (see `tokenFromLogin` in src/lib/devices/headwind/auth.ts).
  const token =
    signIn.payload?.id_token ?? signIn.payload?.idToken ??
    signIn.payload?.data?.authToken ?? signIn.payload?.data?.token ?? signIn.payload?.token ??
    (typeof signIn.payload?.data === "string" ? signIn.payload.data : null);
  if (!signIn.ok || !token) {
    die(
      `the server would not sign "${ADMIN_LOGIN}" in (HTTP ${signIn.status}). An HTML reply here is Tomcat ` +
        "refusing the credential, not a broken address. Check the password, and that this login exists.",
    );
  }
  say(`✅ signed in as ${ADMIN_LOGIN}`);

  // 2 · The roles this server actually has. Phoenix needs a role that can read devices,
  //     configurations, applications and files — a restricted one fails later as a 403 that looks
  //     like a bug in Phoenix rather than a choice made here.
  // 🔴 `/rest/private/users/roles`, NOT `/rest/private/roles`. Read from the console's own service
  //    definition (`app/shared/service/user.service.js`, `getUserRoles`) after the first real run died
  //    here on 2026-09-26: the wrong path returns no `data`, and the refusal below stopped the run
  //    BEFORE anything was written — which is the only reason a mistake in the next call cost nothing.
  const roles = await api("/rest/private/users/roles", { token });
  const roleList = Array.isArray(roles.payload?.data) ? roles.payload.data : [];
  if (!roleList.length) die("the server returned no user roles, so there is nothing to give the account");
  const wanted = String(flag("role", "")).toLowerCase();
  const pick =
    (wanted && roleList.find((role) => String(role.name).toLowerCase() === wanted)) ||
    roleList.find((role) => /super|admin/i.test(String(role.name))) ||
    roleList[0];
  say(`   roles offered : ${roleList.map((role) => role.name).join(" · ")}`);
  say(`✅ role chosen   : ${pick.name}${wanted ? "" : "  (pass --role \"<name>\" to choose another)"}`);

  // 3 · Does the account already exist? A create that collides is refused with a message, and the
  //     honest repair is a password reset rather than a second account.
  // 🔴 AND THE LIST IS `/rest/private/users/all` (`getAll`). A plain GET on `/rest/private/users`
  //    is not the list, and `PUT /rest/private/users/current` — one path along — is "change MY OWN
  //    password": aiming the create at it would have re-passworded the administrator running this and
  //    locked him out of his own console. The create below is `PUT /rest/private/users`, which is what
  //    the console itself sends for a new user (`update`, with no id in the payload).
  const users = await api("/rest/private/users/all", { token });
  const existing = (Array.isArray(users.payload?.data) ? users.payload.data : []).find(
    (user) => String(user.login) === LOGIN,
  );
  if (existing && !has("reset")) {
    die(`"${LOGIN}" already exists on this server. Run again with --reset to give it a new password.`);
  }

  // 4 · Create it, or reset it, with a password nobody has to know.
  const password = generatePassword();
  const payload = {
    ...(existing ?? {}),
    allConfigAvailable: true,
    allDevicesAvailable: true,
    configurations: null,
    confirmModal: wire(password),
    groups: null,
    login: LOGIN,
    name: existing?.name ?? NAME,
    newPassword: wire(password),
    userRole: { id: pick.id },
  };
  const saved = await api("/rest/private/users", { body: payload, method: "PUT", token });
  const savedOk = saved.ok && String(saved.payload?.status ?? "").toUpperCase() === "OK";
  if (!savedOk) {
    die(
      `the server refused to ${existing ? "update" : "create"} the account (HTTP ${saved.status}` +
        `${saved.payload?.message ? `, ${saved.payload.message}` : ""}).`,
    );
  }
  say(`✅ ${existing ? "password reset for" : "created"} ${LOGIN}  (${password.length}-character password, generated here and not shown)`);

  // 5 · Prove it signs in. This is the step a person cannot do without re-typing the password, and it
  //     is the one that catches a hash-form mismatch: `errorCode=1` in the server's audit log means the
  //     account was found and the hash did not match, which is a format bug, not a typo.
  const proof = await api("/rest/public/jwt/login", { body: { login: LOGIN, password: wire(password) }, method: "POST" });
  const proofToken =
    proof.payload?.id_token ?? proof.payload?.idToken ??
    proof.payload?.data?.authToken ?? proof.payload?.data?.token ?? proof.payload?.token ??
    (typeof proof.payload?.data === "string" ? proof.payload.data : null);
  const demand = proof.payload?.data && typeof proof.payload.data === "object" ? proof.payload.data : {};
  if (!proofToken && (demand.passwordReset || demand.twoFactor)) {
    die(
      demand.passwordReset
        ? `${LOGIN} exists and the password is right, but the server wants it changed on first sign-in. ` +
            "Nothing was written to Railway. Sign in to the console once as this login, set a new password, " +
            "and run this again with --reset, which sets the password without that flag."
        : `${LOGIN} has two-factor authentication on, which Phoenix cannot complete. Nothing was written.`,
    );
  }
  if (!proof.ok || !proofToken) {
    die(
      `the new account will not sign in (HTTP ${proof.status}). Nothing has been written to Railway. ` +
        "Read the server's audit log: errorCode=2 means the account is not there, errorCode=1 means the " +
        "hash form is wrong — this script and Phoenix both send upper-case MD5.",
    );
  }
  say(`✅ ${LOGIN} signs in and gets a token`);

  if (has("skip-railway")) {
    say("");
    say("Stopped before Railway, as asked. The password was generated and not kept — run with --reset to mint another.");
    return;
  }

  // 6 · Into Railway's secret store, never through a shell. `execFileSync` passes the value as one
  //     argv entry: no shell expansion, no history entry, nothing on screen. --stdin is deliberately
  //     NOT used — it stores a BOM inside the value, and every sign-in then fails against a password
  //     that looks perfectly correct.
  const railway = (...rest) =>
    execFileSync("railway", ["variable", "set", ...rest, "--service", SERVICE, "--environment", ENVIRONMENT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    railway(`HEADWIND_MDM_LOGIN=${LOGIN}`, "--skip-deploys");
    railway(`HEADWIND_MDM_PASSWORD=${password}`);
  } catch (error) {
    die(
      `the account is ready but Railway would not take the variables (${String(error.message).split("\n")[0]}). ` +
        `Set HEADWIND_MDM_LOGIN=${LOGIN} and HEADWIND_MDM_PASSWORD by hand — and because the password was ` +
        "never kept, run this again with --reset to mint one you can paste.",
    );
  }
  say("✅ HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD set on Railway — the second one triggers the redeploy");
  say("");
  say("Both are in the secret store and nowhere else. When the redeploy finishes, /devices/tablets shows the fleet.");
}

main().catch((error) => die(String(error?.message ?? error)));
