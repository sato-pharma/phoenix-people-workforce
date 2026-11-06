#!/usr/bin/env node
// Re-read the signboard of every place that currently carries a signboard FLAG — or of the places
// named with `--place`, flagged or not — with the reader in this working tree, and say what each
// one becomes.
//
//   node scripts/phoenix-crm-reread-signboards.mjs                  read and print. Writes NOTHING.
//   node scripts/phoenix-crm-reread-signboards.mjs --apply          also keep the new verdict on the place row
//   node scripts/phoenix-crm-reread-signboards.mjs --place <uuid>   one place (repeatable), flagged
//                                                                  or not — see the note in main()
//   node scripts/phoenix-crm-reread-signboards.mjs --unreadable [--limit N] [--apply] [--out file.json]
//        every place filed "Not readable", lost or never read: ONE read each, ever
//        (`rereadUnreadablePlacesOnce`). Without --apply it reads and writes nothing; with it each place
//        is confirmed, filed with another name, or sent back to its rep for a new photo. Prints a
//        per-rep and a per-cause table; --out keeps every row as JSON. With --place <uuid> (repeatable)
//        or --places-file <ids.json> it reads exactly those places again, already-read or not.
//   node scripts/phoenix-crm-reread-signboards.mjs --rejudge [--apply] [--out file.json]
//        every stored reading judged again under today's rules, with NO model call
//        (`rejudgeStoredSignboardsOnce`, the owner's rulings of 2026-10-18): a place whose stored plate
//        now names the customer is confirmed, and a PM confirm whose photo holds no nameplate is sent
//        back for one. Prints the board cases the confirms supersede, and never settles one.
//
// WHY IT EXISTS. The nightly pass does not re-read a place it has already HELD — `loadBacklog` takes
// rows whose `signboard_check` is null or `unjudged` with a retryable reason, and a held place is
// neither. That is deliberate (a held place is waiting for a person, not for another model call), but
// it means a reader that was wrong leaves its flags on the integrity board for ever. This is the one
// thing that can correct them.
//
// 🔴 IT NEVER CLEARS A FLAG. The flag rows on `phoenix_crm_location_integrity` are what the owner
// adjudicates, and taking one off his board is his decision, not a script's — so this prints which
// flags its new verdicts have SUPERSEDED, with their row ids, and stops there. `--apply` writes the
// verdict to `phoenix_crm_places.signboard_check` and nothing else.
//
// 🔴 IT COSTS MODEL CALLS AT THE SWEEP TIER: the strong model, and a second cropped look at any place
// it does not match. Five places is ten calls at most. It is not something to run in a loop.
//
// Run it through the alias loader so it imports the live modules rather than copying them:
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//        --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-reread-signboards.mjs

import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { readStoredPlaceSignboard, recordPlaceSignboard } from "@/lib/phoenix-crm/server/signboard-check";
import { rejudgeStoredSignboardsOnce, rereadUnreadablePlacesOnce } from "@/lib/phoenix-crm/server/signboard-sweep";
import { signboardHoldsForReview, signboardNextAttempt, signboardReadsRecorded } from "@/lib/phoenix-crm/signboard-rules";
import { fetchAllRows } from "@/lib/supabase/paginated";

// ── env ──────────────────────────────────────────────────────────────────────────────────────────
// By hand, for the reason `cv-area-questions.mjs` records: this has to run from a bare worktree where
// `pnpm exec` is banned and dotenv may not resolve.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("No Supabase credentials in .env.local — nothing read, nothing written.");
  process.exit(9);
}
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const UNREADABLE = argv.includes("--unreadable");
const REJUDGE = argv.includes("--rejudge");
// The re-judge reads no photo, so it needs no key.
if (!REJUDGE && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY_2 && !process.env.OPENAI_API_KEY) {
  console.error("No ANTHROPIC_API_KEY, ANTHROPIC_API_KEY_2 or OPENAI_API_KEY in .env.local: the reader would answer `unjudged` for every place.");
  process.exit(9);
}
const valueOf = (flag) => argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1]] : [])).filter(Boolean);
const ONLY = valueOf("--place");
const LIMIT_RAW = valueOf("--limit")[0] ?? null;
const OUT = valueOf("--out")[0] ?? null;
const CONCURRENCY_RAW = valueOf("--concurrency")[0] ?? null;
const VALUES = [...ONLY, LIMIT_RAW, OUT, CONCURRENCY_RAW, ...valueOf("--places-file")].filter(Boolean);
for (const arg of argv) {
  if (!["--apply", "--place", "--places-file", "--unreadable", "--rejudge", "--limit", "--out", "--concurrency"].includes(arg) && !VALUES.includes(arg)) {
    console.error(`Unknown flag ${arg} — refusing rather than guessing what was meant.`);
    process.exit(9);
  }
}
const LIMIT = LIMIT_RAW === null ? null : Number(LIMIT_RAW);
const CONCURRENCY = CONCURRENCY_RAW === null ? null : Number(CONCURRENCY_RAW);
if ((LIMIT !== null && !(Number.isInteger(LIMIT) && LIMIT > 0)) || (CONCURRENCY !== null && !(Number.isInteger(CONCURRENCY) && CONCURRENCY > 0))) {
  console.error("--limit and --concurrency take a whole number above 0.");
  process.exit(9);
}
// With --unreadable, --place names the places to read again ON PURPOSE, already-read or not — the one
// way this pass reads a photo twice (`loadUnreadableBacklog`). A confirmed or flagged place is never read.
const PLACE_IDS_FILE = valueOf("--places-file")[0] ?? null;
if (PLACE_IDS_FILE && !UNREADABLE) {
  console.error("--places-file goes with --unreadable.");
  process.exit(9);
}
if (REJUDGE && (UNREADABLE || ONLY.length > 0 || PLACE_IDS_FILE || LIMIT_RAW || CONCURRENCY_RAW)) {
  console.error("--rejudge takes only --apply and --out: it judges every stored reading, and reads no photo.");
  process.exit(9);
}
const NAMED = [...ONLY, ...(PLACE_IDS_FILE ? JSON.parse(fs.readFileSync(path.resolve(PLACE_IDS_FILE), "utf8")) : [])];

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const OUTCOME_WORDS = {
  confirm: "confirmed",
  flag: "another name, filed on the board",
  retake: "sent back for a new photo",
  keep: "kept as read",
  lost: "no answer, left as it was",
};
const PROBLEM_WORDS = {
  none: "legible",
  no_plate: "no nameplate in the photo",
  building_sign_only: "only a building's sign",
  too_far: "too far away",
  blurred: "blurred",
  dark_or_glare: "dark or glare",
  cut_off: "cut off",
  stylised: "lettering cannot be read",
  sideways: "on its side",
};

/** Rep names by HR id — the tables name people, never codes. */
async function repNames(hrIds) {
  const ids = [...new Set(hrIds.filter(Boolean))];
  const names = new Map();
  for (let from = 0; from < ids.length; from += 200) {
    const { data, error } = await db.from("employees").select("hr_id, full_name").in("hr_id", ids.slice(from, from + 200));
    if (error) throw new Error(`employees: ${error.message}`);
    for (const row of data ?? []) names.set(row.hr_id, row.full_name);
  }
  return names;
}

function table(title, groups, columns) {
  console.log(title);
  const widest = Math.max(...groups.map((group) => group.label.length), 4);
  console.log(`  ${"".padEnd(widest)}  ${columns.map((column) => column.title.padStart(9)).join(" ")}`);
  for (const group of groups) {
    console.log(`  ${group.label.padEnd(widest)}  ${columns.map((column) => String(column.count(group.rows)).padStart(9)).join(" ")}`);
  }
  console.log("");
}

/**
 * Every place filed "Not readable", lost or never read — ONE read each, ever (owner, 2026-10-18). A dry
 * run still READS, so it is kept small with --limit; the photos it read are read again by the --apply
 * run, which is the one that writes.
 */
async function runUnreadable() {
  console.log(
    `Every "Not readable" place, read once — ${APPLY ? "WRITING what each photo shows" : "DRY RUN, reading and writing nothing"}` +
      `${LIMIT ? `, the first ${LIMIT}` : ""}.`,
  );
  let seen = 0;
  const { rows, skipped } = await rereadUnreadablePlacesOnce({
    apply: APPLY,
    concurrency: CONCURRENCY ?? undefined,
    limit: LIMIT ?? undefined,
    placeIds: NAMED.length > 0 ? NAMED : undefined,
    onRow: () => {
      seen += 1;
      if (seen % 25 === 0) console.log(`  ${seen} read so far`);
    },
  });
  if (skipped) {
    console.error("No AI key here, so nothing was read.");
    process.exitCode = 9;
    return;
  }
  const names = await repNames(rows.map((row) => row.repHrId));
  const repOf = (row) => names.get(row.repHrId) ?? "Rep not on the HR list";
  console.log("");
  for (const row of rows) {
    const problem = row.problem && row.problem !== "none" ? ` · ${PROBLEM_WORDS[row.problem] ?? row.problem}` : "";
    const wrote = !APPLY || row.outcome === "lost" ? "" : row.written ? " · written" : " · 🔴 NOT WRITTEN";
    const approved = row.approved === null ? "" : row.approved ? " · hold approved by the system" : " · 🔴 hold NOT approved";
    console.log(`- ${row.customerName} (${row.listType}) · ${repOf(row)} · ${OUTCOME_WORDS[row.outcome]}${problem}${row.held ? " · was held" : ""}${wrote}${approved}`);
  }
  console.log("");

  const outcomes = ["confirm", "flag", "retake", "keep", "lost"];
  const columns = [
    { title: "places", count: (group) => group.length },
    ...outcomes.map((outcome) => ({ title: outcome === "retake" ? "sent back" : outcome === "confirm" ? "confirmed" : outcome === "flag" ? "other name" : outcome === "keep" ? "kept" : "no answer", count: (group) => group.filter((row) => row.outcome === outcome).length })),
  ];
  const byRep = new Map();
  for (const row of rows) byRep.set(repOf(row), [...(byRep.get(repOf(row)) ?? []), row]);
  table(
    "By rep",
    [...byRep.entries()].map(([label, group]) => ({ label, rows: group })).sort((a, b) => b.rows.length - a.rows.length),
    columns,
  );
  const byCause = new Map();
  for (const row of rows) {
    const label = row.problem ? PROBLEM_WORDS[row.problem] ?? row.problem : "no cause given";
    byCause.set(label, [...(byCause.get(label) ?? []), row]);
  }
  table(
    "By what the photo shows",
    [...byCause.entries()].map(([label, group]) => ({ label, rows: group })).sort((a, b) => b.rows.length - a.rows.length),
    columns,
  );
  table("All", [{ label: "all", rows }], columns);

  if (OUT) {
    fs.writeFileSync(path.resolve(OUT), `${JSON.stringify(rows.map((row) => ({ ...row, repName: repOf(row) })), null, 2)}\n`);
    console.log(`Every row kept in ${path.resolve(OUT)}`);
  }
  const notWritten = APPLY ? rows.filter((row) => row.outcome !== "lost" && row.written !== true) : [];
  const notApproved = rows.filter((row) => row.approved === false);
  if (notWritten.length > 0 || notApproved.length > 0) {
    console.log(`🔴 ${notWritten.length} write(s) and ${notApproved.length} approval(s) did NOT land — see the rows marked above.`);
    // Non-zero, so a backgrounded run's notification carries the failure on its own.
    process.exitCode = 1;
  }
}

/**
 * Every stored reading judged again under the owner's rulings of 2026-10-18 — no photo read, no model
 * call. 🔴 It never settles a case on the board: the confirms' open signboard cases are printed, and
 * closing one is the owner's click.
 */
async function runRejudge() {
  console.log(`Every stored signboard reading, judged again — ${APPLY ? "WRITING the changes" : "DRY RUN, writing nothing"}.`);
  const { scanned, rows, openCases } = await rejudgeStoredSignboardsOnce({ apply: APPLY });
  const names = await repNames(rows.map((row) => row.repHrId));
  const repOf = (row) => names.get(row.repHrId) ?? "Rep not on the HR list";
  console.log(`${scanned} stored reading(s) judged; ${rows.length} change.`);
  console.log("");
  for (const row of rows) {
    const becomes = row.outcome === "confirm" ? "confirmed" : "sent back for a nameplate";
    const wrote = !APPLY ? "" : row.written ? " · written" : " · 🔴 NOT WRITTEN";
    const approved = row.approved === null ? "" : row.approved ? " · hold approved by the system" : " · 🔴 hold NOT approved";
    console.log(`- ${row.customerName} (${row.listType}) · ${repOf(row)} · was ${row.before} · ${becomes}${row.held ? " · was held" : ""}${wrote}${approved}`);
    console.log(`    sign: ${JSON.stringify(row.signText)}`);
  }
  console.log("");
  if (OUT) {
    fs.writeFileSync(path.resolve(OUT), `${JSON.stringify({ openCases, rows: rows.map((row) => ({ ...row, repName: repOf(row) })), scanned }, null, 2)}
`);
    console.log(`Every row kept in ${path.resolve(OUT)}`);
  }
  if (openCases.length === 0) {
    console.log("No open signboard case on the board belongs to a place confirmed here.");
  } else {
    const byPlace = new Map(rows.map((row) => [row.placeId, row]));
    console.log(`${openCases.length} open signboard case(s) the confirms no longer support — NOT settled by this script:`);
    for (const entry of openCases) {
      console.log(`  ${byPlace.get(entry.placeId)?.customerName ?? entry.placeId}  case=${entry.caseId}  flags=${entry.flags.join(",")}`);
    }
    console.log("Settling a case on the integrity board is the owner's decision, so it stops here.");
  }
  const notWritten = APPLY ? rows.filter((row) => row.written !== true) : [];
  const notApproved = rows.filter((row) => row.approved === false);
  if (notWritten.length > 0 || notApproved.length > 0) {
    console.log(`🔴 ${notWritten.length} write(s) and ${notApproved.length} approval(s) did NOT land — see the rows marked above.`);
    process.exitCode = 1;
  }
}

async function main() {
  if (REJUDGE) {
    await runRejudge();
    return;
  }
  if (UNREADABLE) {
    await runUnreadable();
    return;
  }
  // Paged: one read of the board stops silently at 1,000 rows and would leave the flags past them un-re-read.
  const flags = await fetchAllRows(
    () =>
      db
        .from("phoenix_crm_location_integrity")
        .select("id, subject_id, flags, strong, created_at")
        .eq("source", "signboard")
        .eq("subject_kind", "place"),
    "id",
  ).catch((error) => {
    throw new Error(`integrity board: ${error.message}`);
  });

  // 🔴 A NAMED PLACE IS RE-READ WHETHER OR NOT IT CARRIES A FLAG. The board is the right DEFAULT
  // scope, but it is not the set of places a wrong reader has damaged: a verdict of `match` raises
  // no flag at all, and `other_name` raises one only where the detector met the place in a visit.
  // Measured 2026-10-12, when the compound-name fix (#5756) moved six places: only ONE of the six
  // was on the board, so five were unreachable by the one tool that can correct them — among them
  // a false `match`, which no automatic path re-reads either, the nightly taking only the reasons
  // in `SIGNBOARD_REREAD_REASONS`. So `--place <uuid>` now means "re-read THIS place", and only a
  // run with no `--place` is board-driven.
  const onBoard = (flags ?? []).filter((flag) => ONLY.length === 0 || ONLY.includes(flag.subject_id));
  const flagByPlace = new Map(onBoard.map((flag) => [flag.subject_id, flag]));
  const wanted =
    ONLY.length > 0
      ? [...new Set(ONLY)].map((placeId) => ({ placeId, flag: flagByPlace.get(placeId) ?? null }))
      : onBoard.map((flag) => ({ placeId: flag.subject_id, flag }));
  if (wanted.length === 0) {
    console.log("No signboard flags on the board — nothing to re-read.");
    return;
  }

  // Chunked at 200, as repNames is: a long `in.()` list answers ZERO rows and no error.
  const places = [];
  const wantedIds = wanted.map((entry) => entry.placeId);
  for (let from = 0; from < wantedIds.length; from += 200) {
    const { data, error: placeError } = await db
      .from("phoenix_crm_places")
      .select("id, photo_path, signboard_check, customer:phoenix_crm_customers!inner(name, list_type)")
      .in("id", wantedIds.slice(from, from + 200));
    if (placeError) throw new Error(`places: ${placeError.message}`);
    places.push(...(data ?? []));
  }

  const byId = new Map(places.map((place) => [place.id, place]));
  const offBoard = wanted.filter((entry) => !entry.flag).length;
  console.log(
    `${wanted.length} place(s) to re-read — ${wanted.length - offBoard} carrying a flag, ${offBoard} with no flag on the board; ` +
      `${APPLY ? "WRITING the new verdict" : "DRY RUN — writing nothing"}.`,
  );
  console.log("");

  const superseded = [];
  const notWritten = [];
  for (const entry of wanted) {
    const flag = entry.flag;
    const place = byId.get(entry.placeId);
    if (!place) {
      console.log(
        `- ${entry.placeId}: the place row is gone; ${flag ? `flag ${flag.id} left exactly as it is.` : "it carries no flag either."}`,
      );
      continue;
    }
    const customer = Array.isArray(place.customer) ? place.customer[0] : place.customer;
    const was = place.signboard_check ?? {};
    // 🔴 The count is CARRIED, never reset to 1 (2026-10-18): a reset handed every re-read place a fresh
    // set of night reads of a photograph that had not changed.
    const check = signboardNextAttempt(
      await readStoredPlaceSignboard({
        customerName: String(customer?.name ?? ""),
        listType: String(customer?.list_type ?? ""),
        photoPath: String(place.photo_path ?? ""),
      }),
      signboardReadsRecorded(place.signboard_check),
    );

    const stillHolds = signboardHoldsForReview(check);
    console.log(`- ${customer?.name ?? place.id} (${customer?.list_type ?? "?"})`);
    console.log(`    was: ${was.verdict ?? "—"}${was.reason ? ` / ${was.reason}` : ""}  ${JSON.stringify(was.signText ?? null)}`);
    console.log(`    now: ${check.verdict}${check.reason ? ` / ${check.reason}` : ""}  ${JSON.stringify(check.signText)}`);
    for (const sign of check.signs) {
      console.log(`         sign [${sign.legibility}/${sign.kind}] ${JSON.stringify(sign.text)} people=${JSON.stringify(sign.personNames)} places=${JSON.stringify(sign.placeNames)}`);
    }
    if (!flag) {
      console.log(
        `    -> no flag on the board for this place; the new verdict ${stillHolds ? "HOLDS it for review" : "does not hold it"}`,
      );
    } else if (!stillHolds) {
      superseded.push({ customer: customer?.name ?? place.id, flagId: flag.id, placeId: place.id, verdict: check.verdict });
      console.log(`    -> this flag is SUPERSEDED (${check.verdict} does not hold a place)`);
    } else {
      console.log("    -> still held");
    }
    if (APPLY) {
      // 🔴 THE ROW IS READ BACK. `recordPlaceSignboard` swallows its error by design, so "written"
      // used to be a claim about a call, not about a row — and on 2026-10-09 it printed for all five
      // places while اسلام عبدالعال still held its old verdict. A write this script cannot prove is
      // reported as a FAILURE, with the stored verdict beside the one it meant to store.
      const accepted = await recordPlaceSignboard(place.id, check);
      const { data: after, error: afterError } = await db
        .from("phoenix_crm_places")
        .select("signboard_check")
        .eq("id", place.id)
        .maybeSingle();
      const stored = after?.signboard_check ?? null;
      const proven =
        accepted &&
        !afterError &&
        stored?.verdict === check.verdict &&
        (stored?.reason ?? null) === (check.reason ?? null) &&
        (stored?.signText ?? null) === (check.signText ?? null);
      if (proven) {
        console.log(`    WRITTEN and read back: ${stored.verdict}${stored.reason ? ` / ${stored.reason}` : ""}`);
      } else {
        notWritten.push({ customer: customer?.name ?? place.id, placeId: place.id, stored: stored?.verdict ?? null, wanted: check.verdict });
        console.log(
          `    🔴 NOT WRITTEN — the row still reads ${JSON.stringify(stored?.verdict ?? null)}${
            afterError ? ` (read back failed: ${afterError.message})` : ""
          }`,
        );
      }
    }
    console.log("");
  }

  if (notWritten.length > 0) {
    console.log(`${notWritten.length} place(s) the write did NOT reach — the verdict printed above is NOT what the row holds:`);
    for (const row of notWritten) {
      console.log(`  ${row.customer}  place=${row.placeId}  wanted=${row.wanted}  still=${JSON.stringify(row.stored)}`);
    }
    console.log("");
    // Non-zero, so a backgrounded run's notification carries the failure on its own.
    process.exitCode = 1;
  }

  if (superseded.length === 0) {
    console.log("Every flag still holds on the new reading. Nothing on the board is stale.");
    return;
  }
  console.log(`${superseded.length} flag(s) the new reading no longer supports — NOT cleared by this script:`);
  for (const row of superseded) {
    console.log(`  ${row.customer}  flag=${row.flagId}  place=${row.placeId}  now=${row.verdict}`);
  }
  console.log("");
  console.log("Taking a flag off the integrity board is the owner's decision, so it stops here.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
