// Every Source of Sales table, and what the backup and the restore do with each one.
//
// ONE LIST, read by scripts/backup-source-of-sales.mjs and scripts/restore-source-of-sales.mjs.
// Until 2026-09-18 each script kept its own copy of seventeen tables, and both left out the fact
// rollup, the customer directory and presence rollups and the mapping audit (SoS re-measure
// 2026-09-18, #23). A restore then brought the import rows back with nothing the dashboards and
// the closing read from them. tests/sos-backup-covers-every-table.test.ts derives the table set
// from supabase/migrations and fails when a table is in none of the lists below.
//
// Pure data: importing it touches nothing.

/**
 * Written back by the restore, in this order. Parents come before children, so every foreign key
 * resolves when its row arrives.
 *
 * `key` is the primary key; the backup pages by it. `dropId` marks a database-assigned identity
 * `id`: the restore leaves it out and the database assigns a new one. Nothing references those
 * ids.
 *
 * @type {ReadonlyArray<{ table: string; key: readonly string[]; dropId?: boolean }>}
 */
export const RESTORED_TABLES = [
  { table: "source_of_sales_regions", key: ["region_code"] },
  { table: "source_of_sales_areas", key: ["area_code"] },
  // Blocks and bricks point at each other: a block names its master brick and a brick names its
  // block. See LATE_COLUMNS for how the restore breaks the loop.
  { table: "source_of_sales_blocks", key: ["block_code"] },
  { table: "source_of_sales_bricks", key: ["brick_id"] },
  { table: "source_of_sales_distributors", key: ["distributor_code"] },
  { table: "source_of_sales_products", key: ["product_code"] },
  // Period-scoped factory-price overrides (2026-09-28). RESTORED, not rebuilt: it is typed-in
  // business fact that nothing can derive, and losing one row silently re-values every month from
  // that period onward at the master price — which is the exact restatement the overrides exist to
  // prevent. It references source_of_sales_products, so it restores after it.
  { table: "source_of_sales_product_price_history", key: ["product_code", "effective_period"] },
  { table: "source_of_sales_area_regions", key: ["area_code"] },
  { table: "source_of_sales_distributor_profile", key: ["distributor_code"] },
  { table: "source_of_sales_distributor_certification", key: ["distributor_code"] },
  { table: "source_of_sales_region_aliases", key: ["id"], dropId: true },
  { table: "source_of_sales_area_aliases", key: ["id"], dropId: true },
  { table: "source_of_sales_product_aliases", key: ["id"], dropId: true },
  { table: "source_of_sales_territory_aliases", key: ["id"], dropId: true },
  { table: "source_of_sales_customer_map", key: ["id"], dropId: true },
  { table: "source_of_sales_customer_ai_answers", key: ["key_hash", "model"] },
  { table: "source_of_sales_mapping_audit", key: ["id"] },
  { table: "sos_even_split_customers", key: ["client_code", "official_line"] },
  { table: "sos_even_split_roster", key: ["period", "client_code", "official_line", "area_code"] },
  { table: "source_of_sales_import_batches", key: ["id"] },
  { table: "source_of_sales_import_rows", key: ["id"], dropId: true },
  // Restored, then rebuilt from the rows by the rollup rebuild, like the tables below.
  { table: "source_of_sales_import_summaries", key: ["id"], dropId: true },
  { table: "source_of_sales_reference_issues", key: ["id"], dropId: true },
  { table: "source_of_sales_brick_move_files", key: ["old_brick_id", "batch_id"] },
  { table: "sos_import_coverage_snapshots", key: ["id"] },
];

/**
 * Columns that point at a brick, which may not exist yet when their row is written. The restore
 * writes these rows with the column empty and fills it in once `after` is fully written. Every
 * block names a master brick, so without this the first block insert fails and the restore stops
 * before any brick exists.
 *
 * @type {ReadonlyArray<{ table: string; column: string; key: string; after: string }>}
 */
export const LATE_COLUMNS = [
  { table: "source_of_sales_blocks", column: "master_brick_id", key: "block_code", after: "source_of_sales_bricks" },
  { table: "source_of_sales_bricks", column: "superseded_by_brick_id", key: "brick_id", after: "source_of_sales_bricks" },
];

/**
 * Derived from the restored rows. The backup keeps them, so a restore can be checked against what
 * was there. The restore does not insert them: it runs scripts/rebuild-source-of-sales-rollups.ts,
 * the same per-batch refresh chain an import runs.
 *
 * @type {ReadonlyArray<{ table: string; key: readonly string[] }>}
 */
export const REBUILT_TABLES = [
  { table: "source_of_sales_fact_rollup", key: ["id"] },
  { table: "source_of_sales_customer_presence_rollup", key: ["batch_id", "period", "client_code", "official_line", "region_code"] },
  { table: "source_of_sales_customer_directory_rollup", key: ["batch_id", "period", "distributor_code", "client_code", "product_code", "is_direct"] },
  { table: "source_of_sales_channel_customer_rollup", key: ["id"] },
  { table: "source_of_sales_distributor_product_rollup", key: ["id"] },
];

/**
 * Backed up for the record and never written back, each with the reason.
 *
 * @type {ReadonlyArray<{ table: string; key: readonly string[]; reason: string }>}
 */
export const KEPT_TABLES = [
  {
    table: "sos_map_change_log",
    key: ["id"],
    reason:
      "The mapping-change history. Its row ids point at customer-map rows, and the restore gives "
      + "every customer-map row a new id, so a restored log would name the wrong customers. The "
      + "restore's own customer-map inserts are logged afresh by the guard trigger.",
  },
  {
    table: "sos_map_change_holds",
    key: ["id"],
    reason:
      "Held mapping moves. A hold names the customer-map row it would change by id, and those ids "
      + "change on restore, so deciding a restored hold would change a different customer.",
  },
];

/**
 * Not backed up at all, each with the reason.
 *
 * @type {ReadonlyArray<{ table: string; reason: string }>}
 */
export const NOT_BACKED_UP = [
  {
    table: "sos_map_guard_permits",
    reason:
      "One-transaction permits that let a released hold through the mapping guard. They are empty "
      + "between transactions, and restoring one would let a guarded move through unasked.",
  },
];

/** Every table the backup writes, restored ones first in restore order. */
export const BACKUP_TABLES = [...RESTORED_TABLES, ...REBUILT_TABLES, ...KEPT_TABLES];
