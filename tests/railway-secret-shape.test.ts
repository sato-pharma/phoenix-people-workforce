import assert from "node:assert/strict";

import { checkSecretShape } from "../scripts/secret-shape-rules.mjs";

// Regression guard for the 2026-09-02 production incident. OPENAI_API_KEY sat in Railway
// production holding a MASKED paste — "sk-..." glued onto the front of the real key and "..."
// onto the end. It was present, non-empty and comfortably long, so every check that
// validate-railway-production-secrets.mjs already had passed it, while OpenAI answered 401 and
// every AI feature in the app degraded in silence.
//
// The bar here is the one secret-pins-check's test sets: not "the function runs", but that fed
// the exact SHAPE that actually shipped, it reports what a human had to work out by hand.
//
// Every fixture is SYNTHETIC. The shapes are real; the secrets are not. A live credential must
// never appear in a test file — which is also why the last assertion in the first block checks
// that a failure message never quotes the value back.

// 164 characters, the length of a real project key, assembled at runtime from a short
// low-entropy alphabet. Deliberately NOT a realistic-looking key literal: gitleaks is a required
// check on this repo, and it flagged the first draft of this file. A convincing fake in the tree
// costs every future reader the same investigation it cost this one, so the fixture is built to
// have a real key's SHAPE and nothing of its texture.
const FIXTURE_ALPHABET = "abcdefghijklmnop";
const FIXTURE_BODY = FIXTURE_ALPHABET.repeat(10).slice(0, 156);
const GOOD_OPENAI_KEY = `sk-proj-${FIXTURE_BODY}`;

export function runRailwaySecretShapeTests() {
  assert.equal(GOOD_OPENAI_KEY.length, 164, "the synthetic fixture must match a real key's length");

  // --- the exact corruption that shipped to production -----------------------------------
  // 173 chars: "sk-..." (6) + the real key (164) + "..." (3).
  const masked = `sk-...${GOOD_OPENAI_KEY}...`;
  assert.equal(masked.length, 173, "the fixture must reproduce the 173-char value measured in production");

  const maskedFailures = checkSecretShape("OPENAI_API_KEY", masked);
  assert.ok(
    maskedFailures.some((failure) => failure.includes("not shaped like a real key")),
    "a mask-wrapped OpenAI key must fail the shape rule — this is the value that 401'd every AI feature",
  );
  assert.ok(
    maskedFailures.some((failure) => failure.includes("redaction marker")),
    "the same value must also trip the redaction-marker rule, which catches this class for every variable",
  );
  assert.ok(
    maskedFailures.every((failure) => !failure.includes(FIXTURE_BODY)),
    "a failure message must never quote the value back — these are printed into CI logs",
  );

  // --- the healthy value must stay silent -------------------------------------------------
  assert.deepEqual(
    checkSecretShape("OPENAI_API_KEY", GOOD_OPENAI_KEY),
    [],
    "a well-formed key must produce no failures at all",
  );

  // The accepted charset, spelled out: "_" and "-" are both legal inside a vendor key, and the
  // fixture above happens to contain neither.
  assert.deepEqual(
    checkSecretShape("OPENAI_API_KEY", "sk-proj-abc_def-ghi_jkl-mno_pqr"),
    [],
    'a key containing "_" and "-" must be accepted — both are legal in the vendor charset',
  );

  // --- whitespace, newline and BOM corruption ---------------------------------------------
  // `railway variable set --stdin` is documented to store a BOM inside the value; the charset
  // rule is what catches it, which is why the validator feeds the RAW value and not a trimmed
  // copy. Each of these passed the old presence check.
  for (const [label, corrupted] of [
    ["a leading BOM", `﻿${GOOD_OPENAI_KEY}`],
    ["a trailing newline", `${GOOD_OPENAI_KEY}\n`],
    ["surrounding spaces", ` ${GOOD_OPENAI_KEY} `],
    ["an embedded space", `${GOOD_OPENAI_KEY.slice(0, 80)} ${GOOD_OPENAI_KEY.slice(80)}`],
  ] as const) {
    assert.ok(
      checkSecretShape("OPENAI_API_KEY", corrupted).some((failure) => failure.includes("not shaped like a real key")),
      `${label} must fail the shape rule — trimming first would hide it`,
    );
  }

  // --- the redaction rule applies to every variable, not just the named keys ---------------
  // The point of this one is that it needs no per-vendor knowledge: it catches the same paste
  // mistake on a secret nobody has written a shape rule for.
  for (const marker of ["...", "…", "***", "•••"]) {
    const pasted = `abc${marker}def`;
    assert.ok(
      checkSecretShape("CRON_SECRET", pasted).some((failure) => failure.includes("redaction marker")),
      `a value carrying "${marker}" must be reported even with no shape rule for that variable`,
    );
  }

  // --- healthy values of every other kind must stay silent --------------------------------
  // Guards against the rules being noisy enough that a real sync starts failing on good data.
  const healthy: [string, string][] = [
    ["APP_URL", "https://phoenix-hr.satopharma.com"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://ozucdzovmcqvepbozvqf.supabase.co"],
    ["SUPABASE_PROJECT_REF", "ozucdzovmcqvepbozvqf"],
    ["EMAIL_NOTIFICATIONS_ENABLED", "true"],
    ["NOTIFICATION_EMAIL_FROM", "Phoenix HR <no-reply@satopharma.com>"],
    ["MARKETING_SHEET_REFRESH_WEBHOOK_URL", "https://script.google.com/macros/s/example-deployment/exec"],
    // A JWT legitimately contains dots — two of them, never three in a row — so the anon key
    // must not be caught by the redaction rule. Spelled out in words rather than as a realistic
    // base64 JWT for the same reason as the key fixture above: gitleaks flagged the first draft.
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "header.payload.signature"],
  ];
  for (const [name, value] of healthy) {
    assert.deepEqual(checkSecretShape(name, value), [], `${name} holds a healthy value and must not be flagged`);
  }

  // --- absent values are the presence check's job, not this one's -------------------------
  assert.deepEqual(checkSecretShape("OPENAI_API_KEY", undefined), [], "an absent value is reported by the presence check");
  assert.deepEqual(checkSecretShape("OPENAI_API_KEY", null), [], "a null value is reported by the presence check");
}
