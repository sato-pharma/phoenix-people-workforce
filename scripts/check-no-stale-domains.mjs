#!/usr/bin/env node
// CI gate: fail if runtime source re-introduces a stale Vercel domain, a dead Cloud Run host, or a
// hard dependency on Vercel-specific runtime env vars. A step in the required `validate` job
// (.github/workflows/ci.yml) and in `pnpm run ci`.
//
// Scanned: src/, app/, lib/, next.config.ts, proxy.ts, instrumentation.ts — the code that ships
// plus the code that configures the runtime.
// NOT scanned: tests/ (they intentionally assert that dead origins are REJECTED), scripts/ (same,
// and it does not ship — stale-domain-rules.mjs names the four files that force this), docs/,
// local-attendance-agent/, node_modules, build output.
//
// 🔴 THE PATTERNS, THE SCAN SURFACE AND THE OPT-OUT MARKERS ALL LIVE IN ./stale-domain-rules.mjs,
// not here. This file walks and reports; that one decides. It was split out on 2026-09-30 so
// tests/stale-domain-gate.test.ts can import the rules — this script exits at import time, so the
// gate had no unit test for its entire life, which is how it came to read next.config.ts on every
// `validate` run and pass it while that file still trusted two deleted Cloud Run hosts as Server
// Action origins.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ALLOW_MARKERS,
  EXTRA_FILES,
  ROOTS,
  findViolations,
  hasScannedExtension,
} from "./stale-domain-rules.mjs";

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
    } else if (hasScannedExtension(full)) {
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
  for (const v of findViolations(f, readFileSync(f, "utf8"))) {
    violations.push(`${v.file}:${v.line}: ${v.message} -> ${v.text}`);
  }
}

if (violations.length > 0) {
  console.error(
    "[check-no-stale-domains] FAILED — stale Vercel / Cloud Run references in shipped source:",
  );
  for (const v of violations) console.error("  " + v);
  console.error(
    "\nRemove the reference. Both platforms are dead (AGENTS.md §3), so a hostname left in shipped" +
      " source is a trust decision pointing at a name the company no longer controls.\n" +
      "\nIf a reference genuinely must stay, add the matching marker comment on that line:\n" +
      `  ${ALLOW_MARKERS.vercel}  — the documented isProductionRuntime() Vercel fallback\n` +
      `  ${ALLOW_MARKERS.gcp}  — a GCP / Cloud Run reference that cannot be reworded\n` +
      "Each marker excuses only its own platform's patterns. Prefer rewording: the comments in" +
      " next.config.ts and src/lib/synthetic-journeys/service.ts explaining these removals" +
      " deliberately avoid spelling the hostname out, so neither of them needs a marker.",
  );
  process.exit(1);
}

console.log(
  `[check-no-stale-domains] OK — scanned ${files.length} files, no stale Vercel or Cloud Run references.`,
);
