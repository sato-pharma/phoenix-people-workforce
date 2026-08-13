import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// marketing_request_events — the guards that must survive an edit.
//
// The module had NO history: `pg_trigger` on every marketing table returned zero rows, and there
// was no events/history/comments table anywhere. Status changes overwrote in place. On 2026-08-09
// 1,441 rows were deleted across four marketing tables and the database recorded nothing —
// reconstructing it took five independent sources and still could not distinguish deliberate
// cleanup from an accident.
//
// Two of the assertions below exist because the first version of this migration FAILED them on
// staging. They are not hypothetical.
// ─────────────────────────────────────────────────────────────────────────────

function migrationSource() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith("_marketing_request_events.sql"));
  assert.ok(file, "the marketing_request_events migration must exist");
  return readFileSync(new URL(file, dir), "utf8");
}

export async function runMarketingRequestEventsMigrationTests() {
  const sql = migrationSource();
  const lower = sql.toLowerCase();

  /* ---------------------------------------------------------------------- */
  /* The table exists and captures both sides of the workflow                */
  /* ---------------------------------------------------------------------- */

  assert.match(lower, /create table if not exists public\.marketing_request_events/, "the events table must be created");

  for (const trigger of [
    "marketing_requests_capture_event",
    "marketing_request_steps_capture_event",
  ]) {
    assert.ok(lower.includes(trigger), `${trigger} must exist — a history nobody writes to is not a history`);
  }
  assert.match(
    lower,
    /after insert or update or delete on public\.marketing_requests/,
    "the request trigger must cover DELETE — the 2026-08-09 wipe is exactly the event that went unrecorded",
  );

  /* ---------------------------------------------------------------------- */
  /* Events must OUTLIVE the request they describe                           */
  /* ---------------------------------------------------------------------- */

  // Every other child of marketing_requests is ON DELETE CASCADE. An audit row that dies with the
  // thing it describes cannot testify about the deletion.
  const tableBody = sql.slice(
    sql.indexOf("create table if not exists public.marketing_request_events"),
    sql.indexOf("comment on table"),
  );
  assert.doesNotMatch(
    tableBody.toLowerCase(),
    /references\s+public\.marketing_requests|references\s+marketing_requests/,
    "request_id must NOT carry a foreign key — events have to survive the deletion of their request, which is the whole point of the table",
  );
  assert.match(
    lower,
    /'request_deleted'/,
    "a deletion must produce its own event kind",
  );
  assert.match(
    lower,
    /to_jsonb\(old\)/,
    "the deletion event must keep the whole row as a tombstone, not just the id",
  );
  assert.match(
    tableBody.toLowerCase(),
    /request_code\s+text/,
    "request_code must be denormalised — once the request row is gone, a bare uuid identifies nothing to a human",
  );

  /* ---------------------------------------------------------------------- */
  /* Append-only — and it must actually be enforced                          */
  /* ---------------------------------------------------------------------- */

  assert.match(
    lower,
    /before update or delete on public\.marketing_request_events/,
    "UPDATE and DELETE on the events table must be refused by a row trigger",
  );

  // PROVEN ON STAGING: with UPDATE and DELETE correctly refused, `truncate table
  // marketing_request_events` still succeeded and emptied the table. TRUNCATE fires no ROW
  // triggers, and revoking it from service_role does nothing to the table OWNER (migrations run as
  // the owner). Without a STATEMENT-level trigger, "append-only" is a claim the database does not
  // enforce.
  assert.match(
    lower,
    /before truncate on public\.marketing_request_events/,
    "TRUNCATE needs its own STATEMENT-level trigger — it fires no row triggers and the owner's privileges cannot be revoked, so without this the table can be silently emptied",
  );
  assert.match(
    lower,
    /for each statement/,
    "the truncate guard must be statement-level; a row-level trigger never sees TRUNCATE",
  );

  // PROVEN ON STAGING: the table came up with service_role already holding DELETE/UPDATE/TRUNCATE
  // via Supabase's default ACL, so a bare `grant select, insert` restricted nothing.
  assert.match(
    lower,
    /revoke\s+update,\s*delete,\s*truncate\s+on\s+table\s+public\.marketing_request_events\s+from\s+service_role/,
    "service_role is granted ALL on new public tables by default — the write privileges have to be revoked explicitly, not merely left ungranted",
  );

  /* ---------------------------------------------------------------------- */
  /* Access posture matches the module's other workflow tables               */
  /* ---------------------------------------------------------------------- */

  assert.match(lower, /alter table public\.marketing_request_events enable row level security/, "RLS must be on");
  assert.match(
    lower,
    /revoke all on table public\.marketing_request_events from anon, authenticated/,
    "anon/authenticated must hold nothing on the events table",
  );
  // Revoking FROM PUBLIC on a default ACL also strips service_role in this database.
  assert.doesNotMatch(
    lower,
    /revoke all on table public\.marketing_request_events from public\b/,
    "revoke from the named roles, never from PUBLIC — that also strips service_role here",
  );

  /* ---------------------------------------------------------------------- */
  /* SECURITY DEFINER hygiene (also enforced by check-migrations)            */
  /* ---------------------------------------------------------------------- */

  for (const fn of [
    "phx_marketing_request_events_immutable",
    "phx_capture_marketing_request_event",
    "phx_capture_marketing_step_event",
  ]) {
    assert.ok(lower.includes(fn), `${fn} must be defined`);
    assert.ok(
      new RegExp(`revoke execute on function public\\.${fn}\\(\\) from public`).test(lower),
      `${fn} is SECURITY DEFINER in public, so EXECUTE must be revoked FROM PUBLIC — anon/authenticated inherit it through PUBLIC membership`,
    );
  }
  assert.match(lower, /set search_path to 'public'/, "SECURITY DEFINER functions must pin search_path");

  /* ---------------------------------------------------------------------- */
  /* The backfill must be honest and idempotent                              */
  /* ---------------------------------------------------------------------- */

  // A derived event must never be mistakable for one captured live.
  assert.match(
    lower,
    /'backfilled', true/,
    "backfilled rows must be marked, so a derived event is never mistaken for a captured one",
  );
  const backfillInserts = (sql.match(/insert into public\.marketing_request_events\n\s*\(request_id/g) ?? []).length;
  assert.ok(backfillInserts >= 4, `expected the four backfill inserts, found ${backfillInserts}`);
  const notExistsGuards = (lower.match(/where not exists|and not exists/g) ?? []).length;
  assert.ok(
    notExistsGuards >= 4,
    "every backfill insert needs a NOT EXISTS guard — re-running a migration must not double the history",
  );

  // Nothing is invented: a step with no decision_at produces no event. Staging holds 546 approval
  // steps marked 'approved' with decision_at NULL (the bulk importer recorded approvals with no
  // decider and no time). Backfilling those with a fabricated timestamp would be worse than silence.
  assert.match(
    lower,
    /where s\.decision_at is not null/,
    "a step with no recorded decision time must produce no event — inventing a timestamp is worse than recording nothing",
  );
}
