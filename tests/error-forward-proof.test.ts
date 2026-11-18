import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SERVER_FORWARD_PROOF_HEADER,
  signServerErrorForward,
  verifyServerErrorForward,
} from "../src/lib/error-monitor/server-forward-proof.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Who may raise the Super Admin's new-error Telegram from /api/errors/client.
 *
 * The route is open to guests, so "signed in" was the wrong test in both directions: an uncaught server error from a
 * cookie-less request (a cron-job.org hit, a webhook, a login page) was written but never alerted, while any employee
 * could still post `source: "server"` and have their own words sent to the Super Admin. instrumentation.ts is this
 * server's own hook, so it signs each forward with an HMAC only this server can make (server-forward-proof.ts), and the
 * route believes a server error only with that proof. A browser crash is still believed from a signed-in reporter.
 */

const SECRET = "test-secret-for-the-error-forward-proof-only";
const NOW = 1_800_000_000;

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

export async function runErrorForwardProofTests() {
  const saved = process.env.PHOENIX_AUTH_SECRET;
  try {
    process.env.PHOENIX_AUTH_SECRET = SECRET;
    const proof = await signServerErrorForward(NOW);
    assert.ok(proof, "a proof is signed when the server has its secret");
    assert.match(proof, /^\d{10}\.[0-9a-f]{64}$/, "an expiry and a SHA-256 HMAC, never the secret");
    assert.ok(!proof.includes(SECRET), "the secret itself never travels");
    assert.equal(await verifyServerErrorForward(proof, NOW), true, "the server's own proof is believed");
    assert.equal(await verifyServerErrorForward(proof, NOW + 59), true, "and for a minute");

    // Everything else is refused.
    assert.equal(await verifyServerErrorForward(proof, NOW + 61), false, "an expired proof is refused");
    assert.equal(await verifyServerErrorForward(null, NOW), false, "no header is no proof");
    assert.equal(await verifyServerErrorForward("", NOW), false);
    assert.equal(await verifyServerErrorForward("not a proof", NOW), false);
    const [expires, signature] = proof.split(".");
    assert.equal(await verifyServerErrorForward(`${Number(expires) + 1}.${signature}`, NOW), false, "a changed expiry breaks the signature");
    const flippedLast = signature.endsWith("0") ? "1" : "0";
    assert.equal(await verifyServerErrorForward(`${expires}.${signature.slice(0, -1)}${flippedLast}`, NOW), false, "a changed signature is refused");
    assert.equal(await verifyServerErrorForward(`${expires}.${signature.slice(0, 10)}`, NOW), false, "a short signature is refused");
    const forever = `${NOW + 10_000_000}`;
    assert.equal(await verifyServerErrorForward(`${forever}.${signature}`, NOW), false, "an expiry further ahead than a fresh proof could be is refused");

    process.env.PHOENIX_AUTH_SECRET = `${SECRET}-rotated`;
    assert.equal(await verifyServerErrorForward(proof, NOW), false, "a proof signed under another secret is refused");
    delete process.env.PHOENIX_AUTH_SECRET;
    assert.equal(await signServerErrorForward(NOW), null, "with no secret nothing signs");
    assert.equal(await verifyServerErrorForward(proof, NOW), false, "and nothing verifies, so the alert simply does not send");
  } finally {
    if (saved === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = saved;
  }

  // The wiring: the hook signs, the route verifies, and the alert flag follows the proof — never "signed in" alone.
  const instrumentation = code("instrumentation.ts");
  assert.ok(instrumentation.includes("const proof = await signServerErrorForward();"), "RED instrumentation.ts signs each forward");
  assert.ok(instrumentation.includes("headers[SERVER_FORWARD_PROOF_HEADER] = proof;"), "and sends the proof as a header");
  assert.doesNotMatch(instrumentation, /PHOENIX_AUTH_SECRET/, "the hook never touches the secret itself; the signing module does");

  const route = code("app/api/errors/client/route.ts");
  assert.ok(
    route.includes("await verifyServerErrorForward(request.headers.get(SERVER_FORWARD_PROOF_HEADER))"),
    "RED the route verifies the proof before it decides to alert",
  );
  assert.ok(
    route.includes('const alert = forwardedByThisServer || (report.source === "client" && Boolean(access.hrId || access.loginId));'),
    "RED a server error is believed only with the proof; a browser crash only from a signed-in reporter",
  );
  assert.ok(!route.includes("alert: Boolean(access.hrId || access.loginId)"), "the signed-in test alone is the defect this replaces");
  assert.ok(route.includes("alert,\n"), "the flag reaches logAppError");
  assert.equal(SERVER_FORWARD_PROOF_HEADER, "x-phoenix-error-forward");

  const proofModule = code("src/lib/error-monitor/server-forward-proof.ts");
  assert.doesNotMatch(proofModule, /node:crypto|^import\s/m, "Web Crypto only: instrumentation.ts is bundled for the Edge runtime too");
}
