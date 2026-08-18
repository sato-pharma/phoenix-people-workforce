// DEAD CONFIG as of the 2026-08-01 Railway cutover — do NOT wire this into `ci.yml` or the `ci` script.
//
// This guard validates the GCP Cloud Run service's Secret Manager wiring. Production no
// longer runs on Cloud Run, and Railway has no equivalent concept: its variables hold values
// directly, with no version to pin, so there is nothing here for it to check. The script still
// EXITS 0 today only because the billing-disabled project continues to answer
// `gcloud run services describe` — putting it back in a validation gate would therefore pass
// now and hard-fail for everyone once GCP reclaims the project (~2026-08-31), breaking CI on a
// timer. Kept, not deleted, because it is the written record of the incident below and would
// be needed verbatim if the Cloud Run rollback path were ever taken.
//
// Asserts that every Cloud Run secret env var reads Secret Manager's `latest` version
// rather than a hard-pinned number.
//
// WHY. On 2026-07-31 a CRON_SECRET rotation 401'd all 8 cron jobs for ~14 minutes. The
// secret itself was fine; the service had been wired as `secretKeyRef: {key: "2"}` while
// the schedulers carried v4, and v2 was then disabled. A pinned version cannot pick up a
// rotation, and breaks outright the moment that version is disabled.
//
// That was not a one-off. The audit log shows the same two-step four more times the same
// evening — `gcloud secrets versions add`, then a service update wiring the NEW version by
// number instead of `latest`:
//
//     NOTIFICATION_WEBHOOK_SECRET  v3 21:08  -> pinned :3
//     BREVO_WEBHOOK_SECRET         v3 21:08  -> pinned :3
//     PHOENIX_AUTH_SECRET          v2 21:17  -> pinned :2
//     ATTENDANCE_AGENT_TOKEN       v2 21:35  -> pinned :2   (service replaced 21:37)
//
// None of those had fired yet only because nobody had disabled the older versions. The
// most dangerous was PHOENIX_AUTH_SECRET: it signs session cookies, so a rotation while
// pinned would not degrade a background job, it would sign out every user at once.
//
// No code emits these pins — the deploy workflow passes `--image` and inherits whatever
// wiring the service already has, so CI propagates a pin but never originates one. They
// are typed by hand during rotations, which is exactly the kind of mistake a check should
// catch rather than a runbook hope to prevent. See docs/security/secret-rotation.md.
//
// ENV NAME vs SECRET NAME. `--update-secrets` is keyed by the ENV VAR name, not the secret
// it points at, and on staging the two routinely differ (PHOENIX_AUTH_SECRET reads the
// secret PHOENIX_AUTH_SECRET-staging). An earlier version of this file emitted
// `SECRET=SECRET:latest`, which does not repoint anything — it ADDS a second env var named
// after the secret and leaves the real one pinned. That mistake was made against a live
// service. Report and remediate by env var name.
//
// SAFETY. `gcloud run services describe --format=json` prints every env var VALUE,
// including secret material — it caused a real credential exposure on 2026-07-31. This
// script therefore projects ONLY the env NAME and the two secretKeyRef paths, none of
// which can contain a value. Do not "simplify" this to a json read.

import { execFileSync } from "node:child_process";

const SERVICE = process.env.CLOUD_RUN_SERVICE ?? "phoenix-hr";
const REGION = process.env.CLOUD_RUN_REGION ?? "europe-west3";
const PROJECT = process.env.GCP_PROJECT_ID ?? "phoenix-workforce-498619";

// The one version reference that survives a rotation. Anything else is a pin.
const UNPINNED = "latest";

export type SecretRef = { env: string; secret: string; key: string };

// The decision, split from the gcloud call so it can be tested against the wiring really
// observed in production and staging rather than only exercised live.
//
// The three lists are index-aligned across ALL env vars: gcloud emits an empty entry for
// every plain-valued variable, so a row with an empty secret name is simply not
// secret-backed. Callers must NOT pre-filter the blanks, or the columns shear apart.
export function findPinnedSecrets(
  envNames: readonly string[],
  secretNames: readonly string[],
  keys: readonly string[],
): SecretRef[] {
  const pinned: SecretRef[] = [];
  for (let i = 0; i < envNames.length; i += 1) {
    const secret = (secretNames[i] ?? "").trim();
    if (!secret) continue; // a literal env var, nothing to pin
    const key = (keys[i] ?? "").trim();
    if (key === UNPINNED) continue;
    pinned.push({ env: envNames[i].trim(), key, secret });
  }
  return pinned;
}

// Keyed by env var name — see the ENV NAME vs SECRET NAME note above.
export function remediationCommand(service: string, region: string, project: string, pinned: readonly SecretRef[]): string {
  return (
    `gcloud run services update ${service} --region=${region} --project=${project} \\\n` +
    `    --update-secrets=${pinned.map(({ env, secret }) => `${env}=${secret}:latest`).join(",")}`
  );
}

// On Windows gcloud is a .cmd, and since the CVE-2024-27980 mitigation Node refuses to
// spawn one without a shell (EINVAL). CI is Linux, so the default path stays shell-free
// with argv passed as an array; Windows gets a shell purely so local runs work.
const IS_WINDOWS = process.platform === "win32";

// Guards the shell path above: these three come from the environment, and a shell turns a
// hostile value into command execution. Cloud Run/GCP identifiers are this charset anyway,
// so a rejection here means a typo, not a limitation.
function assertSafeTarget(): void {
  for (const [name, value] of [
    ["CLOUD_RUN_SERVICE", SERVICE],
    ["CLOUD_RUN_REGION", REGION],
    ["GCP_PROJECT_ID", PROJECT],
  ] as const) {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`${name} contains unexpected characters: ${JSON.stringify(value)}`);
    }
  }
}

function gcloudProjection(path: string): string[] {
  const args = [
    "run",
    "services",
    "describe",
    SERVICE,
    "--region",
    REGION,
    "--project",
    PROJECT,
    `--format=value(spec.template.spec.containers[0].env[].${path})`,
  ];
  const out = IS_WINDOWS
    ? execFileSync("gcloud.cmd", args.map((a) => `"${a}"`), {
        encoding: "utf8",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // gcloud joins repeated values with ";" and emits an EMPTY entry where the field is
  // absent, which is what keeps the three projections aligned — so trim only the trailing
  // newline and never drop blanks. Safe separator: Secret Manager names and env var names
  // are [A-Za-z0-9_-], and a version is "latest" or digits, so none can contain a ";".
  return out.replace(/[\r\n]+$/, "").split(";");
}

function main(): void {
  assertSafeTarget();
  const envNames = gcloudProjection("name");
  const secretNames = gcloudProjection("valueFrom.secretKeyRef.name");
  const keys = gcloudProjection("valueFrom.secretKeyRef.key");

  if (new Set([envNames.length, secretNames.length, keys.length]).size !== 1) {
    console.error(
      `check-secret-pins: projections disagree on length (env=${envNames.length}, ` +
        `secret=${secretNames.length}, key=${keys.length}). Refusing to report a pass on an ambiguous read.`,
    );
    process.exitCode = 1;
    return;
  }

  const secretBacked = secretNames.filter((name) => name.trim().length > 0).length;
  if (secretBacked === 0) {
    console.error(
      `check-secret-pins: ${SERVICE} reported no secret-backed env vars at all. That is not a healthy ` +
        "service, so this is a failure rather than a vacuous pass.",
    );
    process.exitCode = 1;
    return;
  }

  const pinned = findPinnedSecrets(envNames, secretNames, keys);

  if (pinned.length > 0) {
    console.error(`check-secret-pins: ${pinned.length} of ${secretBacked} secrets are pinned to a fixed version:\n`);
    for (const { env, secret, key } of pinned) {
      console.error(`  ${env} -> ${secret}:${key}${env === secret ? "" : "   (env var name differs from the secret)"}`);
    }
    console.error(
      "\nA pinned version cannot pick up a rotation and breaks outright once that version is disabled " +
        "(this 401'd every cron on 2026-07-31). Repoint each one, in a single revision:\n\n" +
        `  ${remediationCommand(SERVICE, REGION, PROJECT, pinned)}\n\n` +
        "Confirm first that each pinned version IS the newest enabled one (`gcloud secrets versions list <NAME>`).\n" +
        "If it is, the switch is value-neutral. If it is not, repointing CHANGES the live value — and for\n" +
        "PHOENIX_AUTH_SECRET that signs out every user. See docs/security/secret-rotation.md.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`check-secret-pins: OK — all ${secretBacked} secrets on ${SERVICE} read :latest.`);
}

// Only run when invoked directly, so the test can import findPinnedSecrets().
if (process.argv[1] && /check-secret-pins\.ts$/.test(process.argv[1])) {
  try {
    main();
  } catch (error) {
    // Includes gcloud not being installed or authenticated: a check that cannot READ the
    // service must fail, never quietly report a pass.
    console.error("check-secret-pins: FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
