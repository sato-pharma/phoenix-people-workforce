import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The browser roles must not hold write grants on the marketing config tables.
//
// Supabase's default privileges hand every new table in `public` the full set to anon and
// authenticated, so six marketing config tables carried INSERT/UPDATE/DELETE/TRUNCATE that nobody
// ever wrote. RLS is on with a SELECT-only policy, so the DML grants are inert today — but
// **RLS NEVER APPLIES TO TRUNCATE**, and a grant is the only control there.
//
// Measured on staging, as the anon role, inside a rolled-back transaction:
//   marketing_control_settings  -> TRUNCATE SUCCEEDED, 8 rows to 0
//   marketing_review_routing    -> TRUNCATE SUCCEEDED, 3 rows to 0
//   the other four              -> refused, but only because an inbound foreign key said no
//
// The four are protected by accident, not by design. This test pins the revoke so the accident is
// not what the module depends on.
// ─────────────────────────────────────────────────────────────────────────────

const TABLES = [
  "marketing_control_settings",
  "marketing_distributors",
  "marketing_products",
  "marketing_request_types",
  "marketing_review_routing",
  "marketing_workflow_steps",
];

function migrationSource() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith("_marketing_config_tables_revoke_browser_writes.sql"));
  assert.ok(file, "the config-grants migration must exist");
  return readFileSync(new URL(file, dir), "utf8");
}

/** Strip `--` comments so an assertion reads the SQL, not the explanation of the SQL. */
function code(sql: string) {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export async function runMarketingConfigGrantsTests() {
  const raw = migrationSource();
  const sql = code(raw);

  /* ---------------------------------------------------------------------- */
  /* 1. Every table is covered, and TRUNCATE is in every revoke              */
  /* ---------------------------------------------------------------------- */

  for (const table of TABLES) {
    const revoke = new RegExp(
      `revoke insert, update, delete, truncate, references, trigger on table public\\.${table} from anon, authenticated;`,
    );
    assert.match(
      sql,
      revoke,
      `${table} must have its write grants revoked from both browser roles, TRUNCATE included — RLS cannot stop a truncate`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Never REVOKE ... FROM PUBLIC                                         */
  /* ---------------------------------------------------------------------- */

  // Revoking PUBLIC on a default ACL also strips service_role, which would break every server path
  // in the module. This repo has shipped that bug before.
  assert.ok(
    !/revoke[^;]*from[^;]*public\s*[,;]/.test(sql.replace(/public\./g, "")),
    "the revoke must name anon and authenticated, never PUBLIC — revoking PUBLIC on a default ACL also strips service_role",
  );

  /* ---------------------------------------------------------------------- */
  /* 3. SELECT is preserved                                                  */
  /* ---------------------------------------------------------------------- */

  // Each table has a deliberate read policy and every reader is server-side. Revoking SELECT would
  // turn an anonymous read from "empty result" into "permission denied" for no security gain.
  assert.ok(
    !/revoke[^;]*\bselect\b[^;]*from anon/.test(sql),
    "SELECT must NOT be revoked — the read policy is deliberate and no reader is client-side",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. The server stays the only writer                                     */
  /* ---------------------------------------------------------------------- */

  for (const table of TABLES) {
    assert.match(
      sql,
      new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role;`),
      `${table} must keep service_role's write access — the server is the only writer and must stay one`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 5. The measured finding survives in the file                            */
  /* ---------------------------------------------------------------------- */

  // The two tables that were genuinely emptiable must be named, or the next reader "fixes" this by
  // trusting the audit ticket, which named a table that turned out to be FK-protected.
  assert.match(
    raw,
    /marketing_control_settings\s+0 inbound FKs\s+TRUNCATE SUCCEEDED/,
    "the migration must record that marketing_control_settings was actually truncatable",
  );
  assert.match(
    raw,
    /marketing_review_routing\s+0 inbound FKs\s+TRUNCATE SUCCEEDED/,
    "the migration must record that marketing_review_routing was actually truncatable",
  );
  // Asserted on ONE specific phrase, not an alternation. The first version accepted either
  // "protected four" or "saved by an inbound foreign key", and "protected four" appears elsewhere
  // in the header — so deleting the caveat left the test green. An alternation is only as strong
  // as its weakest arm.
  const prose = raw.replace(/^\s*--/gm, "").replace(/\s+/g, " ");
  assert.match(
    prose,
    /the other four are saved by an inbound foreign key rather than by any deliberate control/,
    "the migration must say the other four are protected by a foreign key rather than by design",
  );
  // And it must not overstate the risk — the last false alarm in this module cost real time.
  assert.match(
    raw,
    /NOT a remotely exploitable hole/,
    "the severity must be stated honestly: PostgREST exposes no TRUNCATE verb, so this is defence in depth",
  );
}
