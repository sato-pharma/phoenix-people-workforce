/**
 * Re-cut every STORED profile photo into the portrait every new upload now gets.
 *
 * Since 2026-11-01 `uploadEmployeePhoto` makes a portrait of whatever is sent (upright, letterbox
 * bars stripped, the identity card's 0.785 : 1 frame — src/lib/employees/photo-normalize.ts). The
 * photos uploaded before that day still carry their bars and odd shapes, and the card draws them as
 * they are. This script runs the same cut over each of them.
 *
 * SAFE BY CONSTRUCTION:
 *   - dry run by default — prints what each photo would become and writes nothing;
 *   - `--apply` uploads the portrait under a NEW object path and points `employees.photo_path` at
 *     it; the original object is LEFT IN THE BUCKET at its old path (the backup), it is never removed;
 *   - a photo the cut cannot read is reported and skipped;
 *   - `--hr-id <id>` limits the run to one person.
 *
 * Usage (repo root, `.env.local` names the project — on this machine that is PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/normalize-employee-photos.ts [--apply] [--hr-id <id>]
 */
import crypto from "node:crypto";

import { normalizeHrId } from "@/lib/auth/permissions";
import { EMPLOYEE_PHOTOS_BUCKET } from "@/lib/employees/employee-photo";
import { normalizeEmployeePhoto } from "@/lib/employees/photo-normalize";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "normalize-employee-photos",
  entry: import.meta.url,
  known: ["--apply", "--hr-id"],
  hints: ["dry run by default; --apply writes; --hr-id <id> limits the run to one person"],
});

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const hrIdFlag = argv.indexOf("--hr-id");
const onlyHrId = hrIdFlag >= 0 ? argv[hrIdFlag + 1] ?? null : null;
if (hrIdFlag >= 0 && !onlyHrId) {
  console.error("normalize-employee-photos: --hr-id needs a value");
  process.exit(1);
}

type Row = { hr_id: string; full_name: string | null; photo_path: string };

const supabase = getSupabaseAdmin();

let query = supabase.from("employees").select("hr_id, full_name, photo_path").not("photo_path", "is", null).order("hr_id");
if (onlyHrId) query = query.ilike("hr_id", onlyHrId);
const { data, error } = await query;
if (error) {
  console.error(`normalize-employee-photos: could not list employees — ${error.message}`);
  process.exit(1);
}
const rows = (data ?? []) as Row[];
console.log(`${apply ? "APPLY" : "DRY RUN"} — ${rows.length} stored photo(s)${onlyHrId ? ` for ${onlyHrId}` : ""}`);

let changed = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  const label = `${row.full_name ?? "?"} (${row.hr_id})`;
  const { data: file, error: downloadError } = await supabase.storage.from(EMPLOYEE_PHOTOS_BUCKET).download(row.photo_path);
  if (downloadError || !file) {
    failed += 1;
    console.log(`  FAILED   ${label}: could not download ${row.photo_path} — ${downloadError?.message ?? "no data"}`);
    continue;
  }
  const original = Buffer.from(await file.arrayBuffer());
  const portrait = await normalizeEmployeePhoto(original);
  if (!portrait) {
    skipped += 1;
    console.log(`  SKIPPED  ${label}: not a picture the cut can read (${original.length} bytes)`);
    continue;
  }
  const bars = portrait.bars;
  const barsNote = bars.top || bars.bottom || bars.left || bars.right
    ? ` bars top ${bars.top} bottom ${bars.bottom} left ${bars.left} right ${bars.right}`
    : " no bars";
  console.log(
    `  ${apply ? "CUT     " : "WOULD CUT"} ${label}: ${portrait.source.width}×${portrait.source.height} → ${portrait.width}×${portrait.height},${barsNote}, ${Math.round(original.length / 1024)} KB → ${Math.round(portrait.bytes.length / 1024)} KB`,
  );
  if (!apply) {
    changed += 1;
    continue;
  }

  const folder = normalizeHrId(row.hr_id) ?? row.hr_id.toLowerCase();
  const path = `${folder}/${crypto.randomUUID()}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from(EMPLOYEE_PHOTOS_BUCKET)
    .upload(path, portrait.bytes, { cacheControl: "31536000", contentType: portrait.contentType, upsert: false });
  if (uploadError) {
    failed += 1;
    console.log(`  FAILED   ${label}: could not store the portrait — ${uploadError.message}`);
    continue;
  }
  const { error: updateError } = await supabase
    .from("employees")
    .update({ photo_path: path, photo_updated_at: new Date().toISOString() })
    .eq("hr_id", row.hr_id);
  if (updateError) {
    failed += 1;
    await supabase.storage.from(EMPLOYEE_PHOTOS_BUCKET).remove([path]).catch(() => {});
    console.log(`  FAILED   ${label}: could not point the record at it — ${updateError.message}`);
    continue;
  }
  changed += 1;
  console.log(`           ${label}: now ${path} (original kept at ${row.photo_path})`);
}

console.log(`\n${apply ? "changed" : "would change"} ${changed}, skipped ${skipped}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
