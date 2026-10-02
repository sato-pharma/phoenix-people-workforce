import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";

import {
  KPIS_A_PHARMACY_IS_NEVER_IN,
  PHARMACY_LIST_TYPE,
  PLANNABLE_LIST_TYPES,
  isPharmacyListType,
  isPlannableListType,
  parseListType,
  pharmacyCountsInKpi,
  visitApprovalKind,
  visitCountBucketForListType,
} from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";

/**
 * Phoenix CRM — a pharmacy call is a third list, never planned, never approved, never a KPI.
 *
 * Three of the owner's four rulings here REMOVE something, and a removal is what a later reader
 * restores by analogy: the off-plan approval machinery sits one file away and a pharmacy call is,
 * literally, a visit that is not on a plan. So each removal is pinned as its own assertion with the
 * owner's words beside it, and the parser is pinned because every existing reader of `list_type` is
 * a binary that would file a pharmacy under PM with nothing going red.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmPharmacyCallTests(): void {
  // ── 1. A third list, and a parser that cannot swallow it ──────────────────────────────────────
  {
    assert.equal(PHARMACY_LIST_TYPE, "Pharmacy", "the vendor's own spelling, so the import needs no translation");

    assert.equal(parseListType("AM"), "AM");
    assert.equal(parseListType("PM"), "PM");
    assert.equal(parseListType("Pharmacy"), "Pharmacy");

    // Anything unrecognised still reads PM, exactly as `row.list_type === "AM" ? "AM" : "PM"` did
    // before a third list existed — a row written by an older build means what it always meant.
    for (const odd of [null, undefined, "", "pm", "pharmacy", 7, {}]) {
      assert.equal(parseListType(odd), "PM", `${JSON.stringify(odd)} falls back to PM, never to Pharmacy`);
    }

    assert.ok(isPharmacyListType("Pharmacy"));
    assert.ok(!isPharmacyListType("PM"), "the one thing the fallback must never do");
    assert.ok(!isPharmacyListType("pharmacy"), "the stored spelling is exact; a near miss is not a pharmacy");
  }

  // ── 2. Never planned (owner, 2026-10-02: "He don't plan it. We don't want extra.") ────────────
  {
    assert.deepEqual([...PLANNABLE_LIST_TYPES], ["AM", "PM"], "a pharmacy is not offered on a weekly plan");
    assert.ok(isPlannableListType("AM"));
    assert.ok(isPlannableListType("PM"));
    assert.ok(!isPlannableListType("Pharmacy"), "the ruling that reverses the morning's 'planned like doctors'");

    // The cap he set that morning capped PLANNING. With no plan row there is nothing to cap, and a
    // cap on VISITS would be the "extra" he ruled out. Nothing here may grow one back.
    const rules = source("src/lib/phoenix-crm/pharmacy-call-rules.ts");
    assert.doesNotMatch(rules, /\b(cap|CAP|maxPerDay|perDayLimit)\b/, "no pharmacy cap, of any kind");
    assert.doesNotMatch(rules, /planItem|planRow|plan_items/, "and nothing here writes a plan row");
  }

  // ── 3. Never approved (owner, 2026-10-02: "no approval for an unplanned pharmacy visit") ──────
  {
    // A pharmacy is `none` whatever shape the visit is given — on a plan it cannot be on, off a plan
    // it was never on. This is the short-circuit that stops the off-plan machinery reaching it.
    assert.equal(visitApprovalKind({ listType: "Pharmacy" }), "none");
    assert.equal(visitApprovalKind({ listType: "Pharmacy", unplannedKind: "out_of_plan" }), "none");
    assert.equal(visitApprovalKind({ listType: "Pharmacy", unplannedKind: "out_of_list" }), "none");

    // A doctor keeps every bit of it: his manager then the SFE off-plan, the CUSTOMER's own
    // admission out of list, and nothing at all on an ordinary planned day.
    assert.equal(visitApprovalKind({ listType: "PM", unplannedKind: "out_of_plan" }), "manager_sfe");
    assert.equal(visitApprovalKind({ listType: "PM", unplannedKind: "out_of_list" }), "customer");
    assert.equal(visitApprovalKind({ listType: "PM", unplannedKind: null }), "none");
    assert.equal(visitApprovalKind({ listType: "AM", unplannedKind: "out_of_plan" }), "manager_sfe");
  }

  // ── 4. No KPI reads a pharmacy (owner, 2026-10-02: "no KPIs is counted on it") ────────────────
  {
    assert.deepEqual(
      [...KPIS_A_PHARMACY_IS_NEVER_IN],
      ["coverage", "frequency", "monthly_target", "call_rate", "capacity"],
      "named rather than counted, so a sixth measure is a decision and not an oversight",
    );
    for (const kpi of KPIS_A_PHARMACY_IS_NEVER_IN) {
      assert.equal(pharmacyCountsInKpi(kpi), false, `${kpi} never counts a pharmacy`);
    }
  }

  // ── 5. The AM · PM · Pharmacies golden rule, structurally ─────────────────────────────────────
  {
    assert.equal(visitCountBucketForListType("Pharmacy"), "Pharmacies");
    assert.equal(visitCountBucketForListType("AM"), "AM");
    assert.equal(visitCountBucketForListType("PM"), "PM");
    // The failure this rule exists to prevent: a pharmacy counted among the doctors.
    assert.notEqual(visitCountBucketForListType("Pharmacy"), "PM");
    assert.notEqual(visitCountBucketForListType("Pharmacy"), "AM");
  }

  // ── 6. The import: one widened predicate, and the clause deliberately left alone ─────────────
  {
    const migration = readFileSync(
      new URL("supabase/migrations/20261002150353_phoenix_crm_pharmacy_reference.sql", ROOT),
      "utf8",
    );
    const body = migration.split("as $$")[1] ?? "";
    assert.ok(body.length > 500, "the function body was not found — the rest of this block would prove nothing");

    // The whole import is the final join learning the third list.
    assert.match(body, /and a\.list_type in \('AM', 'PM', 'Pharmacy'\)/, "the reference join carries the rep's pharmacies");

    // And `with_list` must NOT learn it: that clause picks WHICH occupant owns the list, so widening
    // it lets a former occupant holding only pharmacies win `distinct on` over the person actually
    // sitting there. Measured on production: exactly ONE agent has pharmacies and no AM/PM list.
    const withList = body.split("with_list as (")[1]?.split("chosen as (")[0] ?? "";
    assert.ok(withList.length > 200, "with_list was not found — this assertion would pass vacuously");
    assert.match(withList, /and a\.list_type in \('AM', 'PM'\)/, "the occupant test stays on AM and PM");
    assert.doesNotMatch(withList, /'Pharmacy'/, "widening it would hand a seat's list to the wrong rep");
  }

  // ── 7. A wholesaler is filtered where the list is READ, and only for pharmacies ───────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /import \{ isCertainWholesalerVenue \} from "@\/lib\/venues\/wholesaler-venue-guard";/,
      "the guard is reused, never restated — it shares the monthly closing's own name primitives");
    assert.match(
      list,
      /rows\.filter\(\(row\) => !\(isPharmacyListType\(row\.list_type\) && isCertainWholesalerVenue\(row\.name\)\)\)/,
      "loadReference drops a certain wholesaler, and only from the PHARMACY rows",
    );

    // The SQL must not try to repeat it: a second copy of those name rules would drift from the first.
    const migration = readFileSync(
      new URL("supabase/migrations/20261002150353_phoenix_crm_pharmacy_reference.sql", ROOT),
      "utf8",
    );
    // The EXECUTABLE body only, with its `--` comments removed: prose about the guard is welcome
    // there, a second copy of its Arabic stems and keyword lists is what must never appear.
    const sqlBody = (migration.split("as $$")[1] ?? "")
      .split("$$;")[0]
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.ok(sqlBody.includes("crm_contact_assignments"), "the executable body was not isolated — the next assertions would pass vacuously");
    for (const word of ["مخزن", "جملة", "makhzan", "wholesal"]) {
      assert.ok(!sqlBody.includes(word), `the migration body must not restate the wholesaler rules (${word})`);
    }
  }

  // ── 8. The ratchet: 26 binary readers of `list_type`, and they may FALL, never rise ───────────
  {
    // Nothing else can catch these. Widening the `PhoenixCrmListType` union does not: every one of
    // them narrows to "AM" | "PM" and keeps compiling, so the typechecker stays green while an
    // imported pharmacy is filed among the doctors. Each is converted as its surface is given a
    // decision about whether it shows pharmacies at all; this only stops a NEW one appearing.
    const files = [...walkSource("src"), ...walkSource("app")];
    assert.ok(files.length > 1000, `only ${files.length} source files were scanned — the walk is not reaching the tree, so the count means nothing`);

    const pattern = /=== "AM" \? "AM" : "PM"/g;
    let occurrences = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const matches = stripComments(cachedReadFile(file)).match(pattern);
      if (!matches) continue;
      occurrences += matches.length;
      offenders.push(`${file.split(path.sep).join("/")} x${matches.length}`);
    }

    // Anti-vacuity: if the pattern stops matching, a count of zero would read as a clean sweep.
    assert.ok(offenders.length >= 10, `only ${offenders.length} files matched — the pattern has stopped matching, so a low count is meaningless`);

    assert.ok(
      occurrences <= 26,
      `binary list_type readers rose to ${occurrences} (baseline 26). A new \`=== "AM" ? "AM" : "PM"\` files a pharmacy among the doctors and nothing else will catch it — use parseListType and decide whether that surface shows pharmacies at all.\n  ${offenders.join("\n  ")}`,
    );
    if (occurrences < 26) {
      console.log(`  binary list_type readers fell to ${occurrences} — lower the baseline in this file to ${occurrences} so the ground cannot be given back.`);
    }
  }

  console.log("phoenix-crm pharmacy calls: OK");
}

/** The source tree, the way every other ratchet here walks it. */
function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of cachedReaddir(dir)) {
    const full = path.join(dir, entry);
    if (cachedIsDirectory(full)) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walkSource(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}
