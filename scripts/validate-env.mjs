#!/usr/bin/env node
// Deploy-time env gate: fail the production deployment if the canonical app URL is
// missing/wrong or key public env vars are malformed. NEVER prints a secret value —
// only pass/fail. Run in the deploy workflow with the build secrets injected into env.
//
// The canonical origin is single-sourced from src/config/system-settings.ts
// (systemDeployment.productionUrl) so this gate can never drift from the app.

import { readFileSync } from "node:fs";

function canonicalOrigin() {
  const src = readFileSync("src/config/system-settings.ts", "utf8");
  const m = src.match(/productionUrl:\s*"([^"]+)"/);
  if (!m) {
    console.error("[validate-env] could not read systemDeployment.productionUrl");
    process.exit(2);
  }
  return m[1].replace(/\/+$/, "");
}

const CANON = canonicalOrigin();
const failures = [];
const ok = [];

function requireCanonicalUrl(name) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    failures.push(`${name} is missing (must equal the canonical origin ${CANON})`);
    return;
  }
  const v = raw.trim();
  if (!/^https:\/\//i.test(v)) failures.push(`${name} must use https`);
  if (/vercel\.app/i.test(v)) failures.push(`${name} must not be a vercel.app domain`);
  if (/\.run\.app/i.test(v)) failures.push(`${name} must be the custom domain, not the raw .run.app host`);
  if (v.replace(/\/+$/, "") !== CANON) {
    failures.push(`${name} must equal the canonical origin (${CANON})`);
  } else {
    ok.push(name);
  }
}

function requireShape(name, re, desc, { optional = false } = {}) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    if (!optional) failures.push(`${name} is missing`);
    return;
  }
  if (!re.test(raw.trim())) failures.push(`${name} has an unexpected shape (${desc})`);
  else ok.push(name);
}

// The one that broke email/Telegram links when it pointed at a dead vercel host.
requireCanonicalUrl("NEXT_PUBLIC_APP_URL");
// Supabase public config (present as build secrets).
requireShape("NEXT_PUBLIC_SUPABASE_URL", /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i, "https://<ref>.supabase.co");
requireShape("NEXT_PUBLIC_SUPABASE_ANON_KEY", /.{20,}/, "non-empty key", { optional: true });

if (failures.length > 0) {
  console.error("[validate-env] FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log(`[validate-env] OK — canonical=${CANON}; validated: ${ok.join(", ") || "(none present)"}`);
