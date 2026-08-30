/**
 * Does this table name describe a point-in-time snapshot rather than a live table?
 *
 * ONE definition, TWO enforcement points, and that is the whole reason this file exists:
 *
 *   - scripts/check-sql-backup-placement.ts  — reads `.sql` FILES, and fails a snapshot
 *     created in `public` at review time, before it ever exists.
 *   - scripts/check-schema-shape.ts          — reads the LIVE DATABASE, and fails a snapshot
 *     found sitting in `public`, however it got there.
 *
 * The second was added 2026-08-30 because the first cannot see the case that actually keeps
 * happening. Every one of the five pre-images relocated that day was created by hand through
 * MCP `execute_sql` during a live fix — no `.sql` file was ever written, so the file-level
 * check had nothing to read and stayed green while `public` collected snapshots for days.
 * Two checks reading two different definitions of "snapshot" would be worse than one check,
 * so neither is allowed a private copy of the rule.
 *
 * ── The two tiers ───────────────────────────────────────────────────────────────────────
 *
 * One word list cannot separate a snapshot from a live table.
 *
 * STRONG words never appear in a live table here — every `%backup%` table in production has
 * been a point-in-time copy (verified 2026-08-01: three of them, all snapshots). The word
 * alone is enough.
 *
 * WEAK words DO appear in live tables, so those only count when the name also carries a date,
 * which is what makes a name a point-in-time copy rather than a description of content.
 * `public.sales_ops_dashboard_snapshot` was a real application table with a policy, and the
 * plural `*_snapshots` tables — early_birds_period_snapshots, sos_import_coverage_snapshots,
 * field_workforce_compliance_live_snapshots — are live tables whose content happens to be
 * snapshots. None of them carries a date, so none of them matches.
 *
 * ── Why `pre` is in the weak list ───────────────────────────────────────────────────────
 *
 * Added 2026-08-30. It is the house convention for a rollback pre-image and the rule was
 * blind to it: of the five snapshots found in production `public` that day, the two named
 * `zz_backup_…` matched on the strong tier and the three named `…_20260829_pre` matched
 * nothing at all. A rule that catches two fifths of the real cases invites exactly the
 * conclusion that it is working.
 *
 * MEASURED before widening, against both live databases rather than argued: with `pre`
 * added, the rule flags all five of those names and ZERO of the 319 production / 317 staging
 * tables then in `public` — including every table above that contains a weak word. `pre` is
 * dated-gated like every other weak word, so an undated `…_pre` name is still ignored.
 */

/** Words that mean "snapshot" on their own. */
const STRONG_SNAPSHOT_NAME = /(^|_)(backup|backups|bak|undo|rollback)(_|$)/i;

/** Words that mean "snapshot" only alongside a date. */
const WEAK_SNAPSHOT_NAME = /(^|_)(snapshot|old|copy|tmp|temp|orig|prev|pre)(_|$)/i;

/** A `YYYYMMDD` stamp — what turns a description of content into a point in time. */
const DATED = /(^|_)(19|20)\d{6}(_|$)/;

export const looksLikeSnapshot = (table: string): boolean =>
  STRONG_SNAPSHOT_NAME.test(table) || (WEAK_SNAPSHOT_NAME.test(table) && DATED.test(table));

/**
 * The same rule as a Postgres POSIX regex pair, for the RPC that applies it inside the
 * database (`public.phx_ci_snapshot_tables_in_public`, added by
 * 20260830151500_ci_snapshot_tables_in_public.sql).
 *
 * Exported so a test can assert the SQL and the TypeScript still say the same thing. A
 * divergence here is invisible in every other way: each side would keep passing its own
 * tests while disagreeing about which tables are snapshots.
 */
export const SNAPSHOT_NAME_SQL = {
  strong: "(^|_)(backup|backups|bak|undo|rollback)(_|$)",
  weak: "(^|_)(snapshot|old|copy|tmp|temp|orig|prev|pre)(_|$)",
  dated: "(^|_)(19|20)[0-9]{6}(_|$)",
} as const;
