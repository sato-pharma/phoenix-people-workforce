#!/usr/bin/env node
// Backward-compatible entrypoint for older CI/workflow references.
// The canonical implementation now lives in scripts/check-migrations.mjs.

import('./check-migrations.mjs').catch((error) => {
  console.error('[migration-check] Failed to load ESM migration checker:', error);
  process.exit(1);
});
