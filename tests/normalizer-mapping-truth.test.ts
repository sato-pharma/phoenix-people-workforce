import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

import { customerDetailRow } from "../src/lib/sales/normalizer/customer-details.ts";
import { teachesFreeSteps } from "../src/lib/sales/normalizer/customer-map-teaching.ts";
import { pickConfidence } from "../src/lib/sales/normalizer/pick-confidence.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

// The mapping-truth fixes of 2026-09-18, found while auditing live customer mappings before the 199
// Pharma Overseas pharmacies were re-mapped ("don't build on the wrong"):
//
//   F1  a saved mapping keeps the pharmacy's name and address, filling blanks only (2,484 normalizer
//       and 69 Auto-map rows had neither, so the free steps could not learn from them)
//   F2  a pick changed by hand saves no AI confidence (it kept the number the AI gave another brick)
//   F4  only a person's pick, an older mapping or a guess at the auto-accept bar teaches the free
//       steps (a 10% guess saved unreviewed came back as a 90% answer for the next pharmacy)
//   F5  the history heal and correction step around a locked month instead of failing on it (one
//       published row cancelled a customer's whole heal), leaving any sales FILE that touches a
//       locked month whole (a July file mixes Head Office rows with locked ones, and its totals can
//       never be rebuilt while the lock stands)
//   F6  the mapping guard stops calling the re-map of a switched-off row a region move
//
// The database halves are pinned on the definition the database will actually have: the LAST
// migration that creates each function.

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase/migrations");

/** Strip block and line comments so an assertion can never match prose in a migration header. */
function code(source: string): string {
  return stripSqlComments(source).replace(/(^|[^:])--[^\n]*/g, "$1");
}

/** Collapse whitespace so a predicate split over lines still matches as one phrase. */
function flat(source: string): string {
  return source.replace(/\s+/g, " ");
}

/** The body of public.`name` in the last migration that creates it, with that file's name. */
function effectiveDefinition(name: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = code(readFileSync(join(MIGRATIONS, file), "utf8"));
    const match = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i").exec(sql);
    if (!match) continue;
    const from = sql.slice(match.index);
    const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(from)?.[1] ?? "$function$";
    const bodyStart = from.indexOf(tag) + tag.length;
    const bodyEnd = from.indexOf(tag, bodyStart);
    found = { file, body: flat(bodyEnd === -1 ? from : from.slice(0, bodyEnd)) };
  }
  assert.ok(found, `no migration creates public.${name}`);
  return found!;
}

function migration(fileName: string): string {
  return flat(code(readFileSync(join(MIGRATIONS, fileName), "utf8")));
}

/** TypeScript with its comment lines dropped (whole-line `//` and block-comment lines), whitespace collapsed. */
function source(path: string): string {
  return flat(stripComments(readFileSync(join(ROOT, path), "utf8")));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// A sales file that touches a locked month is left whole. Skipping only its locked rows is not enough:
// every rollup rebuild deletes and re-inserts ALL of a file's rollup rows under the same lock trigger,
// and a July or August file mixes Head Office rows (never locked) with locked-line rows.
const JUDGES_EACH_FILE = "where public.sos_import_batch_touches_locked_closing(f.batch_id)";
const LEAVES_LOCKED_FILES_WHOLE = "and not (r.batch_id = any (v_frozen))";
// Each file is judged once, over a list of files collected first. Written as a filter on a subquery
// over the rows, the planner pushed the judgement into the row scan and ran it once per ROW: 152
// judgements for one pharmacy's 8 files took 9.3 s, and the app's database calls are cancelled at 8.
const JUDGES_A_LIST_OF_FILES = "from unnest(v_files) as f(batch_id) where public.sos_import_batch_touches_locked_closing(f.batch_id)";
const JUDGES_EACH_ROW = ") f where public.sos_import_batch_touches_locked_closing(f.batch_id)";
// The lock trigger's own match (phx_reject_write_to_locked_closing), on the row's month AND the file's.
const A_FILE_TOUCHES_A_LOCK = flat(`join public.monthly_closing_locks l
  on l.unlocked_at is null
 and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
 and l.period in (r.invoice_period, b.period)`);

function aHandChangedPickSavesNoAiConfidence() {
  // Left as the suggestion chose it: the suggestion's confidence describes this brick.
  assert.equal(pickConfidence("CA1-01", "CA1-01", 62), 62, "an untouched suggestion keeps its confidence");
  assert.equal(pickConfidence(" ca1-01 ", "CA1-01", 62), 62, "the same brick in another case or spacing is still the suggestion's own");
  // The headline: a person picked another brick. The 62% was the AI's belief in CA1-01, not CA2-07.
  assert.equal(pickConfidence("CA2-07", "CA1-01", 62), undefined,
    "a pick changed by hand must save NO confidence - it kept the number the AI gave a different brick");
  assert.equal(pickConfidence("CA1-01", undefined, 62), undefined, "no suggestion on record means no confidence to carry");
  assert.equal(pickConfidence(undefined, "CA1-01", 62), undefined, "no pick, nothing to save");
  assert.equal(pickConfidence("CA1-01", "CA1-01", undefined), undefined, "a suggestion with no confidence carries none");
  assert.equal(pickConfidence("CA1-01", "CA1-01", Number.NaN), undefined, "a confidence that is not a number is none");

  // The screen wiring: the badge and the save both read the pick-aware confidence, never the raw map.
  const workspace = source("src/components/sales/normalizer-workspace.tsx");
  assert.match(workspace, /pickConfidence\(picks\[key\], aiPick\[key\], aiConfidence\[key\]\)/,
    "the normalizer must judge a row's confidence against the suggestion's own brick");
  assert.match(workspace, /confidence: shownConfidence\(`c:\$\{u\.raw\}`\)/,
    "a customer save must send the pick-aware confidence");
  assert.doesNotMatch(workspace, /confidence: aiConfidence\[`c:\$\{u\.raw\}`\]/,
    "the raw AI confidence must not be saved beside a pick a person changed");
  assert.doesNotMatch(workspace, /<ConfidenceBadge pct=\{aiConfidence\[/,
    "the badge must not show the AI's number beside a brick it never chose");
  // A fresh suggestion replaces the confidence it describes rather than merging over it.
  assert.match(workspace, /else delete next\[`c:\$\{s\.raw\}`\]/,
    "a suggestion with no confidence must clear the number an earlier run gave another brick");
}

function onlyTrustedMappingsTeachTheFreeSteps() {
  // The headline: a weak saved suggestion teaches nothing.
  assert.equal(teachesFreeSteps({ confidence: 10, source: "normalizer" }, 95), false,
    "a 10% guess saved unreviewed must not teach - it came back as a 90% answer for the next pharmacy");
  assert.equal(teachesFreeSteps({ confidence: 94, source: "normalizer" }, 95), false, "just under the auto-accept bar does not teach");
  assert.equal(teachesFreeSteps({ confidence: 95, source: "normalizer" }, 95), true, "at the auto-accept bar it teaches");
  assert.equal(teachesFreeSteps({ confidence: 92, source: "normalizer" }, 90), true, "the bar is the one Auto-map applies, not a constant");
  // A person's pick is saved with no confidence; an older mapping predates confidences.
  assert.equal(teachesFreeSteps({ confidence: null, source: "normalizer" }, 95), true, "a person's pick teaches");
  assert.equal(teachesFreeSteps({ source: "normalizer" }, 95), true, "a mapping with no confidence on record teaches");
  // Other sources are not saved suggestions: Auto-map's own passed its gate, the owner's are rulings.
  assert.equal(teachesFreeSteps({ confidence: 93, source: "auto" }, 95), true, "Auto-map's saves teach");
  assert.equal(teachesFreeSteps({ confidence: 30, source: "sheet-verified" }, 95), true, "an owner-verified mapping teaches");
  assert.equal(teachesFreeSteps({ confidence: 20, source: null }, 95), true, "a mapping with no source is an older one and teaches");

  const suggest = source("src/lib/sales/normalizer/customer-suggest.ts");
  assert.match(suggest, /\.select\("id,customer_name,address,brick_id,customer_code,distributor_code,source,confidence"\)/,
    "the map read must carry source and confidence, or the filter has nothing to judge");
  assert.match(suggest, /const teaching = customerMapRows\.filter\(\(row\) => teachesFreeSteps\(row\)\);/,
    "the free steps must learn from the filtered map");
  assert.match(suggest, /const mapped: MappedCustomerRow\[\] = teaching\.map\(/,
    "the free steps' indexes must be built from the teaching rows, not the whole map");
  assert.match(suggest, /for \(const row of teaching\) \{/,
    "the AI's reference list must come from the teaching rows too");
  assert.doesNotMatch(suggest, /customerMapRows\.map\(/, "no index may be built from the unfiltered map");
}

function aSavedMappingKeepsTheNameAndAddress() {
  // Pure shape of what is sent.
  assert.equal(customerDetailRow("PS", "1001", "  ", undefined), null, "a sheet with neither sends nothing");
  assert.equal(customerDetailRow("PS", "1001", 42, null), null, "a value that is not text is no name");
  assert.deepEqual(customerDetailRow("PS", "1001", "  صيدلية الشفاء  ", " شارع النيل "), {
    address: "شارع النيل",
    customer_code: "1001",
    customer_name: "صيدلية الشفاء",
    distributor_code: "PS",
  }, "the name and address are sent trimmed, keyed exactly as the mapping was written");
  assert.deepEqual(customerDetailRow("PS", "1001", "صيدلية", ""), {
    address: null,
    customer_code: "1001",
    customer_name: "صيدلية",
    distributor_code: "PS",
  }, "a blank address is sent as none, so it can never blank a stored one");

  // The database half: blanks only, and nothing but the name and the address.
  const fill = effectiveDefinition("sos_customer_map_fill_blanks");
  assert.match(fill.body, /set customer_name = case when nullif\(btrim\(m\.customer_name\), ''\) is null then coalesce\(i\.customer_name, m\.customer_name\) else m\.customer_name end, address = case when nullif\(btrim\(m\.address\), ''\) is null then coalesce\(i\.address, m\.address\) else m\.address end from incoming i/,
    `${fill.file}: a stored name or address must never be overwritten - one code can name different pharmacies over time`);
  assert.doesNotMatch(fill.body, /\b(brick_id|area_code|region_code|source|confidence|active|mapped_by)\s*=/,
    `${fill.file}: the fill must write the name and address only - never the mapping itself`);
  assert.match(fill.body, /where m\.distributor_code = i\.distributor_code and m\.customer_code = i\.customer_code/,
    `${fill.file}: the fill must match exactly on the conflict key the upsert wrote`);
  const fillFile = migration(fill.file);
  assert.match(fillFile, /security definer set search_path to 'public'/, `${fill.file}: a security-definer function pins its search_path`);
  assert.match(fillFile, /revoke execute on function public\.sos_customer_map_fill_blanks\(jsonb\) from public, anon, authenticated;/,
    `${fill.file}: no browser role may call the fill`);
  assert.match(fillFile, /grant execute on function public\.sos_customer_map_fill_blanks\(jsonb\) to service_role;/,
    `${fill.file}: the server calls the fill as service_role`);

  // The write path sends them only for rows the upsert actually wrote (a held move is not one).
  const mapping = source("src/lib/sales/normalizer/mapping.ts");
  assert.match(mapping, /const details = customerDetailRow\(dist, raw, mapping\.name, mapping\.address\);/,
    "saveMappings must build each customer row's name and address from what the caller sent");
  assert.match(mapping, /return detail && written\.has\(`\$\{detail\.distributor_code\} \$\{detail\.customer_code\}`\) \? \[detail\] : \[\];/,
    "a name must go only to a row the upsert wrote - a held move keeps its old brick, and the sheet's name must not land beside it");
  assert.match(mapping, /supabase\.rpc\("sos_customer_map_fill_blanks", \{ p_rows: rows\.slice\(i, i \+ CHUNK\) \}\)/,
    "the name and address travel through the blank-only fill, never the upsert");

  // Every writer sends them.
  assert.match(source("src/components/sales/normalizer-workspace.tsx"), /name: u\.rawName, address: u\.rawAddress/,
    "the normalizer's Save must send the pharmacy's name and address");
  assert.match(source("app/api/sales/normalizer/mappings/auto-map/route.ts"), /address: unknownByRaw\.get\(s\.raw\)\?\.rawAddress,[\s\S]*name: unknownByRaw\.get\(s\.raw\)\?\.rawName,/,
    "Auto-map must send the pharmacy's name and address");
  assert.match(source("src/components/sales/sales-upload-workspace.tsx"), /\.\.\.\(g\.type === "customer" \? \{ name: u\.rawName, address: u\.rawAddress \} : \{\}\)/,
    "the upload screen must send the pharmacy's name and address");
  assert.match(source("src/components/sales/source-of-sales-mapping-tab.tsx"), /name: customer\?\.rawName, address: customer\?\.rawAddress/,
    "the Mapping tab must send the pharmacy's name and address");
  const service = source("src/lib/sales/normalizer/service.ts");
  assert.match(service, /selectAllImportRows\("distributor_code,client_code,brick_id,client_name,client_address"/,
    "history mining must read the name and address it learns with");
  assert.match(service, /name: String\(row\.client_name \?\? ""\)\.trim\(\), address: String\(row\.client_address \?\? ""\)\.trim\(\),/,
    "history mining takes the name from the same row as the brick - EP-PHS sends one code for different pharmacies");
  assert.match(service, /name: firstText\(row, customerNameCols\)/, "learning from a cleaned file must send the name");
}

function theHealStepsAroundALockedMonth() {
  // What "touches a locked month" means: any row of the file, on its own month or the file's.
  const judge = effectiveDefinition("sos_import_batch_touches_locked_closing");
  assert.ok(judge.body.includes(A_FILE_TOUCHES_A_LOCK),
    `sos_import_batch_touches_locked_closing (latest: ${judge.file}) must match an open lock on the row's line and on the row's `
      + "month OR the file's month - the fact rollup files every row under the file's month");
  assert.match(judge.body, /where r\.batch_id = p_batch_id/, `${judge.file}: the judgement is about one whole file`);

  for (const name of ["sos_backfill_import_rows_from_customer_map", "sos_reconcile_import_rows_from_customer_map"]) {
    const { file, body } = effectiveDefinition(name);
    assert.ok(body.includes(JUDGES_EACH_FILE) && body.includes(LEAVES_LOCKED_FILES_WHOLE),
      `${name} (latest: ${file}) must leave a whole file untouched when it touches a locked month - skipping only the locked rows `
        + "let it change a July Head Office row whose file could then never be rebuilt (\"Monthly closing CNS 2026-07 is LOCKED\")");
  }
  for (const name of [
    "sos_backfill_import_rows_from_customer_map",
    "sos_reconcile_import_rows_from_customer_map",
    "sos_count_reconcilable_import_rows",
  ]) {
    const { file, body } = effectiveDefinition(name);
    assert.ok(body.includes(JUDGES_A_LIST_OF_FILES) && !body.includes(JUDGES_EACH_ROW),
      `${name} (latest: ${file}) must collect the files first and judge each one once - a filter on a subquery over the rows `
        + "was judged per ROW (9.3 s for one pharmacy's 152 rows), past the 8 seconds the app's database calls get");
  }
  // The heal is still a gap-filler only, and judges only the files it would fill.
  const heal = effectiveDefinition("sos_backfill_import_rows_from_customer_map");
  assert.equal(occurrences(heal.body, "and (r.brick_id is null or r.brick_id = '')"), 2,
    `${heal.file}: the heal must still fill a missing brick only, and judge only the files holding one - a customer with nothing to heal pays nothing`);
  // The preview counts what the correction will change: both of its queries carry the same filter.
  const preview = effectiveDefinition("sos_count_reconcilable_import_rows");
  assert.ok(preview.body.includes(JUDGES_EACH_FILE), `${preview.file}: the preview must judge files exactly as the correction does`);
  assert.equal(occurrences(preview.body, LEAVES_LOCKED_FILES_WHOLE), 2,
    `${preview.file}: the correction's preview must leave locked files out of both its count and its brick breakdown`);
  // The grants stay service_role only.
  const fixFile = migration(heal.file);
  const signatures: Array<[string, string]> = [
    ["sos_backfill_import_rows_from_customer_map", "text, text"],
    ["sos_reconcile_import_rows_from_customer_map", "text, text"],
    ["sos_count_reconcilable_import_rows", "text, text"],
    ["sos_import_batch_touches_locked_closing", "uuid"],
  ];
  for (const [name, args] of signatures) {
    assert.match(fixFile, new RegExp(`revoke execute on function public\\.${name}\\(${args}\\) from public, anon, authenticated;`),
      `${heal.file}: ${name} must stay out of reach of the browser roles`);
    assert.match(fixFile, new RegExp(`grant execute on function public\\.${name}\\(${args}\\) to service_role;`),
      `${heal.file}: ${name} must stay callable by the server`);
  }
}

function aSwitchedOffRowIsNotARegionMove() {
  const { file, body } = effectiveDefinition("sos_map_guard_customer");
  // The headline: the region reason sits inside the live-row check.
  assert.match(body,
    /if old\.active is not false then v_old_rgn := public\.sos_map_region_of_area\(old\.area_code\); v_new_rgn := public\.sos_map_region_of_area\(new\.area_code\); if v_old_rgn is distinct from v_new_rgn then v_reasons := array_append\(v_reasons, format\('moves the customer from region %s to %s'/,
    `sos_map_guard_customer (latest: ${file}) must judge a region move only for a LIVE row - a switched-off row's brick is discarded, `
      + "so re-mapping it is a new mapping and was being held and silently dropped");
  // The owner's decisions are still held, switched on or not.
  assert.match(body,
    /if old\.source ~ '\^\(owner-\|final-new-\)' or old\.source = 'sheet-verified' then v_reasons := array_append\(v_reasons, 'overwrites a mapping decision of yours'\); end if; if old\.active is not false then/,
    `sos_map_guard_customer (latest: ${file}): overwriting a decision of the owner's must still be held, whether or not the row is switched on`);
  // A held change is still logged and still dropped; an applied one is still logged.
  assert.match(body, /values \(tg_table_name, new\.id, v_key, 'update', 'held', v_reasons, to_jsonb\(old\), to_jsonb\(new\), v_actor\)/,
    `sos_map_guard_customer (latest: ${file}): a held change must still be logged`);
  assert.match(body, /current_user, v_actor\); return null; end;/, `sos_map_guard_customer (latest: ${file}): a held change must still be dropped`);
  assert.match(body, /values \(tg_table_name, new\.id, v_key, 'update', 'applied', to_jsonb\(old\), to_jsonb\(new\), v_actor\); return new;/,
    `sos_map_guard_customer (latest: ${file}): an applied change must still be logged`);
  assert.match(migration(file), /revoke execute on function public\.sos_map_guard_customer\(\) from public, anon, authenticated;/,
    `${file}: the guard function stays out of reach of the browser roles`);
}

export function runNormalizerMappingTruthTests() {
  aHandChangedPickSavesNoAiConfidence();
  onlyTrustedMappingsTeachTheFreeSteps();
  aSavedMappingKeepsTheNameAndAddress();
  theHealStepsAroundALockedMonth();
  aSwitchedOffRowIsNotARegionMove();
}
