import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { stripComments } from "./support/comment-strip.ts";

/**
 * `phoenix_crm_visit_recordings` IS KEYED ON `path`, AND HAS NO `id` COLUMN AT ALL.
 *
 * Its 15 columns, read live from production 2026-10-23: `path` (text, NOT NULL), `issued_to_hr_id`,
 * `seat_id`, `is_test`, `issued_at`, `visit_id`, `claimed_at`, `seconds`, `bytes`, `deleted_at`,
 * `deleted_by_hr_id`, `review_status`, `reviewed_by_hr_id`, `reviewed_at`, `review_note`. Every
 * sibling in that family does have one — `phoenix_crm_visit_edits` and `phoenix_crm_removed_visits`
 * are keyed on `id`, and `phoenix_crm_unplanned_visits` on `visit_id` — so "the key is `id`" is the
 * easy assumption to carry in, and it is wrong here.
 *
 * WHY THIS IS PINNED. A PostgREST select naming a column that does not exist fails the WHOLE read
 * with 42703 — it does not drop the field and carry on — so one wrong name takes the entire caller
 * down. The System Error & Data Integrity Audit shipped on 2026-10-23 at 10:41 Cairo selecting and
 * ordering this table by `id`, and its very first production sweep, 10:56 the same morning, logged
 * `System audit detector failed: visit_lifecycle` —
 * `column phoenix_crm_visit_recordings.id does not exist`. The detector produced nothing at all;
 * neither the compiler nor a grep can see it, because a select is a string.
 */
export function runPhoenixCrmVisitRecordingsKeyIsPathTests() {
  const table = "phoenix_crm_visit_recordings";
  const files = execFileSync("git", ["grep", "-l", table, "--", "src", "app", "scripts"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"));

  assert.ok(files.length > 0, "no file reads the recordings table — the scan found nothing to check");

  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    // Each chained expression that starts at this table, up to the statement's end. The column
    // names that matter all sit inside that chain.
    const chains = code.split(`.from("${table}")`).slice(1);
    for (const tail of chains) {
      const chain = tail.split(";")[0];
      for (const call of ["select", "order", "eq", "in", "gt", "lte", "gte", "not"]) {
        const found = chain.match(new RegExp(`\\.${call}\\(\\s*\`?["\`]([^"\`]*)["\`]`));
        if (!found) continue;
        const columns = found[1].split(",").map((part) => part.trim());
        assert.ok(
          !columns.includes("id"),
          `${file}: .${call}() on ${table} names a bare "id" — this table's key is "path", and a 42703 fails the whole read`,
        );
      }
    }
  }

  // The detector that actually fell over, pinned by name so a revert is loud rather than quiet.
  const detector = stripComments(readFileSync("src/lib/system-audit/detectors/visit-lifecycle.ts", "utf8"));
  assert.ok(
    /\{ table: "phoenix_crm_visit_recordings", column: "claimed_at", tiebreak: "path" \}/.test(detector),
    "the visit_lifecycle detector must page the recordings table by its real key, path",
  );
  assert.ok(
    detector.includes('.select("path,visit_id,review_status,claimed_at,reviewed_at,deleted_at")'),
    "the detector's recordings projection must start at path, never id",
  );
  // The siblings genuinely are keyed on id — this test must not be "fixed" by renaming those too.
  assert.ok(
    /\{ table: "phoenix_crm_visit_edits", column: "edited_at", tiebreak: "id" \}/.test(detector),
    "phoenix_crm_visit_edits IS keyed on id — do not sweep it into the path rename",
  );
  assert.ok(
    /\{ table: "phoenix_crm_unplanned_visits", column: "updated_at", tiebreak: "visit_id" \}/.test(detector),
    "phoenix_crm_unplanned_visits is keyed on visit_id — likewise untouched",
  );
}
