import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  customerMergeRefusal,
  evidenceCanCarry,
  sameNameGroups,
  type MarketingCustomerMergeOption,
} from "../src/lib/marketing-requests/customer-merge-rules.ts";
import { buildVendorControlRows } from "../src/lib/marketing-requests/vendor-control.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

const VENDOR_SQL = readFileSync("supabase/migrations/20261103090000_marketing_vendor_control.sql", "utf8");
const MERGE_TABLE_SQL = readFileSync("supabase/migrations/20261103090100_marketing_customer_merge.sql", "utf8");
// The function as it stands now; the newest file that replaces it.
const MERGE_SQL = readFileSync("supabase/migrations/20261103090200_marketing_customer_merge_shared_links.sql", "utf8");

function customer(overrides: Partial<MarketingCustomerMergeOption> & { id: string }): MarketingCustomerMergeOption {
  return {
    areaName: "Giza",
    code: `C-${overrides.id}`,
    contacts: 0,
    customerType: "doctor",
    evidenceComplete: false,
    evidenceStatus: "missing",
    lineName: "CNS",
    links: 0,
    liveTransfer: false,
    name: "Dr One",
    normalizedName: "dr one",
    ownerName: null,
    requests: 0,
    validationStatus: "pending",
    ...overrides,
  };
}

export function runMarketingVendorAndCustomerMergeTests() {
  // ─── The vendors ───────────────────────────────────────────────────
  const rows = buildVendorControlRows(
    [
      { active: false, display_name: "Ibn Sina-Sato", id: 25, merged_into_distributor_id: 17 },
      { active: true, display_name: "Ibn sina", id: 17, merged_into_distributor_id: null },
      { active: false, display_name: "Chimipharm", id: 13, merged_into_distributor_id: null },
    ],
    [{ codes_loaded: "9", codes_waiting: "5520", customers_linked: 3, vendor_id: "25" }],
  );
  assert.deepEqual(rows.map((row) => row.name), ["Ibn sina", "Chimipharm", "Ibn Sina-Sato"], "shown vendors first, then by name");
  assert.equal(rows[2].mergedIntoName, "Ibn sina", "a merged vendor names where it went");
  assert.equal(rows[2].codesWaiting, 5520);
  assert.equal(rows[1].codesWaiting, 0, "no count row is zero, and the read itself throws when it fails");

  const vendorService = readFileSync("src/lib/marketing-requests/vendor-control.ts", "utf8");
  assert.match(vendorService, /access\.role !== "Super Admin"/, "Super Admin only, at the server");
  assert.match(vendorService, /assertRealSessionForDecision\(access, "allow or hide a vendor"\)/);
  assert.match(vendorService, /await writeRequiredAuditLog\(/);
  assert.match(vendorService, /if \(linked > 0\) \{\s+throw conflictError/, "a vendor with customers live on it cannot be hidden: its links would read Unknown distributor");
  assert.match(vendorService, /input\.active && vendor\.merged_into_distributor_id !== null/, "allowing a merged vendor would load its codes back");
  assert.match(VENDOR_SQL, /merged_into_distributor_id is null\s+or \(merged_into_distributor_id <> id and active = false\)/, "and the database refuses it too");
  assert.match(VENDOR_SQL, /\('ibn sina-sato', 'ibn sina'\)/, "backfilled by name: ids differ between staging and production");
  assert.match(VENDOR_SQL, /\('epda-pharmacies', 'epda'\)/);
  assert.match(VENDOR_SQL, /revoke all on function public\.phx_marketing_vendor_code_counts\(\) from public, anon, authenticated/);

  // ─── The customer merge: what the screen says ──────────────────────
  const groups = sameNameGroups([customer({ id: "a" }), customer({ id: "b" }), customer({ id: "c", normalizedName: "dr two" })]);
  assert.deepEqual(groups.map((group) => group.map((row) => row.id)), [["a", "b"]]);
  assert.equal(customerMergeRefusal(customer({ id: "a" }), customer({ id: "b" })), null);
  assert.match(customerMergeRefusal(customer({ id: "a" }), customer({ id: "a" })) ?? "", /itself/);
  assert.match(customerMergeRefusal(customer({ id: "a" }), customer({ id: "b", lineName: "Pedia" })) ?? "", /different lines/);
  assert.match(customerMergeRefusal(customer({ id: "a", validationStatus: "rejected" }), customer({ id: "b" })) ?? "", /was rejected/, "a rejected customer cannot be the one that stays");
  assert.equal(customerMergeRefusal(customer({ id: "a" }), customer({ id: "b", validationStatus: "rejected" })), null, "a rejected row can be the one retired");
  assert.match(customerMergeRefusal(customer({ id: "a" }), customer({ customerType: "clinic", id: "b" })) ?? "", /different kinds/);
  assert.match(customerMergeRefusal(customer({ id: "a" }), customer({ areaName: "Cairo", id: "b" })) ?? "", /different areas/);
  assert.match(customerMergeRefusal(customer({ id: "a", liveTransfer: true }), customer({ id: "b", liveTransfer: true })) ?? "", /live Direct Orders transfer/);
  assert.equal(customerMergeRefusal(customer({ id: "a", liveTransfer: true }), customer({ id: "b" })), null, "one live transfer can move");
  assert.equal(evidenceCanCarry(customer({ id: "a" }), customer({ evidenceComplete: true, evidenceStatus: "complete", id: "b" })), true);
  assert.equal(evidenceCanCarry(customer({ evidenceStatus: "complete", id: "a" }), customer({ evidenceComplete: true, id: "b" })), false, "never over complete evidence");
  assert.equal(evidenceCanCarry(customer({ id: "a" }), customer({ id: "b" })), false, "never from incomplete evidence");

  // ─── The customer merge: what the database refuses ─────────────────
  for (const [refusal, why] of [
    [/raise exception 'A customer cannot be merged into itself\.'/, "into itself"],
    [/raise exception 'A merge needs a written reason/, "a reason is required"],
    [/s\.line_id is distinct from r\.line_id/, "different line"],
    [/s\.customer_type is distinct from r\.customer_type/, "different kind"],
    [/s\.area_id is distinct from r\.area_id/, "different area"],
    [/Both customers have a live Direct Orders transfer/, "two live transfers"],
    [/r\.merged_into_customer_id is not null/, "already merged"],
    [/if not r\.active then raise/, "already inactive"],
    [/Evidence can be carried only from complete evidence/, "evidence guard"],
  ] as const) {
    assert.match(MERGE_SQL, refusal, why);
  }
  assert.match(MERGE_SQL, /if s\.validation_status = 'rejected' then\s+raise exception/, "a rejected survivor is refused in the database too");
  assert.match(MERGE_SQL, /array_position\(array\['pending', 'system_validated', 'sfe_validated', 'admin_approved'\], gone\.validation_status\)\s+> array_position\(/, "a shared link's standing carries upward, and a rejection has no rank so it neither carries nor is overwritten");
  assert.match(MERGE_SQL, /nullif\(btrim\(pairs\.gone_notes\), ''\)/, "the notes that say where the standing came from come with it");
  assert.match(MERGE_SQL, /set active = false, updated_at = now\(\), updated_by_hr_id = p_actor_hr_id\s+where customer_id = p_retired_id and active/, "a retired row's left-behind link is switched off");
  assert.match(MERGE_SQL, /'linksSwitchedOff', to_jsonb\(v_links_switched_off\)/, "and the record of the merge lists it");
  assert.match(MERGE_SQL, /'linksReactivated', to_jsonb\(v_links_reactivated\)/, "the record lists which links were switched back on, by id");
  assert.match(MERGE_SQL, /order by id for update/, "both rows locked in a fixed order");
  assert.match(MERGE_SQL, /update marketing_requests set customer_id = p_survivor_id where customer_id = p_retired_id returning id/, "only customer_id moves on a request");
  assert.doesNotMatch(MERGE_SQL, /update marketing_requests[^;]*(estimated_cost|actual_cost|updated_at|status)[^;]*;/, "a request's cost, status and dates are never touched");
  assert.match(MERGE_SQL, /validated_at = case when v_validation_carried is not null then now\(\)/, "stamped now, never backdated");
  assert.match(MERGE_SQL, /s\.validation_status in \('pending', 'system_validated'\) and r\.validation_status = 'sfe_validated'/, "upward only, and never over a rejection");
  assert.match(MERGE_SQL, /revoke all on function public\.phx_merge_marketing_customers\(uuid, uuid, text, text, boolean\) from public, anon, authenticated/);
  assert.match(MERGE_TABLE_SQL, /revoke all on public\.marketing_customer_merges from public, anon, authenticated/);

  // ─── The service, the route and the screen ─────────────────────────
  const service = readFileSync("src/lib/marketing-requests/customer-merge.ts", "utf8");
  assert.match(service, /access\.role !== "Super Admin"/, "Super Admin only, though the page admits the SFE Manager");
  assert.match(service, /assertRealSessionForDecision\(access, "merge two customers"\)/);
  assert.match(service, /error\.code === "P0001"\) throw validationError\(error\.message\)/, "a refusal reaches the screen as its sentence");
  assert.match(service, /await writeRequiredAuditLog\(/);
  assert.match(service, /bumpCustomer360Cache\(/);
  for (const [pattern, method] of [["/api/marketing-requests/customer-merge", "POST"], ["/api/marketing-requests/vendors", "PATCH"]] as const) {
    const entry = findAccessRegistryEntry(pattern, method);
    assert.equal(entry?.pattern, pattern, `${pattern} has its own entry, not the blanket`);
    assert.equal(entry?.audit.required, true);
    assert.equal(entry?.csrf.required, true);
  }
  const panel = readFileSync("src/components/employee-portal/marketing-customer-merge-panel.tsx", "utf8");
  assert.match(panel, /response\.status === 403/, "the panel hides from the SFE Manager");
  assert.match(panel, /Same name, check/, "offered to check");
  assert.doesNotMatch(panel, /\bfound duplicates?\b|\bthese are duplicates\b/i, "never called duplicates");
  assert.match(readFileSync("src/components/employee-portal/marketing-customer-database.tsx", "utf8"), /<MarketingCustomerMergePanel /);
  assert.match(readFileSync("app/(admin)/admin/marketing-requests/control/page.tsx", "utf8"), /<MarketingVendorControlPanel \/>/);
}
