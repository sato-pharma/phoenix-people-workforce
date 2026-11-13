import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  LEAKED_PASSWORD_MESSAGE,
  LEAKED_PASSWORD_RANGE_URL,
  checkLeakedPassword,
  leakedPasswordAuditValue,
  leakedPasswordFingerprint,
  timesSeenInRange,
} from "../src/lib/auth/leaked-password.ts";
import { clientSafeErrorMessage } from "../src/lib/http/api-errors.ts";
import { INTEGRATIONS } from "../src/lib/integrations/registry.ts";

/**
 * A PASSWORD THAT HAS ALREADY LEAKED IS REFUSED WHEN IT IS CHOSEN (integration audit INT-006; owner,
 * 13 Nov 2026: "Refuse it when chosen").
 *
 * What is pinned:
 *   1. Only the first five characters of the password's fingerprint leave. Never the password, never
 *      the rest of the fingerprint, and no header that says who is asking.
 *   2. A padded answer's made-up lines (count 0) are not leaks.
 *   3. A service that cannot be asked is "unknown": the password is accepted on the other rules and the
 *      audit row says the check was skipped. It is never read as "not leaked" and never as a refusal.
 *   4. Both places a person chooses a password ask, BEFORE anything is written, and the set-password
 *      link is not spent on a refused password.
 *
 * No request leaves this test: every call is handed its own fetch.
 */

// SHA-1 of the text "password", the fingerprint every description of the range service uses.
const PASSWORD_SHA1 = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8"; // gitleaks:allow — the published fingerprint of the word "password", not a credential
const PREFIX = PASSWORD_SHA1.slice(0, 5);
const SUFFIX = PASSWORD_SHA1.slice(5);
const OTHER = "0018A45C4D1DEF81644B54AB7F969B88D65";
const PADDING = "00D4F6E8FA6EECAD2A3AA415EEC418D38EC";

type Call = { headers: Record<string, string>; url: string };

function fetchAnswering(answer: { body?: string; ok?: boolean; status?: number } | Error) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ headers: init.headers, url });
    assert.ok(init.signal instanceof AbortSignal, "every call carries a deadline");
    if (answer instanceof Error) throw answer;
    return { ok: answer.ok ?? true, status: answer.status ?? 200, text: async () => answer.body ?? "" };
  };
  return { calls, fetchImpl };
}

export async function runLeakedPasswordTests() {
  // ── 1. What leaves ─────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(leakedPasswordFingerprint("password"), { prefix: PREFIX, suffix: SUFFIX });
  assert.equal(PREFIX.length, 5);
  assert.equal(SUFFIX.length, 35);

  const leakedAnswer = fetchAnswering({ body: `${OTHER}:3\r\n${SUFFIX}:9545824\r\n${PADDING}:0\r\n` });
  assert.deepEqual(await checkLeakedPassword("password", { fetchImpl: leakedAnswer.fetchImpl }), { leaked: true, timesSeen: 9545824 });
  assert.equal(leakedAnswer.calls.length, 1, "one question per password");
  const [call] = leakedAnswer.calls;
  assert.equal(call.url, `${LEAKED_PASSWORD_RANGE_URL}${PREFIX}`, "🔴 the address carries the first five characters and nothing else");
  assert.equal(LEAKED_PASSWORD_RANGE_URL, "https://api.pwnedpasswords.com/range/");
  const asked = call.url.slice(LEAKED_PASSWORD_RANGE_URL.length);
  assert.equal(asked, PREFIX);
  assert.ok(!call.url.includes(SUFFIX) && !asked.includes("password"), "never the password, never the rest of its fingerprint");
  assert.deepEqual(call.headers, { "Add-Padding": "true" }, "🔴 one header, asking for a padded answer: nothing names Phoenix or the person");

  // ── 2. Reading the answer ──────────────────────────────────────────────────────────────────────
  assert.equal(timesSeenInRange(`${OTHER}:3\n${SUFFIX}:12\n`, SUFFIX), 12);
  assert.equal(timesSeenInRange(`${OTHER}:3\n${SUFFIX.toLowerCase()}:12\n`, SUFFIX), 12, "letter case does not hide a match");
  assert.equal(timesSeenInRange(`${OTHER}:3\r\n  ${SUFFIX}:7  \r\n`, SUFFIX), 7);
  assert.equal(timesSeenInRange(`${OTHER}:3\n${PADDING}:0\n`, SUFFIX), 0, "not in the answer is not leaked");
  assert.equal(timesSeenInRange(`${SUFFIX}:0\n`, SUFFIX), 0, "🔴 a padded answer's made-up line (count 0) is not a leak");
  assert.equal(timesSeenInRange(`${SUFFIX}:lots\n`, SUFFIX), 0);
  assert.equal(timesSeenInRange("", SUFFIX), 0);

  const clean = fetchAnswering({ body: `${OTHER}:3\n${PADDING}:0\n` });
  assert.deepEqual(await checkLeakedPassword("password", { fetchImpl: clean.fetchImpl }), { leaked: false });
  const paddedOnly = fetchAnswering({ body: `${OTHER}:3\n${SUFFIX}:0\n` });
  assert.deepEqual(await checkLeakedPassword("password", { fetchImpl: paddedOnly.fetchImpl }), { leaked: false });

  // ── 3. A service that cannot be asked is "unknown", never a pass and never a refusal ───────────
  const refused = await checkLeakedPassword("password", { fetchImpl: fetchAnswering({ ok: false, status: 503 }).fetchImpl });
  assert.deepEqual(refused, { leaked: "unknown", reason: "the range service answered 503" });
  const empty = await checkLeakedPassword("password", { fetchImpl: fetchAnswering({ body: "" }).fetchImpl });
  assert.equal(empty.leaked, "unknown", "🔴 an empty answer is a broken answer: it is never read as \"never leaked\"");
  const page = await checkLeakedPassword("password", { fetchImpl: fetchAnswering({ body: "<html>Service unavailable</html>" }).fetchImpl });
  assert.equal(page.leaked, "unknown", "an error page with a 200 is not an answer either");
  const down = await checkLeakedPassword("password", { fetchImpl: fetchAnswering(new Error("getaddrinfo ENOTFOUND")).fetchImpl });
  assert.deepEqual(down, { leaked: "unknown", reason: "the range service could not be reached" });
  const slow = await checkLeakedPassword("password", {
    fetchImpl: fetchAnswering(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })).fetchImpl,
  });
  assert.deepEqual(slow, { leaked: "unknown", reason: "the range service did not answer in time" });
  assert.ok(!JSON.stringify([refused, empty, page, down, slow]).includes("password"), "a reason never repeats the password");

  // A real deadline, not only a named error: a service that never answers is given up on.
  const startedAt = Date.now();
  // AbortSignal.timeout's own timer does not hold the process open (a real request's socket does), so
  // this one does for the length of the wait.
  const holdOpen = setTimeout(() => undefined, 5000);
  const hung = await checkLeakedPassword("password", {
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    timeoutMs: 50,
  }).finally(() => clearTimeout(holdOpen));
  assert.deepEqual(hung, { leaked: "unknown", reason: "the range service did not answer in time" });
  assert.ok(Date.now() - startedAt < 2000, "the deadline is the call's own");

  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...parts: unknown[]) => void warned.push(parts.join(" "));
  try {
    assert.equal(leakedPasswordAuditValue({ leaked: false }), "not_leaked");
    assert.equal(warned.length, 0);
    assert.equal(leakedPasswordAuditValue({ leaked: "unknown", reason: "the range service answered 503" }), "not_checked");
    assert.equal(warned.length, 1, "a skipped check is said out loud in the server log");
  } finally {
    console.warn = warn;
  }

  // The refusal reaches the person as written, on both screens.
  assert.equal(clientSafeErrorMessage(new Error(LEAKED_PASSWORD_MESSAGE), "Password setup failed.", { report: false }), LEAKED_PASSWORD_MESSAGE);
  assert.ok(/data leak/.test(LEAKED_PASSWORD_MESSAGE) && /different/.test(LEAKED_PASSWORD_MESSAGE), "it says why and what to do");

  // ── 4. Both places a password is chosen ask, before anything is written ────────────────────────
  const change = stripComments(readFileSync("src/lib/auth/change-password.ts", "utf8"));
  const changeAsk = change.indexOf("await checkLeakedPassword(input.newPassword)");
  assert.notEqual(changeAsk, -1, "changing a password asks");
  assert.ok(change.indexOf("passwordWeakness(input.newPassword") < changeAsk, "after the rules that need no network");
  assert.ok(changeAsk < change.indexOf("bcrypt.hash(input.newPassword"), "and before the new password is hashed or written");
  assert.ok(changeAsk < change.indexOf('.from("app_auth_users")\n    .update('), "before the account is touched");
  assert.ok(change.includes("if (leakVerdict.leaked === true) throw new WeakPasswordError(LEAKED_PASSWORD_MESSAGE);"), "only a certain leak refuses: unknown does not");
  assert.ok(/leakedPasswordCheck,/.test(change.slice(change.indexOf("writeRequiredAuditLog("))), "the audit row says whether the check ran");

  const setup = stripComments(readFileSync("src/lib/auth/password-setup.ts", "utf8"));
  const complete = setup.slice(setup.indexOf("export async function completePasswordSetup"));
  const setupAsk = complete.indexOf("await checkLeakedPassword(password)");
  assert.notEqual(setupAsk, -1, "setting a password from a link or a temporary password asks");
  assert.ok(complete.indexOf("passwordWeakness(password") < setupAsk);
  const claim = complete.indexOf(".update({ updated_at: now, used_at: now })");
  assert.ok(claim !== -1 && setupAsk < claim, "🔴 BEFORE the link is spent, so a refused password leaves the link usable");
  assert.ok(complete.includes("if (leakVerdict.leaked === true) throw new Error(LEAKED_PASSWORD_MESSAGE);"));
  assert.ok(/leakedPasswordCheck,/.test(complete.slice(claim)), "the audit row says whether the check ran");

  // Nothing checks at sign-in: passwords already in use are not touched (his choice).
  const login = stripComments(readFileSync("app/api/auth/login/route.ts", "utf8"));
  assert.ok(!login.includes("leaked-password"), "sign-in never asks: a password already in use is left alone");

  // It is on the Integrations page, as every outside service is.
  const entry = INTEGRATIONS.find((integration) => integration.id === "leaked-passwords");
  assert.ok(entry, "the leaked-password check is in the integrations registry");
  assert.equal(entry?.credential.kind, "none");
  const source = stripComments(readFileSync("src/lib/auth/leaked-password.ts", "utf8"));
  assert.ok(source.includes("AbortSignal.timeout("), "the call has a deadline");
  assert.equal(source.split("fetchImpl(").length - 1, 1, "one outbound call, to the range address");
}
