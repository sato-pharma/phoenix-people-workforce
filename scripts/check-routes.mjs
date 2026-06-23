#!/usr/bin/env node
// Scans all tracked app/api/**/route.ts files and warns when the required Next.js
// server-side exports are missing. Missing 'runtime' or 'dynamic' causes
// route type-generation failures that cascade into typecheck + build errors.
// Uses `git ls-files` so gitignored paths (e.g. sentry-example-api) are skipped.
// Exits non-zero on any violation so it can gate CI.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Exports every api route.ts is expected to declare.
const REQUIRED_EXPORTS = ['runtime', 'dynamic'];

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`[route-check] ERROR: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`[route-check] WARN:  ${msg}`);
  warnings++;
}

// Use git ls-files so gitignored and untracked files are excluded automatically.
let routeFiles;
try {
  const out = execSync('git ls-files app/api', { cwd: ROOT, encoding: 'utf-8' });
  routeFiles = out
    .split('\n')
    .filter((f) => f.endsWith('/route.ts') || f === 'route.ts')
    .map((f) => path.join(ROOT, f));
} catch {
  fail('Could not run `git ls-files` — is this a git repository?');
  process.exit(1);
}

if (routeFiles.length === 0) {
  warn('No tracked route.ts files found under app/api — is the API directory correct?');
}

for (const file of routeFiles) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf-8');

  for (const exportName of REQUIRED_EXPORTS) {
    // Match: export const runtime = ... OR export const dynamic = ...
    const pattern = new RegExp(`export\\s+const\\s+${exportName}\\s*=`);
    if (!pattern.test(src)) {
      fail(`${rel} is missing: export const ${exportName} = ...`);
    }
  }
}

console.log(`\n[route-check] Scanned ${routeFiles.length} tracked route files.`);
if (errors > 0) {
  console.error(`[route-check] ${errors} error(s) found — add the missing exports before pushing.\n`);
  process.exit(1);
}
if (warnings > 0) {
  console.warn(`[route-check] ${warnings} warning(s) — review above.\n`);
}
console.log('[route-check] All routes OK.\n');
