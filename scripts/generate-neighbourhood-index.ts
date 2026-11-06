// Regenerates src/lib/geo/neighbourhood-index-generated.ts from the production brick table.
//
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//        scripts/generate-neighbourhood-index.ts
//
// READ-ONLY against the database. It selects from source_of_sales_bricks and areas and writes one
// file; it never mutates anything.
//
// WHY GENERATED AND NOT QUERIED. The suggestion runs in the recruiter's browser, on every keystroke
// of the candidate list, and the brick table changes a few times a year. Baking it means no query
// on the page load, no service-role client anywhere near the client bundle, and — the reason that
// actually decided it — the mapping lands in the PR diff, where a person can read which
// neighbourhood was attached to which area before it ships. A stale index is safe: it can only fail
// to suggest, never suggest something wrong.
//
// WHAT IS BAKED IS THE ARABIC NAME, NOT A KEY. The file carries the brick name exactly as the
// company recorded it, and the patterns are compiled from it at module load. That is deliberate:
// the first version of this baked a precomputed consonant key, which made the index unreadable and
// meant a change to the matcher silently did nothing until somebody remembered to regenerate. A
// person reading the diff should see "المطريه", not "mtr".
//
// Rerun it when bricks or areas change. The test that pins this file checks its shape, not its
// contents, so a rerun does not need the test rewritten.

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { compileArabicPlace } from "@/lib/geo/arabic-place-match";
import { fetchAllRows } from "@/lib/supabase/paginated";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("missing Supabase env — run with --env-file-if-exists=.env.local");
const db = createClient(url, key, { auth: { persistSession: false } });

// Both reads page: one read stops silently at 1,000 rows, and a brick lost here is a place never suggested.
const areaRows = await fetchAllRows<{ code?: string; name?: string }>(
  () => db.from("areas").select("code,name").eq("is_active", true),
  "id",
);
const areaNameByCode = new Map<string, string>();
for (const row of areaRows) {
  const code = String(row.code ?? "").trim();
  const name = String(row.name ?? "").trim();
  if (code && name) areaNameByCode.set(code, name);
}

const brickRows = await fetchAllRows<{ brick_name?: string; area_code?: string }>(
  () => db.from("source_of_sales_bricks").select("brick_name,area_code").eq("active", true),
  "brick_id",
);

/**
 * Governorates, as the brick table spells them when it uses one to tell two places apart.
 *
 * Only needed for the pairs that do NOT use a dash: "المطريه الدقهلية" and "بنى عبيد الدقهلية".
 * Every other disambiguated name in the table separates the qualifier with a dash.
 */
const GOVERNORATE_WORDS = new Set([
  "اسكندرية", "اسكندريه", "اسماعيلية", "اسماعيليه", "اسوان", "اسيوط", "اقصر", "بحيرة", "بحيره",
  "بورسعيد", "جيزة", "جيزه", "دقهلية", "دقهليه", "دمياط", "سوهاج", "سويس", "شرقية", "شرقيه",
  "غربية", "غربيه", "فيوم", "قاهرة", "قاهره", "قليوبية", "قليوبيه", "قنا", "منوفية", "منوفيه",
  "منيا", "مطروح",
]);

/** Arabic brick name -> the area names it points at. */
const areasByName = new Map<string, Set<string>>();
let refused = 0;
const refusedNames: string[] = [];

for (const row of brickRows ?? []) {
  const brickName = String((row as { brick_name?: string }).brick_name ?? "").trim();
  const areaCode = String((row as { area_code?: string }).area_code ?? "").trim();
  const areaName = areaNameByCode.get(areaCode);
  if (!brickName || !areaName) continue;
  const place = compileArabicPlace(brickName);
  if (!place) {
    refused += 1;
    if (refusedNames.length < 25) refusedNames.push(brickName);
    continue;
  }
  const existing = areasByName.get(place.arabic);
  if (existing) existing.add(areaName);
  else areasByName.set(place.arabic, new Set([areaName]));
}

// A NAME THAT ANOTHER ROW DISAMBIGUATES IS ITSELF AMBIGUOUS.
//
// The table tells two places of the same name apart by appending where the second one is:
// "المطريه" is Cairo East 1 and "المطريه الدقهلية" is Dakahlia 3. Read literally, the bare spelling
// then belongs to Cairo alone — so a candidate in Dakahlia writing "Matarya", which is all anybody
// writes, was being pre-filled into a Cairo seat with no sign that a second Matarya existed.
//
// So the bare name inherits the qualified one's area and the two are offered together, for the
// recruiter to pick between. Owner's decision, 2026-08-28: "show both and make the recruiter pick."
//
// The qualifier has to be a governorate, or set off by a dash — the two forms the table actually
// uses for this. Without that test the rule would also fire on names that merely START with another
// name and are somewhere else entirely: "ساحل سليم" in Assiut is not El Sahel in Cairo, and
// "دير مواس" in Minya is not El Deir in Qena.
const wordsOf = (name: string) =>
  name
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map((word) => word.replace(/^(?:ال|أل)/, "") || word);
const inherited: string[] = [];
for (const [longName, longAreas] of areasByName) {
  const longWords = wordsOf(longName);
  const hasDash = /[-–—]/.test(longName);
  for (const [shortName, shortAreas] of areasByName) {
    if (shortName === longName) continue;
    const shortWords = wordsOf(shortName);
    if (shortWords.length === 0 || shortWords.length >= longWords.length) continue;
    if (!shortWords.every((word, index) => longWords[index] === word)) continue;
    const extra = longWords.slice(shortWords.length);
    if (!hasDash && !extra.some((word) => GOVERNORATE_WORDS.has(word))) continue;
    const added = [...longAreas].filter((area) => !shortAreas.has(area));
    if (added.length === 0) continue;
    for (const area of added) shortAreas.add(area);
    inherited.push(`${shortName} += ${added.join(", ")}  (from "${longName}")`);
  }
}

const areaNames = [...new Set([...areasByName.values()].flatMap((set) => [...set]))].sort();
const areaIndex = new Map(areaNames.map((name, index) => [name, index]));
const entries = [...areasByName.entries()]
  .map(
    ([arabic, areas]) =>
      `${arabic}|${[...areas]
        .map((name) => areaIndex.get(name))
        .sort((a, b) => Number(a) - Number(b))
        .join(",")}`,
  )
  .sort();

const ambiguous = [...areasByName.values()].filter((set) => set.size > 1).length;

const file = `// GENERATED by scripts/generate-neighbourhood-index.ts — do not edit by hand.
//
// Egypt's neighbourhoods as this company records them: every active sales brick that names a place
// rather than a street, paired with the area that covers it. The names are Arabic because the brick
// table is Arabic; src/lib/geo/arabic-place-match.ts is what lets an English address find them.
//
// Generated ${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date())} from ${brickRows?.length ?? 0} active bricks:
// ${entries.length} usable names, ${refused} refused as street-level or too short to identify
// anywhere, ${ambiguous} of which reach more than one area and therefore narrow to a shortlist
// rather than to one seat.

/** Area names, exactly as \`areas.name\` spells them. */
export const NEIGHBOURHOOD_AREAS: readonly string[] = ${JSON.stringify(areaNames, null, 2)};

/**
 * One entry per neighbourhood: its Arabic name, then "|", then the areas covering it as indexes
 * into NEIGHBOURHOOD_AREAS. Packed as strings because this ships to the browser.
 */
export const NEIGHBOURHOOD_PLACES: readonly string[] = ${JSON.stringify(entries, null, 2)};
`;

const out = path.join(process.cwd(), "src/lib/geo/neighbourhood-index-generated.ts");
writeFileSync(out, file, "utf8");

console.log(`bricks read        : ${brickRows?.length ?? 0}`);
console.log(`usable names       : ${entries.length}`);
console.log(`refused            : ${refused}`);
console.log(`ambiguous (>1 area): ${ambiguous}`);
console.log(`areas covered      : ${areaNames.length}`);
console.log(`file bytes         : ${Buffer.byteLength(file, "utf8")}`);
console.log(`names widened because another row disambiguates them (${inherited.length}):`);
for (const line of inherited) console.log(`  ${line}`);
console.log(`\nrefused sample: ${refusedNames.join(" · ")}`);
