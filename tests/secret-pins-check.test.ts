import assert from "node:assert/strict";

import { findPinnedSecrets, remediationCommand } from "../scripts/check-secret-pins.ts";

// Regression guard for the pinned-secret monitor added after the 2026-07-31 cron outage.
//
// The bar for this test is the same one check-schema-shape's test sets: not "the function
// runs", but that fed the versions ACTUALLY observed on each service, it reports what a
// human had to work out by hand. Every fixture below is measured, not invented.

export function runSecretPinsCheckTests() {
  // --- production, measured on revision phoenix-hr-00271-dg4 (before the fix) -----------
  // Four pins, each created by a rotation that wired the new version in by number. Two
  // leading blanks stand for plain-valued env vars, which is how gcloud actually returns
  // them and the reason the three columns must never be pre-filtered.
  const prodEnv = [
    "APP_ENV",
    "COMMIT_SHA",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PHOENIX_AUTH_SECRET",
    "BREVO_WEBHOOK_SECRET",
    "NOTIFICATION_WEBHOOK_SECRET",
    "CRON_SECRET",
    "OPENAI_API_KEY",
    "ATTENDANCE_AGENT_TOKEN",
  ];
  const prodSecret = [
    "",
    "",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PHOENIX_AUTH_SECRET",
    "BREVO_WEBHOOK_SECRET",
    "NOTIFICATION_WEBHOOK_SECRET",
    "CRON_SECRET",
    "OPENAI_API_KEY",
    "ATTENDANCE_AGENT_TOKEN",
  ];
  const prodBefore = ["", "", "latest", "2", "3", "3", "latest", "2", "latest"];
  const pinnedBefore = findPinnedSecrets(prodEnv, prodSecret, prodBefore);
  assert.deepEqual(
    pinnedBefore.map((p) => `${p.env}:${p.key}`),
    ["PHOENIX_AUTH_SECRET:2", "BREVO_WEBHOOK_SECRET:3", "NOTIFICATION_WEBHOOK_SECRET:3", "OPENAI_API_KEY:2"],
    "the four pins that existed before revision 00274 must all be reported",
  );

  // CRON_SECRET reads latest here: it was the one already repaired during the outage, and
  // a check that re-flagged it would be crying wolf on the one thing that was fixed.
  assert.equal(pinnedBefore.some((p) => p.env === "CRON_SECRET"), false, "an already-repaired secret must not be reported");

  // A plain-valued env var is not a pin, however empty its columns look.
  assert.equal(pinnedBefore.some((p) => p.env === "APP_ENV"), false, "a literal env var is never reported");

  // --- production after the 00274 fix: one pin remained, introduced at 21:37 -------------
  assert.deepEqual(
    findPinnedSecrets(prodEnv, prodSecret, ["", "", "latest", "latest", "latest", "latest", "latest", "latest", "2"]).map(
      (p) => p.env,
    ),
    ["ATTENDANCE_AGENT_TOKEN"],
    "the pin added after the earlier scan is still caught",
  );

  // --- staging, where the ENV VAR NAME DIFFERS FROM THE SECRET ---------------------------
  // This is the case that broke the first version of this check. It emitted
  // `PHOENIX_AUTH_SECRET-staging=PHOENIX_AUTH_SECRET-staging:latest`, which does not
  // repoint anything: run against the live service it ADDED an env var named after the
  // secret and left the real PHOENIX_AUTH_SECRET pinned at :2. The remediation must be
  // keyed by env var name.
  const stagingPinned = findPinnedSecrets(
    ["SUPABASE_SERVICE_ROLE_KEY", "PHOENIX_AUTH_SECRET", "OPENAI_API_KEY"],
    ["SUPABASE_SERVICE_ROLE_KEY-staging", "PHOENIX_AUTH_SECRET-staging", "OPENAI_API_KEY"],
    ["latest", "2", "2"],
  );
  assert.deepEqual(
    stagingPinned.map((p) => `${p.env}=${p.secret}`),
    ["PHOENIX_AUTH_SECRET=PHOENIX_AUTH_SECRET-staging", "OPENAI_API_KEY=OPENAI_API_KEY"],
    "a secret whose name differs from its env var is reported against the ENV VAR",
  );
  assert.match(
    remediationCommand("phoenix-hr-staging", "us-central1", "p", stagingPinned),
    /--update-secrets=PHOENIX_AUTH_SECRET=PHOENIX_AUTH_SECRET-staging:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest$/,
    "remediation repoints the existing env var instead of creating one named after the secret",
  );

  // --- the healthy case ------------------------------------------------------------------
  assert.deepEqual(findPinnedSecrets(["A", "B"], ["A", "B"], ["latest", "latest"]), [], "a clean service passes");
  assert.deepEqual(findPinnedSecrets([], [], []), [], "an empty read yields no findings (main() rejects it separately)");

  // A missing key must NOT be read as "latest" — a truncated or misaligned gcloud response
  // has to fail loudly rather than silently certify a service as clean.
  assert.deepEqual(
    findPinnedSecrets(["A", "B"], ["A", "B"], ["latest"]).map((p) => p.env),
    ["B"],
    "a secret with no corresponding version is treated as pinned, never as latest",
  );

  // --- the remediation line is copy-pasteable --------------------------------------------
  assert.equal(
    remediationCommand("phoenix-hr", "europe-west3", "phoenix-workforce-498619", [
      { env: "ATTENDANCE_AGENT_TOKEN", key: "2", secret: "ATTENDANCE_AGENT_TOKEN" },
    ]),
    "gcloud run services update phoenix-hr --region=europe-west3 --project=phoenix-workforce-498619 \\\n" +
      "    --update-secrets=ATTENDANCE_AGENT_TOKEN=ATTENDANCE_AGENT_TOKEN:latest",
  );
  assert.match(
    remediationCommand("phoenix-hr", "europe-west3", "p", [
      { env: "A", key: "2", secret: "A" },
      { env: "B", key: "3", secret: "B" },
    ]),
    /--update-secrets=A=A:latest,B=B:latest$/,
    "several pins are repointed in ONE revision, not one call each",
  );
}
