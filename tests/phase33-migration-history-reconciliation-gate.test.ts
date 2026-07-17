import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase33MigrationHistoryReconciliationGateTests() {
  const gate = readFileSync("scripts/phase33-migration-history-reconciliation-gate.ts", "utf8");

  assert.match(gate, /BLOCKED_UNTIL_EXPLICIT_APPROVAL/);
  assert.match(gate, /noMigrationHistoryWriteExecuted: true/);
  assert.match(gate, /noMigrationApplyExecuted: true/);
  assert.match(gate, /20260518232733/);
  assert.match(gate, /phase21_security_access_governance_hardening/);
  // Deliberately still `npx` (works identically with pnpm-installed node_modules/.bin):
  // the doesNotMatch safety net below rejects the literal token "exec" anywhere in the
  // gate script, so `pnpm exec supabase ...` would trip it. Keeping npx preserves that
  // safety assertion byte-for-byte.
  assert.match(gate, /npx supabase migration repair/);
  assert.match(gate, /--status applied/);
  assert.match(gate, /supabase_migrations\.schema_migrations/);
  assert.match(gate, /on conflict \(version\) do nothing/);
  assert.match(gate, /backup\/PITR must be confirmed/);
  assert.match(gate, /Run migration repair only after explicit approval/);
  assert.match(gate, /Run Supabase dry-run after repair and confirm only Phase 28 remains pending/);

  assert.doesNotMatch(gate, /exec|spawn|execFile/);
  assert.doesNotMatch(gate, /postgres\(/);
  assert.doesNotMatch(gate, /createClient/);
  assert.doesNotMatch(gate, /\bdelete\s+from\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(gate, /\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(gate, /supabase\s+db\s+push(?![^"`]*--dry-run)/i);
  assert.doesNotMatch(gate, /vercel\s+(--prod|deploy)/i);
}
