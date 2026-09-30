import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import {
  MATERIAL_PREFIX,
  SAMPLE_ITEMS_MAX,
  SAMPLE_MATERIALS,
  SAMPLE_QUANTITY_MAX,
  describeSamples,
  isSampleMaterial,
  narrowSamplesToLine,
  parseSamplesGiven,
  sampleItemLabel,
} from "../src/lib/phoenix-crm/samples.ts";
import {
  SAMPLE_MATERIALS as MOBILE_MATERIALS,
  SAMPLE_QUANTITY_MAX as MOBILE_QUANTITY_MAX,
} from "../mobile/src/lib/crm/samples.ts";

/**
 * Phoenix CRM — E2: free samples and promotional material.
 *
 * Owner, 2026-09-26, in his own words: "free medical samples, pens, block notes, giveaways."
 *
 * ## 🔴 The rule this file exists to pin: A RECORD, NEVER A STOCK MOVEMENT
 *
 * There is no balance, no allocation, no issued quantity and nothing that subtracts. It is the one
 * thing about this feature that would be easy and disastrous to "improve": the moment a number here
 * is treated as inventory, the rep has to be ISSUED a quantity before he can work, and any gap
 * between what he was issued and what he reports becomes an accusation — which is exactly what
 * Golden Rule #1 forbids the module from doing to him. So the sweep below reads the whole module for
 * the vocabulary of stock and finds none of it.
 *
 * ## And junk is DROPPED, never refused
 *
 * The same rule as the visit's outcome, for the same reason: the rep is at a door holding a photo he
 * cannot retake. Only `products`, the pharmacy name and the photo can refuse a visit, because those
 * ARE the visit.
 */

const MIGRATION = "supabase/migrations/20260926230000_phoenix_crm_visit_samples.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function sql(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

export function runPhoenixCrmSamplesTests(): void {
  // ── His list, and the phone's copy of it ──────────────────────────────────────────────────────
  {
    assert.deepEqual(SAMPLE_MATERIALS.map((entry) => entry.label), ["Pen", "Block note", "Giveaway"]);
    assert.deepEqual(
      MOBILE_MATERIALS.map((entry) => ({ ...entry })),
      SAMPLE_MATERIALS.map((entry) => ({ ...entry })),
      "the phone's materials are the same list, key for key and label for label",
    );
    assert.equal(MOBILE_QUANTITY_MAX, SAMPLE_QUANTITY_MAX);
    assert.equal(sampleItemLabel("material:pen"), "Pen");
    assert.equal(sampleItemLabel("Satoprazole 40mg"), "Satoprazole 40mg", "a sampled product reads as itself");
  }

  // ── 🔴 A RECORD, NEVER A STOCK MOVEMENT ───────────────────────────────────────────────────────
  //
  // Nothing in the module allocates, issues, subtracts or holds a balance. This is the assertion the
  // owner's intent lives in, and it is silent when broken: a stock table would compile, deploy, and
  // only show up as a rep being told he has none left.
  {
    for (const path of [
      "src/lib/phoenix-crm/samples.ts",
      "src/lib/phoenix-crm/server/visits.ts",
      "src/components/phoenix-crm/visits-tab.tsx",
      "src/components/phoenix-crm/visit-log-form.tsx",
    ]) {
      const code = source(path);
      assert.doesNotMatch(code, /\b(stock_balance|sampleBalance|samplesRemaining|allocat\w*Sample|issuedSamples)\b/i, `${path} keeps a sample balance`);
      assert.doesNotMatch(code, /samples?\w*\s*-=|-=\s*\w*samples?/i, `${path} subtracts from a sample count`);
    }
    // And the column says so itself, so the next person reading the schema is told before they build one.
    assert.match(sql(), /A RECORD, never a '\n?\s*'?stock movement/i, "the column comment states the rule");
  }

  // ── Dropped, never refused ────────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(parseSamplesGiven(null), {});
    assert.deepEqual(parseSamplesGiven([1, 2]), {}, "an array is not a bag of items");
    assert.deepEqual(parseSamplesGiven({ "material:pen": 3 }), { "material:pen": 3 });
    assert.deepEqual(parseSamplesGiven({ "material:pen": "3" }), { "material:pen": 3 }, "a phone that sent a string still counts");

    // A zero is the same as not saying it, so the key goes with it.
    assert.deepEqual(parseSamplesGiven({ "material:pen": 0, "material:giveaway": 2 }), { "material:giveaway": 2 });
    assert.deepEqual(parseSamplesGiven({ "material:pen": "many" }), {});
    assert.deepEqual(parseSamplesGiven({ "material:pen": -4 }), {});

    // Clamped, never refused: the cap is a column width, not a rule the rep broke.
    assert.deepEqual(parseSamplesGiven({ "material:pen": 500 }), { "material:pen": SAMPLE_QUANTITY_MAX });

    // 🔴 The reserved prefix. Without this a product one day called "Pen" becomes the pen count on
    // every manager's board, and nothing anywhere says so.
    assert.deepEqual(parseSamplesGiven({ "material:trolley": 2 }), {}, "an unknown material key is not a product");
    assert.equal(isSampleMaterial(`${MATERIAL_PREFIX}pen`), true);
    assert.equal(isSampleMaterial("Pen"), false, "a product named Pen is a product, never the material");

    const many = Object.fromEntries(Array.from({ length: SAMPLE_ITEMS_MAX + 9 }, (_, index) => [`Product ${index}`, 1]));
    assert.equal(Object.keys(parseSamplesGiven(many)).length, SAMPLE_ITEMS_MAX, "a bag of junk keys is cut, not refused");
  }

  // ── Narrowed to the line, exactly as the discussed products are ───────────────────────────────
  {
    const given = { "material:pen": 2, Satoprazole: 3, Retired: 1 };
    assert.deepEqual(narrowSamplesToLine(given, ["Satoprazole"]), { "material:pen": 2, Satoprazole: 3 });
    assert.deepEqual(narrowSamplesToLine(given, []), { "material:pen": 2 }, "a material is never a line product and always survives");
  }

  // ── What the card prints: the products first, then the materials in HIS order ─────────────────
  {
    const described = describeSamples({ "material:giveaway": 1, Zebra: 2, "material:pen": 4, Alpha: 1 });
    assert.deepEqual(
      described.map((item) => item.label),
      ["Alpha", "Zebra", "Pen", "Giveaway"],
      "sampled products alphabetically, then the materials in the owner's own order",
    );
    assert.deepEqual(describeSamples({}), [], "a visit that left nothing prints nothing");
  }

  // ── The column, and the function that fills it ────────────────────────────────────────────────
  {
    const text = sql();
    assert.match(
      text,
      /add column if not exists samples_given jsonb not null default '\{\}'::jsonb;/,
      "defaulted, so every visit already on file is correct with no backfill",
    );
    // A BYTE cap, not a key count: Postgres refuses a subquery in a CHECK constraint, so
    // `count(*) from jsonb_object_keys(...)` cannot live in one — staging said so on the first apply.
    // The key count is enforced twice in code instead: parseSamplesGiven cuts the bag, and the
    // function empties one that still arrives too big.
    assert.match(
      text,
      /constraint phoenix_crm_visits_samples_given\s+check \(jsonb_typeof\(samples_given\) = 'object' and char_length\(samples_given::text\) <= 2400\)/,
    );
    assert.doesNotMatch(text, /check \([^)]*select count\(\*\) from jsonb_object_keys/, "a CHECK constraint cannot hold a subquery");

    const start = text.indexOf("create or replace function public.phoenix_crm_save_visit(");
    assert.ok(start >= 0, "the migration re-creates phoenix_crm_save_visit");
    const body = text.slice(start);
    // 🔴 Dropped, not raised — a bag of junk keys must never cost a rep a visit he actually made.
    assert.match(
      body,
      /if jsonb_typeof\(v_samples\) <> 'object' or \(select count\(\*\) from jsonb_object_keys\(v_samples\)\) > 20 then\s+v_samples := '\{\}'::jsonb;\s+end if;/,
    );
    for (const raise of body.match(/raise exception '[^']+'/g) ?? []) {
      assert.doesNotMatch(raise, /sample/i, `${raise} refuses a visit over what he left behind`);
    }
  }

  // ── Wired end to end, both apps ───────────────────────────────────────────────────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(visits.includes("samples_given: narrowSamplesToLine(visit.samplesGiven, allowedProducts)"), "the save narrows to the line");
    assert.ok(visits.includes("samples: describeSamples(parseSamplesGiven(row.samples_given))"), "and the card reads it back ready to print");
    assert.ok(source("src/lib/phoenix-crm/entry-rules.ts").includes("samplesGiven: parseSamplesGiven(body.samplesGiven)"));

    // The web app's visit is two files since the one-tap rebuild (2026-09-29): the form that records
    // what he left (visit-log-form.tsx) and the day list that prints it back (visits-tab.tsx).
    const webFiles: readonly string[] = ["src/components/phoenix-crm/visit-log-form.tsx", "src/components/phoenix-crm/visits-tab.tsx"];
    const phoneFiles: readonly string[] = ["mobile/src/features/crm/visits-screen.tsx"];
    for (const [name, paths] of [["web", webFiles], ["phone", phoneFiles]] as const) {
      const code = paths.map((path) => source(path)).join("\n");
      assert.ok(code.includes("SAMPLE_MATERIALS"), `${name}: the three materials are offered`);
      assert.ok(code.includes("bumpSample"), `${name}: one button per item, each tap one more`);
      assert.ok(code.includes("samplesGiven: samples"), `${name}: and the payload carries them`);
      assert.ok(code.includes("Left behind:"), `${name}: the saved visit says what he left`);
      // Nothing on a rep's screen may read as a balance he has to account for.
      assert.doesNotMatch(code, /\b(remaining|in stock|balance left|you have \d)\b/i, `${name}: a sample count is not a balance`);
      assert.doesNotMatch(code, /\bflagg?ed\b/i, `${name}: the word "flagged" is not in a rep's app`);
    }
  }

  console.log("phoenix-crm samples: OK");
}
