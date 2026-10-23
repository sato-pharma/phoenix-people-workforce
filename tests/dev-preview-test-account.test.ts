import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { accessContextFromDevPreviewToken, createDevPreviewSessionToken } from "../src/lib/auth/dev-preview.ts";

/**
 * A test account opened through the dev sign-in is a TEST ACCOUNT (owner, 2026-09-30: "open a rep
 * account … test aya"). Before this, the only way in without its password was a preview under the
 * mirrored person's hr id — which is the REAL person, so her saves would have been real. The dev
 * cookie now carries the same `testPersona` link a real `TEST-…` sign-in carries, and every
 * test-account guard (src/lib/auth/test-persona.ts) reads that one field.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runDevPreviewTestAccountTests(): void {
  const previousSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = previousSecret || "test-session-secret";
  try {
    // ── The token carries the link, and reads back as the person it mirrors ──────────────────────
    const test = accessContextFromDevPreviewToken(
      createDevPreviewSessionToken({ hrId: "B-7", loginId: "TEST-AYA", role: "Medical Rep", testPersona: true }),
    );
    assert.ok(test, "a test-account preview opens");
    assert.equal(test.hrId?.toUpperCase(), "B-7", "it reads as the person it mirrors (hr ids are normalised, as on a real sign-in)");
    assert.equal(test.role, "Medical Rep");
    assert.deepEqual(
      test.testPersona,
      { loginId: "TEST-AYA", mirrorsHrId: "B-7" },
      "and carries the test-account link, so the write guard and Phoenix CRM's test world apply",
    );

    const real = accessContextFromDevPreviewToken(
      createDevPreviewSessionToken({ hrId: "B-7", loginId: "dev.preview", role: "Medical Rep" }),
    );
    assert.ok(real);
    assert.equal(real.testPersona, undefined, "an ordinary preview is never a test account — its shape is unchanged");

    assert.equal(
      accessContextFromDevPreviewToken(
        createDevPreviewSessionToken({ hrId: null, loginId: "TEST-AYA", role: "Medical Rep", testPersona: true }),
      ),
      null,
      "a test-account token that mirrors nobody opens nothing",
    );
  } finally {
    if (previousSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = previousSecret;
  }

  // ── The sign-in opens only a real, active test account, by the real sign-in's own rule ──────────
  const route = source("app/api/dev-auth/route.ts");
  assert.match(route, /if \(!isLocalDevelopmentRequest\(request\)\)/, "still unreachable outside local development");
  assert.match(route, /row\.is_test_persona !== true/, "a login that is not a test account is refused, never opened as a person");
  assert.match(route, /if \(!row\.is_active\)/, "a switched-off test account stays off");
  assert.match(route, /resolveTestPersonaLink\(row, role\)/, "the link comes from the real sign-in's rule — no second copy");
  assert.match(
    route,
    /createDevPreviewSessionToken\(\{ hrId: link\.link\.mirrorsHrId, loginId: link\.link\.loginId, role, testPersona: true \}\)/,
    "and the cookie is minted from that link",
  );
  assert.match(source("src/lib/auth/server.ts"), /export function resolveTestPersonaLink\(/);

  // ── A refresh keeps it a test account ──────────────────────────────────────────────────────────
  assert.match(
    source("src/lib/auth/session-heartbeat.ts"),
    /testPersona: Boolean\(devPreview\.testPersona\)/,
    "the heartbeat re-issues the cookie WITH the marker — without it the session turns into the real person minutes in",
  );

  console.log("dev preview test account: OK");
}
