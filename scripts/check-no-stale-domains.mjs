#!/usr/bin/env node
// CI gate: fail if runtime source re-introduces a stale Vercel domain or a hard
// dependency on Vercel-specific runtime env vars after the GCP Cloud Run migration.
//
// Scanned: src/, app/, next.config.ts, proxy.ts (the code that ships).
// NOT scanned: tests/ (they intentionally assert that old vercel origins are REJECTED),
// docs/, local-attendance-agent/, node_modules, build output.
//
// Allowed exception: `process.env.VERCEL_ENV` inside the platform-neutral
// `isProductionRuntime()` detector in src/config/system-settings.ts — it is a tolerated
// fallback (APP_ENV/NODE_ENV cover Cloud Run), not a dependency.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "app"];
const EXTRA_FILES = ["next.config.ts", "proxy.ts"];
const EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx"]);

// [regex, human message]
const FORBIDDEN = [
  [/vercel\.app/i, "stale Vercel domain (*.vercel.app)"],
  [/process\.env\.VERCEL\b/, "Vercel-only runtime flag (process.env.VERCEL)"],
  [/process\.env\.VERCEL_URL\b/, "Vercel-only runtime var (process.env.VERCEL_URL)"],
  [/process\.env\.VERCEL_PROJECT_PRODUCTION_URL\b/, "Vercel-only runtime var"],
];

const ALLOW_LINE = /platform-neutral-vercel-fallback/; // explicit opt-out marker

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (EXTS.has(full.slice(full.lastIndexOf("."))) ) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const r of ROOTS) walk(r, files);
for (const f of EXTRA_FILES) {
  try {
    statSync(f);
    files.push(f);
  } catch {
    /* optional */
  }
}

const violations = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOW_LINE.test(line)) continue;
    for (const [re, msg] of FORBIDDEN) {
      if (re.test(line)) {
        violations.push(`${f}:${i + 1}: ${msg} -> ${line.trim().slice(0, 120)}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("[check-no-stale-domains] FAILED — stale Vercel references in shipped source:");
  for (const v of violations) console.error("  " + v);
  console.error(
    "\nRemove the reference, or (only for the documented isProductionRuntime fallback) add" +
      " a `platform-neutral-vercel-fallback` marker comment on that line.",
  );
  process.exit(1);
}

console.log(`[check-no-stale-domains] OK — scanned ${files.length} files, no stale Vercel references.`);
