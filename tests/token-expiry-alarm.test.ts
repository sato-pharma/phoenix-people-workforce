// The token-expiry alarm must name a dead or expiring GitHub token before the work it carries stops
// (2026-10-27).
//
// WHY IT NEEDS A TEST. PHOENIX_ACTIONS_DISPATCH_TOKEN starts the synthetic journeys and reads branch
// protection; GHCR_PULL_TOKEN pulls the private fallback image. Both are personal tokens, both were
// minted again by hand on the account move, and an expired one fails far from where it lives: the
// journeys just stop being dispatched, and the emergency host cannot start on the day it is needed.
// scripts/check-token-expiry.mjs reads GitHub's own expiry header; these clauses pin how it reads it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  WATCHED_TOKENS,
  classifyToken,
  describeToken,
  exitCodeFor,
  parseExpiryHeader,
} from "../scripts/check-token-expiry.mjs";

const DAY = 86_400_000;

export function runTokenExpiryAlarmTests() {
  // 1. GitHub's header, in both shapes it has been seen in.
  assert.equal(parseExpiryHeader("2026-12-25 10:00:00 UTC")?.toISOString(), "2026-12-25T10:00:00.000Z");
  assert.equal(parseExpiryHeader("2026-12-25 10:00:00 -0700")?.toISOString(), "2026-12-25T17:00:00.000Z", "🔴 a numeric offset was read as UTC");
  assert.equal(parseExpiryHeader(""), null);
  assert.equal(parseExpiryHeader("next Tuesday"), null);

  const now = new Date("2026-11-01T09:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

  // 2. Every state, from the call's own answer.
  assert.equal(classifyToken("A", null, { now }).state, "UNSET", "a secret that is not set here is not checked, and not a pass");
  assert.equal(classifyToken("A", { status: 401, expiration: null }, { now }).state, "DEAD", "🔴 a 401 is a dead token now");
  assert.equal(classifyToken("A", { status: 200, expiration: null }, { now }).state, "NO_EXPIRY");
  const ok = classifyToken("A", { status: 200, expiration: at(30) }, { now });
  assert.equal(ok.state, "OK");
  assert.equal(ok.daysLeft, 30);
  const soon = classifyToken("A", { status: 200, expiration: at(10) }, { now });
  assert.equal(soon.state, "EXPIRING", "🔴 a token ten days from expiry must warn, 21 days ahead by default");
  assert.equal(classifyToken("A", { status: 200, expiration: at(10) }, { now, warnDays: 7 }).state, "OK", "the warning window is the variable's");
  assert.equal(classifyToken("A", { status: 200, expiration: at(-1) }, { now }).state, "DEAD", "an expiry in the past is dead even before GitHub answers 401");
  assert.equal(classifyToken("A", { status: 500, expiration: null }, { now }).state, "UNKNOWN");
  assert.equal(classifyToken("A", { error: "fetch failed" }, { now }).state, "UNKNOWN");
  assert.equal(classifyToken("A", { status: 200, expiration: "soon" }, { now }).state, "UNKNOWN", "🔴 an unreadable header was read as never expiring");

  // 3. The exit code: 1 on any dead or expiring token, 2 when nothing could be read, never a pass by default.
  const unset = { name: "A", state: "UNSET" };
  assert.equal(exitCodeFor([unset, unset, unset]), 2, "🔴 no token read at all must be CANNOT TELL, not OK");
  assert.equal(exitCodeFor([{ name: "A", state: "UNKNOWN" }]), 2);
  assert.equal(exitCodeFor([ok, unset]), 0);
  assert.equal(exitCodeFor([{ name: "A", state: "NO_EXPIRY" }]), 0);
  assert.equal(exitCodeFor([ok, soon]), 1);
  assert.equal(exitCodeFor([ok, { name: "B", state: "DEAD" }]), 1);

  // 4. The lines name the secret and a Cairo date, never a value. 23:30 UTC on the 24th is the 25th in Cairo.
  const late = classifyToken("GHCR_PULL_TOKEN", { status: 200, expiration: "2026-12-24 23:30:00 UTC" }, { now: new Date("2026-12-10T09:00:00Z") });
  assert.equal(late.state, "EXPIRING");
  assert.match(describeToken(late), /^🔴 GHCR_PULL_TOKEN: expires 25 Dec 2026 Cairo, in 14 day\(s\)/, "🔴 the expiry day was printed in UTC, a day early");
  assert.match(describeToken({ name: "X", state: "DEAD" }), /DEAD/);
  assert.match(describeToken(unset), /not set as a secret here/);

  // 5. The script never reads a fallback token: a reading of the wrong token is worse than none.
  const script = readFileSync(resolve("scripts/check-token-expiry.mjs"), "utf8");
  assert.doesNotMatch(script, /process\.env\.(GITHUB_TOKEN|GH_TOKEN)\b/, "🔴 the expiry check fell back to GITHUB_TOKEN, which reports the workflow's token, not the one that expires");
  assert.ok(WATCHED_TOKENS.includes("PHOENIX_ACTIONS_DISPATCH_TOKEN") && WATCHED_TOKENS.includes("GHCR_PULL_TOKEN"));

  // 6. The scheduled drift check hands it every watched secret under its own name.
  const source = readFileSync(resolve(".github/workflows/secret-drift-check.yml"), "utf8");
  const start = source.indexOf("        id: token_expiry");
  assert.notEqual(start, -1, "🔴 secret-drift-check.yml no longer has the token_expiry step, so nothing watches the tokens");
  const stepText = source.slice(source.lastIndexOf("      - name: ", start), source.indexOf("\n      - name: ", start));
  assert.match(stepText, /node scripts\/check-token-expiry\.mjs/);
  assert.match(stepText, /continue-on-error:\s*true/);
  assert.match(stepText, /timeout-minutes:\s*\d+/);
  for (const name of WATCHED_TOKENS) {
    assert.match(
      stepText,
      new RegExp(`TOKEN_${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`),
      `🔴 the token_expiry step no longer passes ${name}, so its expiry goes unwatched`,
    );
  }
  assert.match(stepText, /set \+e/);
  assert.match(stepText, /"\$rc" -eq 2/);
}
