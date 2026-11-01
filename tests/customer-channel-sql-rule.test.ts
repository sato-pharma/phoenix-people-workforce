import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HOSPITAL_NAME_KEYWORDS,
  NEVER_STORE_KEYWORDS,
  STORE_NAME_KEYWORDS,
  STORE_NAME_PREFIXES,
  WAREHOUSE_RULE_DEFAULT_FROM_PERIOD,
  matchesTradePhrase,
} from "../src/lib/sales/customer-channel.ts";
import { customerChannelSqlRule } from "../src/lib/sales/customer-channel-sql-rule.ts";

/**
 * The database kept its own copy of "who is a warehouse" and it stopped at the six words, so the
 * owner's later rulings — the EPDA «م - » prefix above all — reached every screen except the ones
 * that ask SQL. Measured on production for 2026-08: 9 customers carrying the prefix and none of the
 * six words, 972,232.88 EGP, read as pharmacies on Channels by Rep and as warehouses everywhere
 * else.
 *
 * These assertions guard the JOIN between the two, which is the part with no type checking across
 * it: TypeScript builds a jsonb payload, SQL reads it by key name, and a key that only one side
 * knows about fails silently in the safe-looking direction — the customer simply stays a pharmacy.
 */

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/20261101195934_phx_sales_channels_by_rep_classifies_each_customer_once.sql", import.meta.url),
  "utf8",
);
const CHANNELS_BY_REP = readFileSync(
  new URL("../src/lib/sales/channels-by-rep.ts", import.meta.url),
  "utf8",
);
const CLOSING_COMPARISON = readFileSync(
  new URL("../src/lib/sales/monthly-closing-channel-comparison.ts", import.meta.url),
  "utf8",
);
/** The two closing grids, each moved onto the shared rule in its own migration. */
const CLOSING_MIGRATIONS = [
  "20260907180000_closing_channel_totals_on_the_shared_rule.sql",
  "20260907180500_closing_channel_breakdown_on_the_shared_rule.sql",
].map((file) => ({
  file,
  sql: readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"),
}));

export function runCustomerChannelSqlRuleTests() {
  const rule = customerChannelSqlRule();

  // 1. Every key TypeScript sends is a key SQL reads. A payload key the function never looks up is
  //    a list the owner edited that changes nothing at all.
  for (const key of Object.keys(rule)) {
    assert.ok(
      MIGRATION.includes(`'${key}'`),
      `phx_customer_channel must read '${key}' — a payload key SQL ignores is a silent no-op`,
    );
  }

  // 2. And every list actually carries the owner's rulings, rather than being an empty array that
  //    would make step 1 pass while classifying nothing.
  assert.equal(rule.storeStems.length, STORE_NAME_KEYWORDS.length, "the six store words travel");
  assert.equal(rule.storePrefixes.length, STORE_NAME_PREFIXES.length, "the prefixes travel");
  assert.equal(rule.hospitalStems.length, HOSPITAL_NAME_KEYWORDS.length, "the hospital words travel");
  assert.equal(rule.neverStoreStems.length, NEVER_STORE_KEYWORDS.length, "the never-store words travel");
  assert.ok(rule.tradeBusinessStems.length > 0 && rule.tradeGoodsStems.length > 0, "the trade phrase travels");
  assert.ok(rule.wholesaleOnlyDistributors.includes("QM"), "El Qema's whole book is wholesale");
  assert.equal(
    rule.ruleFromPeriodDefault,
    WAREHOUSE_RULE_DEFAULT_FROM_PERIOD,
    "the cutover date travels, or SQL answers with the pre-2026-09-06 rule forever",
  );
  assert.equal(
    rule.ruleFromPeriodByLine.pedia,
    "2026-08",
    "Pedia's earlier cutover travels — it is the one line whose August uses the new rule",
  );

  // 3. THE PREFIX IS ANCHORED. «م - » starts 29 customer names and appears somewhere inside 623.
  //    Compared as a substring it would turn 594 ordinary pharmacies into warehouses and scatter
  //    their sales across their cities, and the publication drift check could not see it, because
  //    the split preserves each line's unit total while moving units between areas.
  assert.ok(rule.storePrefixes.includes("م -"), "the EPDA notation is one of the prefixes");
  const prefixBranch = MIGRATION.slice(
    MIGRATION.indexOf("'storePrefixes'"),
    MIGRATION.indexOf("'storePrefixes'") + 220,
  );
  assert.ok(
    prefixBranch.includes("like s || '%'"),
    "the prefix branch must anchor at the start of the name",
  );
  assert.ok(
    !prefixBranch.includes("like '%' || s"),
    "the prefix branch must NOT compare as a substring — that is the 594-pharmacy mistake",
  );

  // 4. The six words, by contrast, ARE substrings — مخزن has to catch المخزن.
  const storeStemBranch = MIGRATION.slice(
    MIGRATION.indexOf("'storeStems'", MIGRATION.indexOf("if v_active then")),
    MIGRATION.indexOf("'storeStems'", MIGRATION.indexOf("if v_active then")) + 220,
  );
  assert.ok(
    storeStemBranch.includes("like '%' || s || '%'"),
    "the store words stay substring matches",
  );

  // 5. The wiring. A correct payload nobody sends changes nothing — the exact failure this whole
  //    change exists to repair, one layer up.
  assert.ok(
    CHANNELS_BY_REP.includes("p_rule: customerChannelSqlRule()"),
    "Channels by Rep must send the rule payload to the RPC",
  );
  assert.ok(
    CHANNELS_BY_REP.includes("p_store_stems: stems.store"),
    "and must keep sending the arrays, which the function falls back to during a deploy",
  );

  // 6. The closing grids ask the same one function, and both call sites send the payload. Three
  //    surfaces read this rule; a copy that drifts is the whole defect, in any of them.
  assert.equal(
    (CLOSING_COMPARISON.match(/p_rule: customerChannelSqlRule\(\)/g) ?? []).length,
    2,
    "both closing RPCs — totals and breakdown — must send the rule payload",
  );
  for (const { file, sql } of CLOSING_MIGRATIONS) {
    assert.ok(
      sql.includes("public.phx_customer_channel("),
      `${file} must delegate classification instead of carrying its own copy`,
    );

    //  THE THREE BUCKETS STAY ABOVE THE CLASSIFIER. They answer "we do not know who this is", and
    //  the classifier would call every one of them a pharmacy — quietly identifying money nobody
    //  has identified, in a grid the owner reconciles to the penny.
    const classifierAt = sql.indexOf("public.phx_customer_channel(");
    for (const bucket of ["direct_unnamed", "unidentified_no_code", "unidentified_no_name"]) {
      const bucketAt = sql.indexOf(`'${bucket}'`);
      assert.ok(bucketAt > -1 && bucketAt < classifierAt, `${file} must decide ${bucket} before the channel`);
    }
  }

  // 6. Naming the trade pair must not have changed what the phrase matches.
  assert.equal(
    matchesTradePhrase("شركة الهضبه لتوريد الادويه - الزقازيق"),
    true,
    "a supplier of medicines is still a warehouse",
  );
  assert.equal(
    matchesTradePhrase("الفاتح لتجارة وتوزيع"),
    true,
    "both business words together still qualify without naming the goods",
  );
  assert.equal(
    matchesTradePhrase("صيدلية مطلوب سجل تجارى"),
    false,
    "a paperwork note in the name field is still not a business",
  );
}
