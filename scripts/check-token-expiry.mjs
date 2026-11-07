#!/usr/bin/env node
// Is any GitHub token this repository depends on dead, or about to expire? Read-only.
//
// 🔴 WHY THIS EXISTS (2026-10-27). Two personal tokens carry production work, and an expired one
// fails silently, far from where it lives:
//   * PHOENIX_ACTIONS_DISPATCH_TOKEN (copied into Railway as GITHUB_ACTIONS_DISPATCH_TOKEN) starts the
//     synthetic journeys every 3 hours and reads branch protection for the drift check. Dead, the
//     journeys simply stop being dispatched and the required-check comparison skips.
//   * GHCR_PULL_TOKEN pulls the private fallback image. Dead, the emergency host cannot start, and
//     nobody finds out until the day it is needed.
// On the account move both had to be minted again by hand, and nothing recorded when they expire.
//
// WHAT IT DOES. For each token passed as TOKEN_<SECRET NAME>, it calls `GET /rate_limit` (free: it
// does not count against the rate limit) and reads GitHub's own `github-authentication-token-expiration`
// header. 401 = DEAD now. No header = the token never expires. It warns `TOKEN_EXPIRY_WARN_DAYS`
// (default 21) days ahead. It prints secret NAMES and dates only, never a value, and never falls back
// to GITHUB_TOKEN: a reading of the wrong token is worse than none.
//
// Exit 0 = every token it could read is live and not expiring soon · 1 = at least one is dead or
// expires inside the warning window · 2 = cannot tell (no token was readable at all). A 2 is never a pass.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The secrets watched, in the order the report lists them. Each arrives as TOKEN_<name>. */
export const WATCHED_TOKENS = ["PHOENIX_ACTIONS_DISPATCH_TOKEN", "GHCR_PULL_TOKEN", "ACTIONS_BILLING_READ_TOKEN"];

const DAY_MS = 86_400_000;

/**
 * GitHub's expiry header as a Date, or null. GitHub writes it as "2026-12-25 10:00:00 UTC", and has
 * also been seen with a numeric offset ("2026-12-25 10:00:00 -0700").
 */
export function parseExpiryHeader(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return null;
  const [, day, time, zone = "UTC"] = match;
  const offset = /^(UTC|Z)$/i.test(zone) ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = Date.parse(`${day}T${time}${offset}`);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * One token's reading as `{ name, state, expires?, daysLeft?, detail? }`. `response` is
 * `{ status, expiration }` from the rate_limit call, or `{ error }` when the call itself failed, or
 * null when the secret is not set here. States: DEAD · EXPIRING · OK · NO_EXPIRY · UNSET · UNKNOWN.
 */
export function classifyToken(name, response, { now = new Date(), warnDays = 21 } = {}) {
  if (!response) return { name, state: "UNSET" };
  if (response.error) return { name, state: "UNKNOWN", detail: response.error };
  if (response.status === 401) return { name, state: "DEAD" };
  if (response.status !== 200) return { name, state: "UNKNOWN", detail: `HTTP ${response.status}` };
  const expires = parseExpiryHeader(response.expiration);
  if (!response.expiration) return { name, state: "NO_EXPIRY" };
  if (!expires) return { name, state: "UNKNOWN", detail: "an expiry header GitHub wrote in a shape this script cannot read" };
  const daysLeft = Math.floor((expires.getTime() - now.getTime()) / DAY_MS);
  if (expires.getTime() <= now.getTime()) return { name, state: "DEAD", expires, daysLeft };
  return { name, state: daysLeft < warnDays ? "EXPIRING" : "OK", expires, daysLeft };
}

function cairoDate(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** The plain-words line for one reading. Names and dates only. */
export function describeToken(reading) {
  switch (reading.state) {
    case "DEAD":
      return `🔴 ${reading.name}: DEAD — GitHub refuses it now${reading.expires ? ` (it expired ${cairoDate(reading.expires)})` : ""}. Mint a new one and store it under the same secret name.`;
    case "EXPIRING":
      return `🔴 ${reading.name}: expires ${cairoDate(reading.expires)} Cairo, in ${reading.daysLeft} day(s). Regenerate it on github.com/settings/personal-access-tokens before then, with the organization as its resource owner, and store it under the same name.`;
    case "OK":
      return `${reading.name}: live, expires ${cairoDate(reading.expires)} (${reading.daysLeft} days).`;
    case "NO_EXPIRY":
      return `${reading.name}: live, no expiry date.`;
    case "UNSET":
      return `${reading.name}: not set as a secret here, so it was not checked.`;
    default:
      return `${reading.name}: could not be read (${reading.detail}).`;
  }
}

/** Exit code for a set of readings: 1 on any dead or expiring token, 2 when nothing was readable. */
export function exitCodeFor(readings) {
  if (readings.some((r) => r.state === "DEAD" || r.state === "EXPIRING")) return 1;
  if (!readings.some((r) => r.state === "OK" || r.state === "NO_EXPIRY")) return 2;
  return 0;
}

async function readRateLimit(token) {
  try {
    const response = await fetch("https://api.github.com/rate_limit", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "phoenix-token-expiry-check",
      },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, expiration: response.headers.get("github-authentication-token-expiration") };
  } catch (error) {
    return { error: String(error?.message || error).split("\n")[0].slice(0, 120) };
  }
}

async function main() {
  const warnDays = Number(process.env.TOKEN_EXPIRY_WARN_DAYS || 21);
  const now = new Date();
  const readings = [];
  for (const name of WATCHED_TOKENS) {
    const token = (process.env[`TOKEN_${name}`] || "").trim();
    readings.push(classifyToken(name, token ? await readRateLimit(token) : null, { now, warnDays }));
  }
  for (const reading of readings) console.log(`  ${describeToken(reading)}`);
  const code = exitCodeFor(readings);
  if (code === 1) console.log(`[token-expiry] ACTION NEEDED — a token is dead or expires within ${warnDays} days. Minting is the owner's.`);
  else if (code === 2) console.log("[token-expiry] CANNOT TELL — no watched token was readable here. This is not a pass.");
  else console.log(`[token-expiry] OK — no watched token expires within ${warnDays} days.`);
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
