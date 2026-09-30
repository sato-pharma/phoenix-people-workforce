#!/usr/bin/env node
// Local/manual env gate: is the canonical app URL right, and are the public Supabase values the
// right shape? NEVER prints a value — only pass/fail. `pnpm run validate:env`.
//
// 🔴 A THIN WRAPPER SINCE 2026-09-30, AND THAT IS THE WHOLE POINT OF THIS FILE NOW.
// Its two real assertions — reject a `.run.app` host, and require the canonical origin — were the
// only place in the repo that checked them, and it ran NOWHERE: `git grep validate-env -- .github`
// returned nothing, it is in no `check:*` aggregate, and its name is outside the `check:` prefix that
// `tests/ci-gate-parity.test.ts` polices. So a real gate sat unwired while the thing it guarded
// (`APP_URL` pointing at a bare Railway host instead of the custom domain, which silently sends every
// password-setup link, offer URL and email CTA to the wrong origin) had nothing watching it.
//
// The fix was not to wire this script in — it cannot run as a bare CI step, because it needs the REAL
// production values and exits 1 with nothing set. It was to fold the assertions into
// `scripts/validate-railway-production-secrets.mjs`, which is the one place that HAS those values,
// and which now runs daily on a schedule (`.github/workflows/secret-drift-check.yml`).
//
// 🔴 SO THE RULES LIVE IN `scripts/secret-policy.mjs` AND ARE IMPORTED HERE, NOT RESTATED.
// Two copies of one rule is exactly the drift this repo keeps paying for — a bare `nodemailer`
// override silently swallowing a Dependabot bump, a `secret-scan` demotion that eleven docs missed.
// Leaving the regexes duplicated in this file would have meant the wired gate and the unwired one
// could disagree about what a valid production URL is, and only one of them would be enforced.
//
// Kept rather than deleted because it is the only way to run these checks against a LOCAL `.env`
// without a Railway credential.

import { canonicalProductionOrigin, checkCanonicalOrigins } from "./secret-policy.mjs";

const CANON = canonicalProductionOrigin();
const failures = [];
const ok = [];

// The canonical-origin and dead-platform rules, single-sourced. `checkCanonicalOrigins` reads the
// same value map shape the Railway validator builds, so local and production are judged identically.
const valuesByName = new Map(
  Object.entries(process.env)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([name, value]) => [name, value]),
);
failures.push(...checkCanonicalOrigins(valuesByName, "production"));
if (valuesByName.has("NEXT_PUBLIC_APP_URL") && failures.length === 0) ok.push("NEXT_PUBLIC_APP_URL");

/** Shape-only checks with no production counterpart, so they stay local to this script. */
function requireShape(name, re, desc, { optional = false } = {}) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    if (!optional) failures.push(`${name} is missing`);
    return;
  }
  if (!re.test(raw.trim())) failures.push(`${name} has an unexpected shape (${desc})`);
  else ok.push(name);
}

requireShape("NEXT_PUBLIC_SUPABASE_URL", /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i, "https://<ref>.supabase.co");
requireShape("NEXT_PUBLIC_SUPABASE_ANON_KEY", /.{20,}/, "non-empty key", { optional: true });

if (failures.length > 0) {
  console.error("[validate-env] FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log(`[validate-env] OK — canonical=${CANON}; validated: ${ok.join(", ") || "(none present)"}`);
