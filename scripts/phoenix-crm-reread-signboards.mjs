#!/usr/bin/env node
// Re-read the signboard of every place that currently carries a signboard FLAG, with the reader in
// this working tree, and say what each one becomes.
//
//   node scripts/phoenix-crm-reread-signboards.mjs                  read and print. Writes NOTHING.
//   node scripts/phoenix-crm-reread-signboards.mjs --apply          also keep the new verdict on the place row
//   node scripts/phoenix-crm-reread-signboards.mjs --place <uuid>   one place (repeatable)
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
import { signboardHoldsForReview } from "@/lib/phoenix-crm/signboard-rules";

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
if (!process.env.OPENAI_API_KEY) {
  console.error("No OPENAI_API_KEY in .env.local: the reader would answer `unjudged` for every place.");
  process.exit(9);
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ONLY = argv.flatMap((arg, index) => (arg === "--place" ? [argv[index + 1]] : [])).filter(Boolean);
for (const arg of argv) {
  if (!["--apply", "--place"].includes(arg) && !ONLY.includes(arg)) {
    console.error(`Unknown flag ${arg} — refusing rather than guessing what was meant.`);
    process.exit(9);
  }
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: flags, error: flagError } = await db
    .from("phoenix_crm_location_integrity")
    .select("id, subject_id, flags, strong, created_at")
    .eq("source", "signboard")
    .eq("subject_kind", "place");
  if (flagError) throw new Error(`integrity board: ${flagError.message}`);

  const wanted = (flags ?? []).filter((flag) => ONLY.length === 0 || ONLY.includes(flag.subject_id));
  if (wanted.length === 0) {
    console.log("No signboard flags on the board — nothing to re-read.");
    return;
  }

  const { data: places, error: placeError } = await db
    .from("phoenix_crm_places")
    .select("id, photo_path, signboard_check, customer:phoenix_crm_customers!inner(name, list_type)")
    .in("id", wanted.map((flag) => flag.subject_id));
  if (placeError) throw new Error(`places: ${placeError.message}`);

  const byId = new Map((places ?? []).map((place) => [place.id, place]));
  console.log(`${wanted.length} flagged place(s); ${APPLY ? "WRITING the new verdict" : "DRY RUN — writing nothing"}.`);
  console.log("");

  const superseded = [];
  const notWritten = [];
  for (const flag of wanted) {
    const place = byId.get(flag.subject_id);
    if (!place) {
      console.log(`- ${flag.subject_id}: the place row is gone; flag ${flag.id} left exactly as it is.`);
      continue;
    }
    const customer = Array.isArray(place.customer) ? place.customer[0] : place.customer;
    const was = place.signboard_check ?? {};
    const check = await readStoredPlaceSignboard({
      customerName: String(customer?.name ?? ""),
      listType: String(customer?.list_type ?? ""),
      photoPath: String(place.photo_path ?? ""),
    });

    const stillHolds = signboardHoldsForReview(check);
    console.log(`- ${customer?.name ?? place.id} (${customer?.list_type ?? "?"})`);
    console.log(`    was: ${was.verdict ?? "—"}${was.reason ? ` / ${was.reason}` : ""}  ${JSON.stringify(was.signText ?? null)}`);
    console.log(`    now: ${check.verdict}${check.reason ? ` / ${check.reason}` : ""}  ${JSON.stringify(check.signText)}`);
    for (const sign of check.signs) {
      console.log(`         sign [${sign.legibility}/${sign.kind}] ${JSON.stringify(sign.text)} people=${JSON.stringify(sign.personNames)} places=${JSON.stringify(sign.placeNames)}`);
    }
    if (!stillHolds) {
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
