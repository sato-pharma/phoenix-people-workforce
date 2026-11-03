import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  ambiguousPairsNotice,
  hiddenVendorNotice,
  NEW_VENDOR_NOTICE_DAYS,
  newVendorCutoffIso,
  SYNC_RETIRE_LIMIT,
  salesCodeSyncDetail,
  syncRetireRefusal,
} from "../src/lib/marketing-requests/sales-code-sync.ts";

export function runMarketingPharmacyCodeSyncJobTests() {
  const file = readdirSync("supabase/migrations").find((name) => name.endsWith("_marketing_pharmacy_sync_hides_new_vendors.sql"));
  assert.ok(file, "the migration that hides new vendors must exist");
  const migration = readFileSync(`supabase/migrations/${file}`, "utf8");

  // Owner, 2026-11-03: "Hidden until I allow it". This is the one value the migration changes.
  assert.match(
    migration,
    /sd\.distributor_name,\s*sd\.normalized_distributor_name,\s*sd\.distributor_name,\s*false\s*from sales_distributors sd/,
    "a vendor the sync creates must start hidden, by-hand runs included",
  );
  // Replacing the function wholesale is how a fix loses an earlier one.
  assert.match(
    migration,
    /delete from public\.marketing_pharmacy_code_references r\s*where r\.source_file = 'source_of_sales_customer_map'\s*and not exists[\s\S]*?c2\.normalized_pharmacy_code = r\.normalized_pharmacy_code[\s\S]*?dc\.reference_id = r\.id/,
    "the merge guard and the link guard must both survive the restatement",
  );
  assert.match(migration, /where c\.distributor_active\s*and not exists/, "still no insert under a hidden vendor");
  assert.match(migration, /set search_path = public/, "the function's SET clause must survive");
  assert.match(
    migration,
    /revoke execute on function public\.phx_sales_pharmacy_code_sync_preflight\(\) from public, anon, authenticated/,
    "the preflight is server-only",
  );

  // The refusal: a broken Sales import must never become a mass retirement at 02:47.
  assert.equal(syncRetireRefusal(0), null);
  assert.equal(syncRetireRefusal(SYNC_RETIRE_LIMIT), null, "the limit itself still runs");
  const refusal = syncRetireRefusal(SYNC_RETIRE_LIMIT + 1);
  assert.ok(refusal, "over the limit the run refuses");
  assert.match(refusal, /did not run/);

  // A healthy night reaches nobody.
  assert.equal(ambiguousPairsNotice(0), null);
  const vendor = hiddenVendorNotice("New Vendor");
  assert.match(vendor.message, /New Vendor/, "a new hidden vendor is named");
  assert.match(vendor.message, /Marketing Control, Vendors/, "and names the screen that allows it");
  assert.match(ambiguousPairsNotice(3)?.title ?? "", /ambiguous: 3/);

  // 🔴 The vendors hidden before this job existed are never announced as new: the newest was made on 2026-08-19.
  const firstRunCutoff = newVendorCutoffIso(Date.parse("2026-11-04T00:47:00Z"));
  assert.ok(firstRunCutoff > "2026-08-19T23:59:59Z", "the 12 vendors already hidden must fall outside the window");
  assert.equal(firstRunCutoff, new Date(Date.parse("2026-11-04T00:47:00Z") - NEW_VENDOR_NOTICE_DAYS * 86_400_000).toISOString());

  assert.match(
    salesCodeSyncDetail(
      {
        distributorsCreated: 0,
        referencesHeldHiddenVendor: 7,
        referencesRetainedLinked: 2,
        referencesRetired: 0,
        referencesSkippedExisting: 90,
        referencesSynced: 278,
      },
      0,
    ),
    /codes added 278/,
    "the heartbeat detail is the one place a run's counts are recorded",
  );

  // Order in the runner: the refusal is read before anything is written.
  const runner = readFileSync("src/lib/marketing-requests/sales-code-sync.ts", "utf8");
  // 🔴 A before-and-after loses the notice for good when a run times out but commits, or the send fails.
  // Reading by age with a per-vendor key means the next night still tells, and tells once.
  assert.doesNotMatch(runner, /hiddenBefore|hiddenAfter/, "the notice must not rest on a diff around one run");
  assert.match(runner, /\.gte\("created_at", newVendorCutoffIso\(\)\)/, "new means recently created");
  assert.match(runner, /tell\(hiddenVendorNotice\(vendor\.name\), `vendors:\$\{vendor\.id\}`, "\/admin\/marketing-requests\/control"\)/, "one notice per vendor id, opening the screen that allows it");
  assert.ok(
    runner.indexOf("if (refusal) throw") < runner.indexOf("await callSync()"),
    "the refusal must come before the sync, or it protects nothing",
  );
  assert.doesNotMatch(runner, /"email"/, "no outbound email");
}
