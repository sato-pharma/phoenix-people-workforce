import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseOwnerOpsArgs } from "../scripts/lib/owner-ops-args.ts";
import { installOwnerOpsDryRunFence, type FencedWrite } from "../scripts/lib/owner-ops-fence.ts";
import { stripComments } from "./support/comment-strip.ts";

// scripts/owner-ops.ts — the owner's desk jobs (link a doctor's pharmacies, merge pharmacy copies,
// pin a pharmacy) run from the app's own code against the database in .env.local (owner, 25 Nov 2026:
// "do X" is done by Claude from the code, never through his screens or the spare's dev server).
//
// Because it writes the PRODUCTION database, the one promise this suite pins is:
//   1. A RUN IS A DRY RUN unless the literal token --apply is on the command line;
//   2. the dry run's fence never hands a write to the network — a table write is answered in the
//      process, a message to the outside world is answered "sent" and never sent — while a read passes;
//   3. the runner installs that fence BEFORE it imports any app module, and only skips it under --apply.

const SUPABASE = "https://ozucdzovmcqvepbozvqf.supabase.co";
const RUNNER = "scripts/owner-ops.ts";
const PHARMACY = "18390e99-c269-456b-92fe-70994258a714";
const OTHER = "eea2f512-0000-4000-8000-000000000001";

function plan(argv: string[]) {
  const parsed = parseOwnerOpsArgs(argv);
  assert.equal(parsed.ok, true, `${argv.join(" ")} parses (${parsed.ok ? "" : parsed.error})`);
  return (parsed as Extract<typeof parsed, { ok: true }>).plan;
}

function refused(argv: string[], why: string) {
  const parsed = parseOwnerOpsArgs(argv);
  assert.equal(parsed.ok, false, `${argv.join(" ")} is refused: ${why}`);
}

function dryRunIsTheDefault() {
  const link = ["link-doctor", "--body", "body.json"];
  const merge = ["merge-venues", "--survivor", PHARMACY, "--loser", OTHER, "--reason", "same shop, same codes"];
  const pin = ["pin-pharmacy", "--pharmacy", PHARMACY, "--lat", "29.95", "--lng", "31.25"];
  const crm = ["load-crm-list", "--seat", "SEAT-PED-REP-D12", "--body", "body.json"];
  const customers = ["merge-customers", "--survivor", PHARMACY, "--retired", OTHER, "--reason", "same doctor saved twice"];
  const unlink = ["remove-customer-pharmacy", "--customer", OTHER, "--pharmacy", PHARMACY, "--reason", "second copy of the same pharmacy"];
  const seat = ["seat-in-building", "--seat", "SEAT-PED-REP-D12", "--building", PHARMACY, "--customers", `${OTHER},${PHARMACY}`, "--reason", "his timetable names them"];
  const bind = ["bind-tablet-agent", "--install", OTHER, "--tablet", "PHX-TAB-0008"];
  const revoke = ["revoke-tablet-agent", "--install", OTHER, "--reason", "the tablet was factory reset"];

  for (const argv of [link, merge, pin, crm, seat, customers, unlink, bind, revoke]) {
    assert.equal(plan(argv).apply, false, `${argv[0]} with no --apply is a DRY RUN`);
    assert.equal(plan([...argv, "--apply"]).apply, true, `${argv[0]} --apply writes`);
    assert.equal(plan([argv[0]!, "--apply", ...argv.slice(1)]).apply, true, "--apply counts wherever it stands");
    refused([...argv, "--apply=yes"], "--apply takes no value, so --apply=yes is never a quiet write");
    refused([...argv, "--apply=false"], "and --apply=false is never a quiet write either");
    refused([...argv, "apply"], "a bare word is not the flag");
  }

  refused(["merge-venues", "--survivor", PHARMACY, "--loser", OTHER, "--reason", "x", "--lat", "31"], "a flag of another job");
  refused(["pin-pharmacy", "--pharmacy", PHARMACY, "--pharmacy", OTHER, "--lat", "29.9", "--lng", "31.2"], "a flag given twice");
  refused(["merge-venues", "--survivor", PHARMACY, "--loser", PHARMACY, "--reason", "x"], "a pharmacy merged into itself");
  refused(["merge-venues", "--survivor", "not-a-uuid", "--loser", OTHER, "--reason", "x"], "an id that is not a uuid");
  refused(["merge-venues", "--survivor", PHARMACY, "--loser", OTHER], "a merge with no reason");
  refused(["pin-pharmacy", "--pharmacy", PHARMACY, "--lat", "32.90", "--lng", "24.09"], "an Aswan pin with latitude and longitude swapped lands outside Egypt");
  refused(["pin-pharmacy", "--pharmacy", PHARMACY, "--lat", "abc", "--lng", "31.25"], "a latitude that is not a number");
  refused(["--apply", "pin-pharmacy"], "a run that does not name its job first");
  refused(["fix-everything"], "a job the runner does not know");
  const crmPlan = plan(["load-crm-list", "--seat", "seat-ped-rep-d12", "--body", "body.json"]);
  assert.equal(crmPlan.job === "load-crm-list" && crmPlan.seatId, "SEAT-PED-REP-D12", "a territory seat id is read in capitals");
  refused(["load-crm-list", "--seat", "PD-0030", "--body", "body.json"], "an HR id is not a territory seat id");
  refused(["load-crm-list", "--body", "body.json"], "a list load names its territory");
  refused(["load-crm-list", "--seat", "SEAT-PED-REP-D12"], "and its body");
  refused(["load-crm-list", "--seat", "SEAT-PED-REP-D12", "--body", "b.json", "--lat", "31"], "a flag of another job");
  const customersPlan = plan(customers);
  assert.deepEqual(
    customersPlan.job === "merge-customers" && [customersPlan.survivorId, customersPlan.retiredId],
    [PHARMACY, OTHER],
    "--survivor is the customer that stays, --retired the copy",
  );
  refused(["merge-customers", "--survivor", PHARMACY, "--retired", PHARMACY, "--reason", "same doctor saved twice"], "a customer merged into itself");
  refused(["merge-customers", "--survivor", PHARMACY, "--retired", OTHER, "--reason", "short"], "a reason under 10 characters, which the merge refuses");
  refused(["merge-customers", "--survivor", PHARMACY, "--retired", OTHER], "a customer merge with no reason");
  refused(["merge-customers", "--survivor", PHARMACY, "--loser", OTHER, "--reason", "same doctor saved twice"], "--loser belongs to the pharmacy merge, never to the customer merge");
  refused(["merge-venues", "--survivor", PHARMACY, "--retired", OTHER, "--reason", "same shop, same codes"], "and --retired never to the pharmacy merge");
  const unlinkPlan = plan(unlink);
  assert.deepEqual(
    unlinkPlan.job === "remove-customer-pharmacy" && [unlinkPlan.customerId, unlinkPlan.pharmacyId],
    [OTHER, PHARMACY],
    "--customer is the customer, --pharmacy the pharmacy coming off it",
  );
  refused(["remove-customer-pharmacy", "--customer", OTHER, "--pharmacy", PHARMACY, "--reason", "dup"], "a reason under 10 characters");
  refused(["remove-customer-pharmacy", "--customer", OTHER, "--pharmacy", PHARMACY], "a removal with no reason");
  refused(["remove-customer-pharmacy", "--pharmacy", PHARMACY, "--reason", "second copy of the same pharmacy"], "a removal that names no customer");
  refused(["remove-customer-pharmacy", "--customer", "not-a-uuid", "--pharmacy", PHARMACY, "--reason", "second copy of the same pharmacy"], "a customer id that is not a uuid");
  refused(["remove-customer-pharmacy", "--customers", OTHER, "--pharmacy", PHARMACY, "--reason", "second copy of the same pharmacy"], "--customers belongs to the seating, never to a removal");
  const seatPlan = plan(seat);
  assert.deepEqual(seatPlan.job === "seat-in-building" && seatPlan.customerIds, [OTHER, PHARMACY], "the customers are read from one comma-separated list, in order");
  refused(["seat-in-building", "--seat", "SEAT-PED-REP-D12", "--building", PHARMACY, "--customers", `${OTHER},${OTHER}`, "--reason", "his timetable names them"], "a customer named twice");
  refused(["seat-in-building", "--seat", "SEAT-PED-REP-D12", "--building", PHARMACY, "--customers", "not-a-uuid", "--reason", "his timetable names them"], "a customer id that is not a uuid");
  refused(["seat-in-building", "--seat", "SEAT-PED-REP-D12", "--building", PHARMACY, "--customers", OTHER, "--reason", "short"], "a reason under 10 characters, which the database refuses");
  refused(["seat-in-building", "--seat", "SEAT-PED-REP-D12", "--customers", OTHER, "--reason", "his timetable names them"], "a seating with no building");
  refused(["seat-in-building", "--seat", "PD-0030", "--building", PHARMACY, "--customers", OTHER, "--reason", "his timetable names them"], "an HR id is not a territory seat id");

  // The rep tablets' own position agent (26 Nov 2026). The tablet number is read in capitals, because
  // Headwind holds it that way and a lower-case one would bind nothing.
  const bindPlan = plan(["bind-tablet-agent", "--install", OTHER.toUpperCase(), "--tablet", "phx-tab-0008"]);
  assert.deepEqual(
    bindPlan.job === "bind-tablet-agent" && [bindPlan.installId, bindPlan.deviceNumber],
    [OTHER, "PHX-TAB-0008"],
    "the install id is read in lower case and the tablet number in capitals",
  );
  assert.equal(plan(["tablet-agents"]).job, "tablet-agents", "the listing takes no flags at all");
  refused(["tablet-agents", "--install", OTHER], "the listing takes no flags, so one is a mistyped job");
  refused(["bind-tablet-agent", "--install", "not-a-uuid", "--tablet", "PHX-TAB-0008"], "an install id that is not a uuid");
  refused(["bind-tablet-agent", "--install", OTHER], "a bind that does not say which tablet");
  refused(["bind-tablet-agent", "--tablet", "PHX-TAB-0008"], "and one that does not say which install");
  refused(["bind-tablet-agent", "--install", OTHER, "--tablet", "PHX TAB 0008"], "a tablet number with spaces in it");
  refused(["bind-tablet-agent", "--install", OTHER, "--tablet", "PHX-TAB-0008", "--reason", "x"], "--reason belongs to the revoke, never to the bind");
  refused(["revoke-tablet-agent", "--install", OTHER], "a revoke with no reason");
  refused(["revoke-tablet-agent", "--install", OTHER, "--reason", "reset"], "a reason under 10 characters");
  refused(["revoke-tablet-agent", "--install", OTHER, "--tablet", "PHX-TAB-0008", "--reason", "the tablet was factory reset"], "--tablet belongs to the bind, never to the revoke");
}

type Call = { url: string; method: string };

async function theFenceSendsNoWrite() {
  const calls: Call[] = [];
  const real = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify([{ id: PHARMACY, captured_latitude: null }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const original = globalThis.fetch;
  const log: FencedWrite[] = [];
  try {
    assert.equal(installOwnerOpsDryRunFence(log, real), true, "the fence installs");
    assert.equal(installOwnerOpsDryRunFence(log, real), false, "a second install is refused, never a fence around a fence");

    const table = `${SUPABASE}/rest/v1/marketing_pharmacies`;
    const read = await fetch(`${table}?id=eq.${PHARMACY}&select=id`);
    assert.equal(read.status, 200, "a read comes back");
    await fetch(`${table}?id=eq.${PHARMACY}`, {
      method: "PATCH",
      headers: { prefer: "return=representation", "content-type": "application/json" },
      body: JSON.stringify({ captured_latitude: 29.95 }),
    });
    const inserted = await fetch(`${SUPABASE}/rest/v1/marketing_customer_pharmacy_links`, {
      method: "POST",
      headers: { prefer: "return=representation", "content-type": "application/json" },
      body: JSON.stringify({ customer_id: OTHER, pharmacy_id: PHARMACY }),
    });
    assert.equal(inserted.status, 201, "an insert is answered as PostgREST would answer it");
    await fetch(`${table}?id=eq.${OTHER}`, { method: "DELETE" });
    await fetch("https://api.telegram.org/bot0/sendMessage", { method: "POST", body: "{}" });
    await fetch("https://api.resend.com/emails", { method: "POST", body: "{}" });

    const writesSent = calls.filter((call) => call.method !== "GET");
    assert.deepEqual(writesSent, [], "NOTHING but a read reached the network — no table write, no Telegram, no e-mail");
    assert.equal(calls[0]?.url.includes("select=id"), true, "the read itself passed through untouched");
    assert.deepEqual(
      log.map((write) => `${write.method} ${write.target}`),
      [
        "PATCH marketing_pharmacies",
        "POST marketing_customer_pharmacy_links",
        "DELETE marketing_pharmacies",
        "POST api.telegram.org/bot0/sendMessage",
        "POST api.resend.com/emails",
      ],
      "every write is listed for the dry run's report, and the read is not",
    );
    assert.match(log[0]!.detail, /captured_latitude/, "the listed write says what it would have changed");
  } finally {
    globalThis.fetch = original;
  }
}

function theRunnerFencesBeforeItLoadsTheApp() {
  const source = stripComments(readFileSync(RUNNER, "utf8"));
  assert.doesNotMatch(source, /^import[^;]*from\s+["'](?:@\/|\.\.\/src\/)/m, "no app module is imported statically — it would load before the fence");
  // The helpers above main() hold the app imports and run only when main() calls them, so the order
  // that matters is inside main(): the fence before the first app import or helper call it makes.
  const mainAt = source.indexOf("async function main()");
  assert.ok(mainAt > 0, "the runner has a main()");
  const body = source.slice(mainAt);
  const fence = body.indexOf("installOwnerOpsDryRunFence(fenced)");
  const firstAppUse = Math.min(
    ...[/await import\(["']@\//, /await liveAccessContext\(/, /await run(?:LinkDoctor|MergeVenues|PinPharmacy|LoadCrmList|SeatInBuilding)\(/]
      .map((pattern) => body.search(pattern))
      .filter((at) => at >= 0),
  );
  assert.ok(fence > 0, "main() installs the dry-run fence");
  assert.ok(Number.isFinite(firstAppUse), "main() reaches the app's own code");
  assert.ok(fence < firstAppUse, "the fence is installed BEFORE main() first reaches an app module");
  assert.match(source, /^await main\(\);\s*$/m, "main() is the one thing the script runs");
  assert.match(
    source,
    /if \(plan\.apply\) \{[^]{0,200}?assertTreeIsCurrent\("owner-ops"\);\s*\} else \{\s*installOwnerOpsDryRunFence\(fenced\);/,
    "only --apply skips the fence, and --apply first refuses a tree behind origin/main",
  );
  assert.match(source, /refuseUnknownFlags\(/, "an unknown flag (--aply) is refused, never read as a dry run the caller thinks wrote");
  // load-crm-list goes through the SFE's own upload — never a hand insert into the customer table.
  const crmJob = source.slice(source.indexOf("async function runLoadCrmList("), source.indexOf("async function crmListProof("));
  assert.ok(crmJob.length > 0, "the load-crm-list job is found");
  assert.match(crmJob, /await assertPermission\(owner, "phoenix_crm", "approve"\)/, "the route's own gate");
  assert.match(crmJob, /buildListTemplateFor\(viewer, plan\.seatId, false\)/, "the territory's own template, seat marker and all");
  assert.match(crmJob, /importListTemplate\(viewer, form\)/, "handed to the upload's own function");
  assert.doesNotMatch(crmJob, /\.from\("phoenix_crm_customers"\)/, "and never written to the customer table by hand");
  // seat-in-building goes through the Super Admin's own door — never a hand insert of a place, and never
  // a validation written by the runner: only the board's settle validates.
  const seatJob = source.slice(source.indexOf("async function runSeatInBuilding("), source.indexOf("async function seatInBuildingRows("));
  assert.ok(seatJob.length > 0, "the seat-in-building job is found");
  assert.match(seatJob, /await assertPermission\(owner, "phoenix_crm", "approve"\)/, "the module's own gate");
  assert.match(seatJob, /seatWaitingCustomersInVenue\(viewer, \{/, "handed to the door's own function");
  assert.doesNotMatch(seatJob, /\.(?:insert|update|upsert|delete)\(/, "and the runner itself writes no row");
  assert.doesNotMatch(seatJob, /validated_at\s*:/, "nor stamps a validation");
  // merge-customers goes through the screen's own merge, as the owner in a real session: the
  // dev-preview guard is passed, never bypassed, and the runner moves no row itself.
  const customersJob = source.slice(source.indexOf("async function runMergeCustomers("), source.indexOf("async function runPinPharmacy("));
  assert.ok(customersJob.length > 0, "the merge-customers job is found");
  assert.match(customersJob, /mergeMarketingCustomers\(owner, \{/, "handed to the merge's own function, as the owner");
  assert.match(customersJob, /carryEvidence: false/, "the retired copy's photo stays on the retired row unless asked");
  assert.doesNotMatch(customersJob, /\.(?:insert|update|upsert|delete|rpc)\(/, "and the runner itself writes no row");
  assert.doesNotMatch(customersJob, /assertRealSessionForDecision|devPreview|dev_preview/, "nor touches the real-session guard");
  // remove-customer-pharmacy goes through the Customer Check page's own "Remove": switched off with
  // the reason in the notes and the audit, never deleted, never written by the runner itself.
  const unlinkJob = source.slice(source.indexOf("async function runRemoveCustomerPharmacy("), source.indexOf("async function runPinPharmacy("));
  assert.ok(unlinkJob.length > 0, "the remove-customer-pharmacy job is found");
  assert.match(unlinkJob, /removePharmacyFromMarketingCustomer\(owner, plan\.customerId, \{/, "handed to the page's own function, as the owner");
  assert.doesNotMatch(unlinkJob, /\.(?:insert|update|upsert|delete|rpc)\(/, "and the runner itself writes no row");
}

export async function runOwnerOpsRunnerTests() {
  dryRunIsTheDefault();
  await theFenceSendsNoWrite();
  theRunnerFencesBeforeItLoadsTheApp();
}
