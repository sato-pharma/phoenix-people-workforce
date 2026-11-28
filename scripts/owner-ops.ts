// scripts/owner-ops.ts
// ---------------------------------------------------------------------------
// THE OWNER'S DESK JOBS, DONE FROM THE APP'S OWN CODE — never through a screen, his Chrome or the
// spare laptop's dev server (owner, 25 Nov 2026; memory note
// `when-he-says-do-it-claude-does-it-from-the-code`; recipes: docs/owner-operations-recipes.md).
//
// WHY A COMMITTED SCRIPT. Until 25 Nov 2026 these jobs were curl calls with dev-auth headers to the
// spare laptop's dev server, and they failed whenever its Wi-Fi dropped (22:44 that night). A scratch
// script that builds a Super Admin viewer was refused by Claude Code's safety check on 9 Oct 2026, so
// the durable form is this reviewed one.
//
// WHAT IT DOES, PER JOB — the same function the route handler calls, nothing written by hand:
//   link-doctor   createMarketingValidationRecord   (POST /api/marketing-requests/validation)
//   merge-venues  mergeMarketingVenue               (POST /api/marketing-requests/venue-merge)
//   merge-customers mergeMarketingCustomers         (POST /api/marketing-requests/customer-merge)
//                 The screen's merge asks "are you sure?" in a browser OK box, which the app's browser
//                 pane closes unanswered, so the press never reached the server (26 Nov 2026). The owner's
//                 word in chat is the decision; this sends it through the same function and its refusals.
//   remove-customer-pharmacy removePharmacyFromMarketingCustomer (the Customer Check page's "Remove")
//                 Switches one pharmacy off one customer, with the reason in the link's notes and the audit.
//                 First used for the customers holding one pharmacy twice through two venue copies.
//   pin-pharmacy  the desk-entry pin: captured_latitude/longitude/at on marketing_pharmacies with
//                 evidence_status 'pending' (no shop photo). No route writes this; the 25 Nov pins were
//                 one hand UPDATE, so it is done here with that UPDATE's own guard (no pin yet) plus a
//                 live venue and a coordinate inside Egypt.
//   load-crm-list importListTemplate                (POST /api/phoenix-crm/list/template/import)
//                 The territory's own template is built (buildListTemplateFor, the download the SFE
//                 gets), the body's rows are written into it, and the filled sheet is handed to the
//                 upload's own function — so every check of that upload runs (the seat marker, the
//                 row rules, the database's same-name skip). Customers land "to validate" for the rep.
//   start-tablet-agent startPositionAgentOnTablet       (no screen calls it; nobody can open the app)
//                 Headwind's own runApp push to a tablet that already carries the position agent. The
//                 app has no icon, no notification and no screen, so nobody can start it by hand, and
//                 Android keeps an app that has never run in the stopped state where not even
//                 BOOT_COMPLETED reaches it: until something starts it once, the tablet says nothing to
//                 Phoenix. Refused when that tablet's own app list does not carry the agent.
//   tablet-agents / bind-tablet-agent / revoke-tablet-agent
//                 listPositionAgents · bindPositionAgent · revokePositionAgent (26 Nov 2026). The rep
//                 tablets' own Phoenix Position app enrols itself at a token door; nothing but the
//                 install's own id says which tablet it is, and no screen asks. These three list the
//                 installs, say which tablet one belongs to (stamping the fixes it already sent), and
//                 take one out of service — each through the same `company_devices / approve` check the
//                 Headwind routes use, and each audited.
//   match-app-version matchHeadwindVersionsToFiles     (no screen calls it; it was a hand-typed number)
//                 Reads the real versionName/versionCode out of the APK each of an app's Headwind
//                 version rows points at — by ranged requests, never an 81 MB download — and puts any
//                 row that disagrees with its own file back in place. A row claiming a build its file
//                 is not makes every tablet re-download that file at every check-in for ever, and the
//                 tablet server now re-fetches a floating app by itself, so the row can rot unwatched.
//                 Refuses when the file is a different package: that would hand the fleet another app.
//   lock-rep-tablets setHeadwindRestrictions / lockRepTablets   (owner, 26 Nov 2026: protect the tablet
//                 "without irritating the usage"). Puts the full rep lock set on all three rep sets of
//                 rules (3, 4, 5) — Wi-Fi off, aeroplane mode, the mobile network's settings, network
//                 reset, side-loading and force-stop — on top of the six they already carry, and says
//                 what each one costs the rep. It only ever ADDS. `no_install_apps` and `no_config_wifi`
//                 are refused by name, and mobile data is reported as what no Android lock can hold.
//   end-insurance-cover updateMedicalInsuranceMember (owner, 27 Nov 2026: "End the three resigned
//                 employees' insurance cover"). Ends each named employee's cover on the day and with the
//                 reason the Add/Remove screen gives; refuses anyone the screen does not list to remove.
//   reinstate-insurance-cover updateMedicalInsuranceMember action "reinstate" (owner, 27 Nov 2026: Salim Gomaa
//                 was not on To remove because his cover was ended before Libano-Suisse was sent the deletion;
//                 his MCQ answer "Only bring back these three"). The register's own "Put back", for the employee's
//                 one ended row on the policy in force; refused when there is none or more than one.
//   sync-insurance-master syncEmployeeMasterFromMedicalInsurance   (owner, 27 Nov 2026: "synchronize from
//                 medical insurance module to employee master the needed data"). The Libano-Suisse card
//                 number goes onto the Employee Master; national ID, birth date, gender and mobile only where
//                 the master is blank. Differences are listed, never written. Each write names B-10 to the
//                 history log itself (it sets the actor headers), so this one is NOT unattributed.
//   seat-in-building seatWaitingCustomersInVenue     (the Super Admin's door; no screen calls it yet)
//                 Customers still waiting, with hours and no place, are seated in an approved building
//                 at its own point; the building's timetable is then read for each, and only the ones it
//                 NAMES are validated (phoenix_crm_settle_venue_timetable). It never validates by itself.
//
// WHO IT ACTS AS. B-10, the owner, built the way a real signed-in request is: his live
// app_auth_users row (active, not a test account, role read strictly), his employee lifecycle gate,
// then createAccessContext({ source: "session" }) — so every domain check (assertMarketingControlAccess,
// assertMarketingOnBehalfAccess, the Super Admin decision rule) runs exactly as on the screen. The proof
// read opens the EMPLOYEE's own draft workspace the same way, as her.
//
// 🔴 A DRY RUN UNLESS `--apply` IS ON THE COMMAND LINE. The dry run is the app's own test-account fence
// (scripts/lib/owner-ops-fence.ts): the job runs fully, every write it tries is listed and answered
// without being sent, and no e-mail, Telegram or push leaves. `--apply` also refuses a tree behind
// origin/main (scripts/lib/tree-is-current.ts) — stale domain code would write by stale rules.
//
// It opens no direct Postgres connection; everything goes through the Supabase client the app uses.
// The history logs record these writes unattributed: there is no request to carry the actor headers
// (src/lib/supabase/request-actor.ts) — the marketing rows' own *_by_hr_id columns still name B-10.
//
// Run (from the repo root, never through pnpm in a worktree):
//   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
//     --import ./tests/register-alias-loader.mjs scripts/owner-ops.ts <job> <flags> [--apply]
// ---------------------------------------------------------------------------

import fs from "node:fs";

import { OWNER_OPS_FLAGS, OWNER_OPS_USAGE, parseOwnerOpsArgs, type OwnerOpsPlan } from "./lib/owner-ops-args.ts";
import { installOwnerOpsDryRunFence, type FencedWrite } from "./lib/owner-ops-fence.ts";
import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored — `--aply` must not run a dry run while
// the caller believes it wrote (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "owner-ops",
  entry: import.meta.url,
  known: [...OWNER_OPS_FLAGS],
  hints: ["run with --help for the jobs and their flags"],
});

/** The owner. Every job acts as him; the spare's dev-auth headers named the same person. */
const OWNER_LOGIN_ID = "B-10";

const KNOWN_PROJECTS: Record<string, string> = {
  ozucdzovmcqvepbozvqf: "PRODUCTION",
  cifwmndunmlxjhyjugxa: "STAGING",
};

type AccessContext = import("@/lib/auth/permissions").AccessContext;

function fail(message: string, code = 1): never {
  console.error(`owner-ops: ${message}`);
  process.exit(code);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return code ? `${error.message} [${String(code)}]` : error.message;
  }
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

/**
 * The signed-in person, built from the same rows a real session is checked against
 * (src/lib/auth/server.ts resolveSessionState): an active, non-test login, its role read strictly, and
 * the linked employee still employed. Anything else is refused — never a fabricated context.
 */
async function liveAccessContext(loginOrHrId: string): Promise<{ access: AccessContext; label: string }> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const { createAccessContext, parseRoleStrict } = await import("@/lib/auth/permissions");
  const { evaluateEmployeeLifecycleGate } = await import("@/lib/auth/session-lifecycle");
  const { currentCairoDateOnlyIso } = await import("@/lib/i18n/format");
  const supabase = getSupabaseAdmin();
  const columns = "login_id, hr_id, role, is_active, is_test_persona";

  type AuthRow = { login_id: string; hr_id: string | null; role: string | null; is_active: boolean | null; is_test_persona: boolean | null };
  const byLogin = await supabase.from("app_auth_users").select(columns).eq("login_id", loginOrHrId);
  if (byLogin.error) throw byLogin.error;
  let rows = (byLogin.data ?? []) as AuthRow[];
  if (rows.length === 0) {
    const byHrId = await supabase.from("app_auth_users").select(columns).eq("hr_id", loginOrHrId).eq("is_active", true);
    if (byHrId.error) throw byHrId.error;
    rows = (byHrId.data ?? []) as AuthRow[];
  }
  if (rows.length !== 1) throw new Error(`${loginOrHrId}: expected one login, found ${rows.length}`);
  const row = rows[0]!;
  if (row.is_test_persona === true) throw new Error(`${loginOrHrId} is a test account — it never writes as the person it shows`);
  if (row.is_active !== true) throw new Error(`${loginOrHrId}: the login is switched off`);
  const role = parseRoleStrict(row.role);

  let name = row.hr_id ?? row.login_id;
  if (row.hr_id) {
    const employee = await supabase
      .from("employees")
      .select("employment_status, last_working_date, full_name, nickname")
      .eq("hr_id", row.hr_id)
      .maybeSingle();
    if (employee.error) throw employee.error;
    if (employee.data) {
      const data = employee.data as { employment_status: string | null; last_working_date: string | null; full_name: string | null; nickname: string | null };
      const gate = evaluateEmployeeLifecycleGate({
        lookupFailed: false,
        employmentStatus: data.employment_status,
        lastWorkingDate: data.last_working_date,
        todayCairo: currentCairoDateOnlyIso(),
      });
      if (!gate.allowed) throw new Error(`${row.hr_id} is no longer employed (${gate.reason ?? "refused"})`);
      name = data.nickname?.trim() || data.full_name?.trim() || name;
    }
  }

  return {
    access: createAccessContext({ hrId: row.hr_id, loginId: row.login_id, role, source: "session" }),
    label: `${name} (${row.hr_id ?? row.login_id}) — ${role}`,
  };
}

/** The employees who hold a doctor linked to any of these pharmacies — whose screen the change reaches. */
async function employeesLinkedTo(pharmacyIds: string[]): Promise<string[]> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const supabase = getSupabaseAdmin();
  const links = await supabase.from("marketing_customer_pharmacies").select("customer_id").in("pharmacy_id", pharmacyIds).eq("active", true);
  if (links.error) throw links.error;
  const customerIds = [...new Set(((links.data ?? []) as Array<{ customer_id: string }>).map((row) => row.customer_id))];
  if (customerIds.length === 0) return [];
  const customers = await supabase.from("marketing_customers").select("owner_hr_id").in("id", customerIds).eq("active", true);
  if (customers.error) throw customers.error;
  return [...new Set(((customers.data ?? []) as Array<{ owner_hr_id: string | null }>).map((row) => row.owner_hr_id).filter((id): id is string => Boolean(id)))];
}

/**
 * THE PROOF READ — the employee's own draft workspace (GET /api/marketing-requests/drafts as her):
 * the doctors she can raise a request for and the pharmacies offered under each. `focus` narrows it to
 * the doctors this run touched (by name) or the doctors holding the pharmacies it touched (by id).
 */
async function proofRead(hrId: string, focus: { doctorNames?: string[]; pharmacyIds?: string[] }): Promise<void> {
  const { getMarketingRequestDraftWorkspace } = await import("@/lib/marketing-requests/service");
  const { access, label } = await liveAccessContext(hrId);
  const workspace = await getMarketingRequestDraftWorkspace(access);
  const names = new Set((focus.doctorNames ?? []).map((name) => name.trim()));
  const pharmacyIds = new Set(focus.pharmacyIds ?? []);
  const customers = workspace.customers.filter((customer) => {
    if (names.has(customer.displayName.trim())) return true;
    return (workspace.pharmaciesByCustomer[customer.id] ?? []).some((option) => pharmacyIds.has(option.pharmacyId));
  });
  console.log(`\nPROOF — ${label}: draft workspace, ${workspace.customers.length} doctor(s) in all`);
  if (customers.length === 0) {
    console.log("  none of the doctors or pharmacies this run touched is in it");
    return;
  }
  for (const customer of customers) {
    const options = workspace.pharmaciesByCustomer[customer.id] ?? [];
    console.log(`  ${customer.displayName}  (${options.length} pharmacy option(s))`);
    for (const option of options) {
      const mark = pharmacyIds.has(option.pharmacyId) ? "  <- this run" : "";
      const code = option.distributorName ? `${option.distributorName} ${option.pharmacyCode}` : "no distributor code";
      console.log(`    - ${option.pharmacyName}  [${code}]  ${option.pharmacyId}${mark}`);
    }
  }
}

/**
 * Refuse a new-doctor entry when the employee already holds an active doctor of the same NAME that the
 * app will not join. Since #784 the desk save itself joins a doctor held under the same Phoenix CRM
 * customer (only his pharmacies are written), so a CRM-id match is left to the app and only announced;
 * a same-name doctor held under no or another CRM id is still minted again, so that one is refused here.
 * The fix is to send that entry with "existingCustomerId", which adds the pharmacies to the doctor on file.
 */
async function refuseDoctorAlreadyHeld(onBehalfOf: string, customers: Array<Record<string, unknown>>): Promise<void> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const { hrIdForStorage } = await import("@/lib/hr-id");
  const owner = hrIdForStorage(onBehalfOf) ?? onBehalfOf;
  const held = await getSupabaseAdmin()
    .from("marketing_customers")
    .select("id, customer_code, display_name, phoenix_crm_customer_id")
    .eq("owner_hr_id", owner)
    .eq("active", true)
    .is("merged_into_customer_id", null);
  if (held.error) throw held.error;
  const rows = (held.data ?? []) as Array<{ id: string; customer_code: string | null; display_name: string; phoenix_crm_customer_id: string | null }>;
  const clashes: string[] = [];
  for (const entry of customers) {
    if (String(entry.existingCustomerId ?? "").trim()) continue;
    const crmId = String(entry.crmCustomerId ?? "").trim();
    const name = String(entry.displayName ?? "").trim();
    const joined = crmId ? rows.find((row) => row.phoenix_crm_customer_id === crmId) : undefined;
    if (joined) {
      console.log(`  ${name || crmId}: already held as ${joined.id} (${joined.customer_code ?? "no code"}) — the app joins it, only the pharmacies are written`);
      continue;
    }
    const same = rows.filter((row) => name && row.display_name.trim() === name);
    if (same.length > 0) {
      clashes.push(`${name || crmId}: already held as ${same.map((row) => `${row.id} (${row.customer_code ?? "no code"})`).join(", ")}`);
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      `${onBehalfOf} already holds ${clashes.length === 1 ? "this doctor" : "these doctors"} — saving again would make a second copy.\n  `
      + `${clashes.join("\n  ")}\n  Put "existingCustomerId": "<that id>" in the customer entry to add the pharmacies to the doctor on file.`,
    );
  }
}

async function runLinkDoctor(plan: Extract<OwnerOpsPlan, { job: "link-doctor" }>, owner: AccessContext) {
  if (!fs.existsSync(plan.bodyPath)) fail(`--body ${plan.bodyPath}: no such file`, 2);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(fs.readFileSync(plan.bodyPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    fail(`--body ${plan.bodyPath} is not JSON: ${errorText(error)}`, 2);
  }
  const onBehalfOf = typeof body.onBehalfOfHrId === "string" ? body.onBehalfOfHrId.trim() : "";
  if (!onBehalfOf) fail("the body has no onBehalfOfHrId — this job is the Super Admin desk entry FOR an employee", 2);
  const customers = Array.isArray(body.customers) ? (body.customers as Array<Record<string, unknown>>) : [];
  const doctorNames = customers.map((customer) => String(customer.displayName ?? "")).filter(Boolean);
  console.log(`For: ${onBehalfOf} — ${customers.length} doctor(s): ${doctorNames.join(", ") || "(none named)"}`);

  // 🔴 A DOCTOR SHE ALREADY HOLDS IS NAMED, NEVER SAVED AGAIN. Before #784 the save minted a new doctor
  // row for every entry without existingCustomerId — that is how Dr Othman El Shewehy and his four
  // pharmacies were saved twice for Sahar ElGallad on 25 Nov 2026 23:12. The app now joins a doctor held
  // under the same CRM customer; a same-name doctor under no or another CRM id is still refused here.
  await refuseDoctorAlreadyHeld(onBehalfOf, customers);

  const { createMarketingValidationRecord } = await import("@/lib/marketing-requests/service");
  const rows = await createMarketingValidationRecord(body as never, owner);
  console.log(`\nThe app accepted it: ${rows.length} link row(s)`);
  for (const row of rows) {
    const code = row.distributorName && row.distributorCode
      ? `${row.distributorName} ${row.distributorCode.distributorPharmacyCode}`
      : "no distributor code";
    console.log(`  ${row.customer.displayName}  ->  ${row.pharmacy.displayName}  [${code}]  ${row.validationStatus}`);
  }
  return { employees: [onBehalfOf], focus: { doctorNames } };
}

async function runMergeVenues(plan: Extract<OwnerOpsPlan, { job: "merge-venues" }>, owner: AccessContext) {
  const { mergeMarketingVenue } = await import("@/lib/marketing-requests/service");
  const employees = plan.employeeHrId ? [plan.employeeHrId] : await employeesLinkedTo([plan.survivorId, plan.loserId]);
  console.log(`Keep ${plan.survivorId}, fold in ${plan.loserId}. Reason: ${plan.reason}`);
  const result = await mergeMarketingVenue(owner, { survivorId: plan.survivorId, loserId: plan.loserId, reason: plan.reason });
  console.log("\nThe app accepted it:");
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "number") console.log(`  ${key}: ${value}`);
  }
  return { employees, focus: { pharmacyIds: [plan.survivorId, plan.loserId] } };
}

type MergeCustomerRow = {
  active: boolean; area_id: string | null; customer_code: string; customer_type: string; display_name: string;
  id: string; line_id: string | null; merged_into_customer_id: string | null; validation_status: string;
};

async function readMergeCustomers(ids: string[]): Promise<Map<string, MergeCustomerRow & { links: number; requests: number }>> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const supabase = getSupabaseAdmin();
  const rows = await supabase
    .from("marketing_customers")
    .select("id, customer_code, display_name, customer_type, line_id, area_id, validation_status, active, merged_into_customer_id")
    .in("id", ids);
  if (rows.error) throw rows.error;
  const out = new Map<string, MergeCustomerRow & { links: number; requests: number }>();
  for (const row of (rows.data ?? []) as MergeCustomerRow[]) {
    const links = await supabase.from("marketing_customer_pharmacies").select("id", { count: "exact", head: true }).eq("customer_id", row.id).eq("active", true);
    if (links.error) throw links.error;
    const requests = await supabase.from("marketing_requests").select("id", { count: "exact", head: true }).eq("customer_id", row.id);
    if (requests.error) throw requests.error;
    out.set(row.id, { ...row, links: links.count ?? 0, requests: requests.count ?? 0 });
  }
  return out;
}

function describeMergeCustomer(label: string, row: (MergeCustomerRow & { links: number; requests: number }) | undefined): string {
  if (!row) return `  ${label}: not found`;
  const state = row.merged_into_customer_id ? `merged into ${row.merged_into_customer_id}` : row.active ? "live" : "switched off";
  return `  ${label}: ${row.display_name} · ${row.customer_code} · ${row.customer_type} · ${row.validation_status} · ${state} · ${row.links} live pharmacy link(s) · ${row.requests} request(s)`;
}

async function runMergeCustomers(plan: Extract<OwnerOpsPlan, { job: "merge-customers" }>, owner: AccessContext) {
  const { mergeMarketingCustomers } = await import("@/lib/marketing-requests/customer-merge");
  const before = await readMergeCustomers([plan.survivorId, plan.retiredId]);
  console.log("Before:");
  console.log(describeMergeCustomer("stays  ", before.get(plan.survivorId)));
  console.log(describeMergeCustomer("retired", before.get(plan.retiredId)));
  console.log(`Reason: ${plan.reason}`);
  const result = await mergeMarketingCustomers(owner, {
    carryEvidence: false,
    reason: plan.reason,
    retiredId: plan.retiredId,
    survivorId: plan.survivorId,
  });
  console.log("\nThe app accepted it:");
  for (const [key, value] of Object.entries(result ?? {})) console.log(`  ${key}: ${String(value)}`);

  // PROOF — read back, not the function's own report. On a dry run the merge ran inside a rolled-back
  // transaction, so this shows the rows as they still are.
  const after = await readMergeCustomers([plan.survivorId, plan.retiredId]);
  console.log("\nPROOF — the two rows now:");
  console.log(describeMergeCustomer("stays  ", after.get(plan.survivorId)));
  console.log(describeMergeCustomer("retired", after.get(plan.retiredId)));
  if (plan.apply && after.get(plan.retiredId)?.merged_into_customer_id !== plan.survivorId) {
    // Exit 3, never a refusal: the write has already happened, and "refused" would read as "nothing changed".
    console.error("\nPROOF FAILED — the merge reported success but the retired row does not point at the one that stays.");
    process.exitCode = 3;
  }
  return { employees: [], focus: {}, proofDone: true };
}

type CustomerLinkRow = { active: boolean; distributor_code_id: string | null; id: string; pharmacy_id: string; validation_status: string };

async function readCustomerLinks(customerId: string) {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const supabase = getSupabaseAdmin();
  const customer = await supabase.from("marketing_customers").select("display_name, customer_code, active").eq("id", customerId).maybeSingle();
  if (customer.error) throw customer.error;
  const links = await supabase
    .from("marketing_customer_pharmacies")
    .select("id, pharmacy_id, distributor_code_id, validation_status, active")
    .eq("customer_id", customerId)
    .eq("active", true);
  if (links.error) throw links.error;
  const rows = (links.data ?? []) as CustomerLinkRow[];
  const venues = rows.length
    ? await supabase.from("marketing_pharmacies").select("id, display_name, pharmacy_code").in("id", [...new Set(rows.map((row) => row.pharmacy_id))])
    : { data: [], error: null };
  if (venues.error) throw venues.error;
  const names = new Map(((venues.data ?? []) as Array<{ display_name: string; id: string; pharmacy_code: string }>).map((v) => [v.id, `${v.display_name} · ${v.pharmacy_code}`]));
  return { customer: customer.data as { active: boolean; customer_code: string; display_name: string } | null, links: rows, names };
}

function describeCustomerLinks(read: Awaited<ReturnType<typeof readCustomerLinks>>, removedPharmacyId: string) {
  if (!read.customer) return "  customer: not found";
  const lines = [`  ${read.customer.display_name} · ${read.customer.customer_code} · ${read.links.length} live pharmacy link(s)`];
  for (const link of read.links) {
    lines.push(`    ${link.pharmacy_id === removedPharmacyId ? "→ " : "  "}${read.names.get(link.pharmacy_id) ?? link.pharmacy_id} · ${link.validation_status}`);
  }
  return lines.join("\n");
}

async function runRemoveCustomerPharmacy(plan: Extract<OwnerOpsPlan, { job: "remove-customer-pharmacy" }>, owner: AccessContext) {
  const { removePharmacyFromMarketingCustomer } = await import("@/lib/marketing-requests/customer-edit");
  const before = await readCustomerLinks(plan.customerId);
  console.log("Before (→ is the pharmacy coming off):");
  console.log(describeCustomerLinks(before, plan.pharmacyId));
  console.log(`Reason: ${plan.reason}`);
  const result = await removePharmacyFromMarketingCustomer(owner, plan.customerId, { pharmacyId: plan.pharmacyId, reason: plan.reason });
  console.log(`\nThe app accepted it: ${result.linksRemoved} link(s) switched off`);

  // PROOF — read back, not the function's own report.
  const after = await readCustomerLinks(plan.customerId);
  console.log("\nPROOF — the customer's live pharmacies now:");
  console.log(describeCustomerLinks(after, plan.pharmacyId));
  if (plan.apply && after.links.some((link) => link.pharmacy_id === plan.pharmacyId)) {
    // Exit 3, never a refusal: the write has already happened, and "refused" would read as "nothing changed".
    console.error("\nPROOF FAILED — the app reported the pharmacy removed but a live link to it is still on the customer.");
    process.exitCode = 3;
  }
  return { employees: [], focus: {}, proofDone: true };
}

async function runPinPharmacy(plan: Extract<OwnerOpsPlan, { job: "pin-pharmacy" }>, owner: AccessContext) {
  const isDryRun = !plan.apply;
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const { hrIdForStorage } = await import("@/lib/hr-id");
  const supabase = getSupabaseAdmin();
  const current = await supabase
    .from("marketing_pharmacies")
    .select("id, display_name, active, merged_into_pharmacy_id, captured_latitude, captured_longitude, evidence_status, validation_status")
    .eq("id", plan.pharmacyId)
    .maybeSingle();
  if (current.error) throw current.error;
  const venue = current.data as {
    active: boolean; captured_latitude: number | null; captured_longitude: number | null; display_name: string;
    evidence_status: string | null; merged_into_pharmacy_id: string | null; validation_status: string | null;
  } | null;
  if (!venue) throw new Error("that pharmacy does not exist");
  if (venue.merged_into_pharmacy_id) throw new Error(`"${venue.display_name}" was merged into ${venue.merged_into_pharmacy_id} — pin that one`);
  if (!venue.active) throw new Error(`"${venue.display_name}" is switched off`);
  if (venue.captured_latitude !== null || venue.captured_longitude !== null) {
    throw new Error(`"${venue.display_name}" already has a pin (${venue.captured_latitude}, ${venue.captured_longitude}) — this job only fills an empty one`);
  }
  console.log(`Pin "${venue.display_name}" at ${plan.latitude}, ${plan.longitude} (evidence ${venue.evidence_status ?? "none"} -> pending)`);

  const now = new Date().toISOString();
  // Every actor column is written in the stored casing, never access.hrId's comparison key.
  const actor = hrIdForStorage(owner.hrId);
  const write = await supabase
    .from("marketing_pharmacies")
    .update({
      captured_at: now,
      captured_latitude: plan.latitude,
      captured_longitude: plan.longitude,
      evidence_status: "pending",
      updated_at: now,
      updated_by_hr_id: actor,
    })
    .eq("id", plan.pharmacyId)
    // The same guard the 25 Nov hand UPDATE carried: never over a pin someone set in between.
    .is("captured_latitude", null)
    .select("id, display_name, captured_latitude, captured_longitude, evidence_status, validation_status");
  if (write.error) throw write.error;
  const written = (write.data ?? []) as Array<Record<string, unknown>>;
  if (written.length !== 1) throw new Error(`expected one row pinned, the database answered ${written.length}`);
  console.log(`\nThe pin row${isDryRun ? " as the database would hold it" : ""}: ${JSON.stringify(written[0])}`);

  const employees = plan.employeeHrId ? [plan.employeeHrId] : await employeesLinkedTo([plan.pharmacyId]);
  return { employees, focus: { pharmacyIds: [plan.pharmacyId] } };
}

/** One row of the load-crm-list body, in the template's own column keys. */
type CrmListRow = Partial<Record<"listType" | "name" | "speciality" | "grade" | "potentialGrade" | "phone" | "daysAndHours" | "whereToFind" | "note", string>>;

/**
 * Write rows under a sheet's header, column by column as the header names them. The header is found the
 * way the upload finds it — a row holding every required label — so a template that grows a preamble
 * line still fills.
 */
function fillSheetRows(
  sheet: import("exceljs").Worksheet,
  columns: ReadonlyArray<{ key: string; label: string; aliases: readonly string[] }>,
  required: readonly string[],
  rows: ReadonlyArray<Record<string, string | undefined>>,
  fold: (value: unknown) => string,
  cellText: (value: import("exceljs").CellValue) => string,
): void {
  let header: { rowNumber: number; at: Map<string, number> } | null = null;
  for (let rowNumber = 1; rowNumber <= Math.min(40, sheet.rowCount) && !header; rowNumber += 1) {
    const at = new Map<string, number>();
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= Math.max(columns.length, sheet.columnCount); column += 1) {
      const text = fold(cellText(row.getCell(column).value));
      const match = columns.find((entry) => fold(entry.label) === text || entry.aliases.includes(text));
      if (match && !at.has(match.key)) at.set(match.key, column);
    }
    if (required.every((key) => at.has(key))) header = { rowNumber, at };
  }
  if (!header) throw new Error(`the sheet "${sheet.name}" has no header row this job can fill`);
  // The first row under the header whose named cells are all empty — the template ships formatted blank
  // rows, so `rowCount` would put the rows hundreds of lines down, past where an SFE would type.
  const isEmpty = (rowNumber: number) =>
    [...header!.at.values()].every((column) => cellText(sheet.getRow(rowNumber).getCell(column).value).trim() === "");
  let next = header.rowNumber + 1;
  while (!isEmpty(next)) next += 1;
  for (const entry of rows) {
    while (!isEmpty(next)) next += 1;
    const row = sheet.getRow(next);
    for (const [key, column] of header.at) {
      const value = entry[key];
      if (value !== undefined && value !== "") row.getCell(column).value = value;
    }
    row.commit();
    next += 1;
  }
}

/**
 * Customers onto a rep's Phoenix CRM list as "to validate", and hours onto customers already waiting —
 * through the SFE's own list-template upload (importListTemplate), never a hand insert. The PLACE is
 * never written: the rep captures it at the door, which is how the customer is validated.
 */
async function runLoadCrmList(plan: Extract<OwnerOpsPlan, { job: "load-crm-list" }>, owner: AccessContext) {
  if (!fs.existsSync(plan.bodyPath)) fail(`--body ${plan.bodyPath}: no such file`, 2);
  let body: { customers?: CrmListRow[]; hours?: CrmListRow[] };
  try {
    body = JSON.parse(fs.readFileSync(plan.bodyPath, "utf8")) as typeof body;
  } catch (error) {
    fail(`--body ${plan.bodyPath} is not JSON: ${errorText(error)}`, 2);
  }
  const customers = Array.isArray(body.customers) ? body.customers : [];
  const hours = Array.isArray(body.hours) ? body.hours : [];
  if (customers.length === 0 && hours.length === 0) fail("the body has neither customers nor hours", 2);

  // The route's own gate, then the route's own viewer.
  const { assertPermission } = await import("@/lib/auth/permissions");
  await assertPermission(owner, "phoenix_crm", "approve");
  const { resolvePhoenixCrmViewer } = await import("@/lib/phoenix-crm/server/access");
  const viewer = await resolvePhoenixCrmViewer(owner);

  const { buildListTemplateFor, importListTemplate } = await import("@/lib/phoenix-crm/server/list-template");
  const rules = await import("@/lib/phoenix-crm/list-template-rules");
  const { excelCellText, loadExcelWorkbook } = await import("@/lib/uploads/exceljs-rows");

  const template = await buildListTemplateFor(viewer, plan.seatId, false);
  console.log(`Territory: ${plan.seatId} — ${customers.length} customer(s) to add, hours for ${hours.length} already waiting`);
  for (const row of customers) console.log(`  + ${row.listType ?? "?"}  ${row.name ?? "?"}  ${row.speciality ?? ""}  ${row.daysAndHours ?? ""}`);
  for (const row of hours) console.log(`  ~ ${row.listType ?? "?"}  ${row.name ?? "?"}  hours ${row.daysAndHours ?? ""}`);

  const workbook = await loadExcelWorkbook(new Uint8Array(template.buffer).buffer);
  const customerSheet = workbook.getWorksheet(rules.TEMPLATE_SHEET) ?? workbook.worksheets[0];
  if (!customerSheet) throw new Error("the template has no customer sheet");
  if (customers.length > 0) {
    fillSheetRows(customerSheet, rules.TEMPLATE_COLUMNS, rules.TEMPLATE_REQUIRED_KEYS, customers, rules.foldHeader, excelCellText);
  }
  if (hours.length > 0) {
    const existing = workbook.getWorksheet(rules.TEMPLATE_EXISTING_SHEET);
    if (!existing) throw new Error(`the template has no "${rules.TEMPLATE_EXISTING_SHEET}" sheet for the hours`);
    fillSheetRows(existing, rules.TEMPLATE_EXISTING_COLUMNS, ["listType", "name", "daysAndHours"], hours, rules.foldHeader, excelCellText);
  }
  const filled = Buffer.from(await workbook.xlsx.writeBuffer());

  const form = new FormData();
  form.set("file", new File([filled], template.fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  form.set("seatId", plan.seatId);
  const result = await importListTemplate(viewer, form);
  console.log(`\nThe app accepted it: ${result.loaded} customer(s) loaded, hours set for ${result.hoursSet}, ${result.refused.length} row(s) refused or skipped`);
  for (const refusal of result.refused) console.log(`  row ${refusal.row}: ${refusal.reason}`);

  if (plan.apply) {
    // The route's own audit line, word for word.
    const { writeAuditLog } = await import("@/lib/admin/audit");
    await writeAuditLog({
      actorLoginId: owner.loginId ?? null,
      entityId: result.seatId,
      entityType: "phoenix_crm_list_template_import",
      summary: `Loaded ${result.loaded} customer(s) onto the Phoenix CRM list for ${result.seatId} from a sheet (${result.refused.length} row(s) refused, days and hours set for ${result.hoursSet})`,
    });
  }

  // PROOF — the territory's rows for every name this run named, as the database holds them now. A proof
  // that cannot be read is exit 3, never a refusal: on --apply the write has already happened.
  try {
    await crmListProof(plan, customers, hours);
  } catch (error) {
    console.error(`\nPROOF NOT READ — ${errorText(error)}`);
    process.exitCode = 3;
  }
  return { employees: [] as string[], focus: {}, proofDone: true };
}

async function crmListProof(plan: Extract<OwnerOpsPlan, { job: "load-crm-list" }>, customers: CrmListRow[], hours: CrmListRow[]) {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const names = [...new Set([...customers, ...hours].map((row) => String(row.name ?? "").trim()).filter(Boolean))];
  const proof = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, list_type, name, speciality, status, origin, intake_where, intake_timings, created_at")
    .eq("seat_id", plan.seatId)
    .eq("is_test", false)
    .in("name", names);
  if (proof.error) throw proof.error;
  console.log(`\nPROOF — ${plan.seatId}: the rows named by this run${plan.apply ? "" : " (as they are NOW — the dry run changed nothing)"}`);
  for (const row of (proof.data ?? []) as Array<Record<string, unknown>>) {
    const timings = Array.isArray(row.intake_timings) ? `${row.intake_timings.length} sitting(s)` : "no hours";
    console.log(`  ${String(row.list_type)}  ${String(row.name)}  ${String(row.speciality ?? "")}  ${String(row.status)}  ${String(row.origin)}  ${timings}  ${String(row.intake_where ?? "")}  ${String(row.id)}`);
  }
}

/**
 * Waiting customers seated in an approved building that has a timetable, through
 * seatWaitingCustomersInVenue — the board then validates only those it names. The runner first reads the
 * building and every customer and says what the database would refuse, because a dry run's fenced RPC
 * never reaches the database's own checks.
 */
async function runSeatInBuilding(plan: Extract<OwnerOpsPlan, { job: "seat-in-building" }>, owner: AccessContext) {
  const { assertPermission } = await import("@/lib/auth/permissions");
  await assertPermission(owner, "phoenix_crm", "approve");
  const { resolvePhoenixCrmViewer } = await import("@/lib/phoenix-crm/server/access");
  const viewer = await resolvePhoenixCrmViewer(owner);
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");

  const building = await getSupabaseAdmin()
    .from("phoenix_crm_shared_places")
    .select("id, name, kind, status, seat_id, is_test, schedule_photo_path")
    .eq("id", plan.buildingId)
    .maybeSingle();
  if (building.error) throw building.error;
  const venue = building.data as Record<string, unknown> | null;
  if (!venue) fail(`--building ${plan.buildingId}: no such building`, 1);
  console.log(`Building: ${String(venue.name)} (${String(venue.kind)}, ${String(venue.status)}) on ${String(venue.seat_id)} — timetable ${venue.schedule_photo_path ? "on file" : "MISSING"}`);
  const preflight = await seatInBuildingRows(plan);
  const problems: string[] = [];
  if (String(venue.seat_id) !== plan.seatId) problems.push(`the building is on ${String(venue.seat_id)}, not ${plan.seatId}`);
  if (venue.status !== "active") problems.push(`the building is ${String(venue.status)}, not approved`);
  if (!venue.schedule_photo_path) problems.push("the building has no timetable on file");
  for (const id of plan.customerIds) {
    const row = preflight.customers.get(id);
    if (!row) problems.push(`${id}: no such customer`);
    else if (String(row.seat_id) !== plan.seatId) problems.push(`${String(row.name)}: on ${String(row.seat_id)}, not ${plan.seatId}`);
    else if (row.status !== "pending") problems.push(`${String(row.name)}: ${String(row.status)}, not waiting`);
    else if (row.list_type !== "AM" && row.list_type !== "PM") problems.push(`${String(row.name)}: a pharmacy`);
    else if ((preflight.places.get(id) ?? []).length > 0) problems.push(`${String(row.name)}: already has a place (move it instead)`);
    else if (!Array.isArray(row.intake_timings) || row.intake_timings.length === 0) problems.push(`${String(row.name)}: no hours`);
    else console.log(`  + ${String(row.list_type)}  ${String(row.name)}  ${(row.intake_timings as unknown[]).length} sitting(s)  ${id}`);
  }
  if (problems.length > 0) fail(`the database would refuse this seating:\n  ${problems.join("\n  ")}`, 1);

  const { seatWaitingCustomersInVenue } = await import("@/lib/phoenix-crm/server/place-move");
  const result = await seatWaitingCustomersInVenue(viewer, {
    seatId: plan.seatId,
    sharedPlaceId: plan.buildingId,
    customerIds: plan.customerIds,
    reason: plan.reason,
  });
  console.log(`\nThe app ${plan.apply ? "seated" : "would seat"} ${plan.apply ? result.seated.length : plan.customerIds.length} customer(s) in ${result.sharedPlaceName}; the board validated ${result.validated}`);

  if (plan.apply) {
    const { writeAuditLog } = await import("@/lib/admin/audit");
    await writeAuditLog({
      actorLoginId: owner.loginId ?? null,
      entityId: plan.buildingId,
      entityType: "phoenix_crm_seat_waiting_in_venue",
      summary: `Seated ${result.seated.length} waiting customer(s) in ${result.sharedPlaceName} on ${plan.seatId}; the timetable validated ${result.validated}`,
    });
  }

  try {
    const after = await seatInBuildingRows(plan);
    console.log(`\nPROOF — the customers as the database holds them now${plan.apply ? "" : " (the dry run changed nothing)"}`);
    for (const id of plan.customerIds) {
      const row = after.customers.get(id);
      const place = (after.places.get(id) ?? []).find((entry) => entry.shared_place_id === plan.buildingId);
      const verdict = place?.schedule_check && typeof place.schedule_check === "object" ? String((place.schedule_check as Record<string, unknown>).verdict ?? "") : "not read";
      console.log(`  ${String(row?.name ?? id)}  ${String(row?.status ?? "?")}  validated ${String(row?.validated_at ?? "—")}  place ${place ? String(place.id) : "none"}  board: ${place ? verdict : "—"}`);
    }
  } catch (error) {
    console.error(`
PROOF NOT READ — ${errorText(error)}`);
    process.exitCode = 3;
  }
  return { employees: [] as string[], focus: {}, proofDone: true };
}

async function seatInBuildingRows(plan: Extract<OwnerOpsPlan, { job: "seat-in-building" }>) {
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const customers = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, name, seat_id, status, list_type, intake_timings, validated_at")
    .in("id", plan.customerIds);
  if (customers.error) throw customers.error;
  const places = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select("id, customer_id, shared_place_id, schedule_check")
    .in("customer_id", plan.customerIds)
    .eq("status", "active");
  if (places.error) throw places.error;
  const byPlace = new Map<string, Array<Record<string, unknown>>>();
  for (const row of (places.data ?? []) as Array<Record<string, unknown>>) {
    const key = String(row.customer_id);
    byPlace.set(key, [...(byPlace.get(key) ?? []), row]);
  }
  return {
    customers: new Map(((customers.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), row])),
    places: byPlace,
  };
}

// ---------------------------------------------------------------------------------------------
// The rep tablets' own position agent (26 Nov 2026)
// ---------------------------------------------------------------------------------------------

/**
 * 🔴 THE SAME GATE THE SCREENS USE. Every Headwind route checks `company_devices / approve`
 * (app/api/devices/headwind/*), and these three jobs reach the same tables from the command line, so
 * they run that check as the owner rather than trusting that the command was typed by him.
 */
async function assertTabletDeskAccess(owner: AccessContext): Promise<void> {
  const { assertPermission } = await import("@/lib/auth/permissions");
  await assertPermission(owner, "company_devices", "approve");
}

function describePositionAgent(agent: {
  installId: string; deviceNumber: string | null; model: string | null; manufacturer: string | null;
  androidVersion: string | null; agentVersion: string | null; locationPermission: string | null;
  firstSeenAt: string; lastSeenAt: string; lastFixAt: string | null; fixesReceived: number;
  boundAt: string | null; boundByHrId: string | null; revokedAt: string | null; revokedReason: string | null;
}): string {
  const hardware = [agent.manufacturer, agent.model].filter(Boolean).join(" ") || "model not reported";
  const state = agent.revokedAt
    ? `OUT OF SERVICE since ${agent.revokedAt}${agent.revokedReason ? ` — ${agent.revokedReason}` : ""}`
    : agent.deviceNumber
      ? `bound to ${agent.deviceNumber}${agent.boundByHrId ? ` by ${agent.boundByHrId}` : ""}`
      : "NOT BOUND to a tablet yet";
  return [
    `  ${agent.installId}  ${state}`,
    `      ${hardware} · Android ${agent.androidVersion ?? "?"} · agent ${agent.agentVersion ?? "?"} · location permission ${agent.locationPermission ?? "not said"}`,
    `      first hello ${agent.firstSeenAt} · last call ${agent.lastSeenAt} · ${agent.fixesReceived} fix(es)`
      + ` · last fix ${agent.lastFixAt ?? "none"}`,
  ].join("\n");
}

async function runTabletAgents(owner: AccessContext) {
  await assertTabletDeskAccess(owner);
  const { listPositionAgents } = await import("@/lib/devices/positions/agents");
  const agents = await listPositionAgents();
  console.log(`\n${agents.length} Phoenix Position install(s) have said hello:`);
  if (agents.length === 0) {
    console.log("  none — no tablet is running the app yet, or none has reached this server.");
  }
  for (const agent of agents) console.log(describePositionAgent(agent));
  return { employees: [], focus: {}, proofDone: true };
}

async function runStartTabletAgent(plan: Extract<OwnerOpsPlan, { job: "start-tablet-agent" }>, owner: AccessContext) {
  await assertTabletDeskAccess(owner);
  const { startPositionAgentOnTablet } = await import("@/lib/devices/positions/start");
  const { getAgentForDevice } = await import("@/lib/devices/positions/agents");

  const before = await getAgentForDevice(plan.deviceNumber);
  console.log(`\nBefore: ${before ? `${plan.deviceNumber} already has an install bound` : `no install is bound to ${plan.deviceNumber}`}`);
  if (before) console.log(describePositionAgent(before));

  const started = await startPositionAgentOnTablet({ deviceNumber: plan.deviceNumber }, OWNER_LOGIN_ID);
  console.log(`\n${started.message}`);

  // PROOF — the install list as the desk reads it. A hello takes as long as the tablet takes to
  // receive the message, so a run that shows nothing new here has not failed: read it again in a
  // minute with `tablet-agents`.
  const { listPositionAgents } = await import("@/lib/devices/positions/agents");
  const agents = await listPositionAgents();
  console.log(`\nPROOF — ${agents.length} install(s) have said hello:`);
  if (agents.length === 0) console.log("  none yet — the tablet has not received the message or has not run the app");
  for (const agent of agents) console.log(describePositionAgent(agent));
  return { employees: [], focus: {}, proofDone: true };
}

async function runBindTabletAgent(plan: Extract<OwnerOpsPlan, { job: "bind-tablet-agent" }>, owner: AccessContext) {
  await assertTabletDeskAccess(owner);
  const { bindPositionAgent, getPositionAgent, listAgentFixes } = await import("@/lib/devices/positions/agents");
  const before = await getPositionAgent(plan.installId);
  console.log(`\nBefore:`);
  console.log(before ? describePositionAgent(before) : `  ${plan.installId}: no install has said hello with that id`);
  const bound = await bindPositionAgent({ actor: OWNER_LOGIN_ID, deviceNumber: plan.deviceNumber, installId: plan.installId });
  console.log("\nThe app accepted it:");
  console.log(describePositionAgent(bound));

  // PROOF — the tablet's own trail, read the way the Tablet Dashboard reads it. On a dry run the write
  // was answered without being sent, so this shows the trail as it still is.
  const trail = await listAgentFixes(plan.deviceNumber, 5);
  console.log(`\nPROOF — ${plan.deviceNumber}'s agent trail as the tablet page reads it:`);
  if (trail.error) console.log(`  could not be read: ${trail.error}`);
  else if (trail.fixes.length === 0) console.log("  no fix carries this tablet's number yet");
  for (const fix of trail.fixes) {
    console.log(`  ${fix.recordedAt}  ${fix.latitude}, ${fix.longitude}  ±${fix.accuracyM ?? "?"} m  battery ${fix.batteryLevel ?? "?"}%${fix.mock ? "  MOCK" : ""}`);
  }
  if (plan.apply && bound.deviceNumber !== plan.deviceNumber) {
    // Exit 3, never a refusal: the write has already happened, and "refused" would read as "nothing changed".
    console.error("\nPROOF FAILED — the bind reported success but the row does not name that tablet.");
    process.exitCode = 3;
  }
  return { employees: [], focus: {}, proofDone: true };
}

async function runRevokeTabletAgent(plan: Extract<OwnerOpsPlan, { job: "revoke-tablet-agent" }>, owner: AccessContext) {
  await assertTabletDeskAccess(owner);
  const { revokePositionAgent, getPositionAgent } = await import("@/lib/devices/positions/agents");
  const before = await getPositionAgent(plan.installId);
  console.log(`\nBefore:`);
  console.log(before ? describePositionAgent(before) : `  ${plan.installId}: no install has said hello with that id`);
  console.log(`Reason: ${plan.reason}`);
  const revoked = await revokePositionAgent({ actor: OWNER_LOGIN_ID, installId: plan.installId, reason: plan.reason });
  console.log("\nThe app accepted it:");
  console.log(describePositionAgent(revoked));
  if (plan.apply && !revoked.revokedAt) {
    console.error("\nPROOF FAILED — the install reported out of service but the row still has no revoked time.");
    process.exitCode = 3;
  }
  return { employees: [], focus: {}, proofDone: true };
}

async function runMatchAppVersion(plan: Extract<OwnerOpsPlan, { job: "match-app-version" }>, owner: AccessContext) {
  await assertTabletDeskAccess(owner);
  const { matchHeadwindVersionsToFiles, readHeadwindApplicationRow } = await import("@/lib/devices/headwind/versions");

  const before = await readHeadwindApplicationRow(plan.applicationId);
  console.log(
    `\nBefore: app ${plan.applicationId} — ${before.name ?? before.pkg} asks for ${before.version ?? "?"} / versionCode ${before.versionCode ?? "?"}`,
  );

  // 🔴 A DRY RUN'S WRITES ARE ANSWERED AND NEVER SENT, so the function's own read-back would find the
  // row unchanged and refuse over a change nobody made. It is told not to prove, and the proof below
  // reports itself as NOT DONE rather than as a pass.
  const done = await matchHeadwindVersionsToFiles(
    { applicationId: plan.applicationId, proveStored: plan.apply },
    OWNER_LOGIN_ID,
  );
  console.log(`\n${done.message}`);
  for (const match of [...done.changed, ...done.level]) {
    console.log(
      `  version ${match.versionId}  ${match.was.version ?? "?"} / ${match.was.versionCode ?? "?"}` +
        ` ${match.level ? "=" : "→"} ${match.now.version} / ${match.now.versionCode}  ${match.url}`,
    );
  }

  if (!plan.apply) {
    console.log(
      "\nPROOF NOT DONE — nothing was sent, so the row still asks for what it asked for. " +
        "Run it again with --apply to move the row and read it back.",
    );
    return { employees: [], focus: {}, proofDone: true };
  }

  // PROOF — the rows as the server holds them now, read again from scratch.
  const after = await matchHeadwindVersionsToFiles({ applicationId: plan.applicationId }, OWNER_LOGIN_ID);
  console.log(`\nPROOF — read again: ${after.message}`);
  if (after.changed.length) {
    console.error("\nPROOF FAILED — a second read still found a row that disagrees with its own file.");
    process.exitCode = 3;
  }
  return { employees: [], focus: {}, proofDone: true };
}

async function runLockRepTablets(plan: Extract<OwnerOpsPlan, { job: "lock-rep-tablets" }>, owner: AccessContext) {
  await assertTabletDeskAccess(owner);
  const { lockRepTablets, resolveHeadwindRules, setHeadwindRestrictions } = await import("@/lib/devices/headwind/configurations");
  const { describeTabletLock, MOBILE_DATA_CANNOT_BE_HELD, REP_TABLET_LOCK_SET } = await import("@/lib/devices/headwind/restrictions");

  console.log("\nThe locks, and what each costs a rep:");
  for (const token of REP_TABLET_LOCK_SET) console.log(`  ${describeTabletLock(token)}`);
  console.log(`\n🔴 ${MOBILE_DATA_CANNOT_BE_HELD}`);

  const rules = await resolveHeadwindRules("rep");
  console.log(`\nBefore — ${rules.length} rep set(s) of rules: ${rules.map((set) => `${set.name} (${set.id})`).join(", ")}`);

  // The dry run's PUT is answered by the fence, so the read-back is told to stand down (it would find
  // the old locks and refuse over a change nobody made) and the proof says so instead of passing.
  const done = await lockRepTablets(OWNER_LOGIN_ID, fetch, process.env, undefined, plan.apply);
  console.log(`\n${plan.apply ? "Done on" : "Would be done on"}: ${done.reached.join(", ")}`);
  for (const result of done.results) {
    console.log(`  ${result.name}: ${result.added.length ? `adds ${result.added.join(", ")}` : "already carried them all"}`);
    console.log(`      ${plan.apply ? "now" : "would be"}: ${result.restrictions.join(",")}`);
  }

  if (!plan.apply) {
    console.log("\nPROOF NOT DONE — nothing was sent to the tablet server. Run it again with --apply to lock and read back.");
    return { employees: [], focus: {}, proofDone: true };
  }

  // PROOF — every rep set carries every lock, read back off the server.
  const after = await resolveHeadwindRules("rep");
  const missing: string[] = [];
  for (const set of after) {
    const { restrictions } = await setHeadwindRestrictions({ add: [], configurationId: set.id }, OWNER_LOGIN_ID);
    for (const token of REP_TABLET_LOCK_SET) if (!restrictions.includes(token)) missing.push(`${set.name}: ${token}`);
  }
  console.log(`\nPROOF — ${missing.length ? `NOT on ${missing.join("; ")}` : "every rep set of rules carries every lock, read back off the server"}`);
  if (missing.length) {
    console.error("\nPROOF FAILED — a lock is missing from a rep set of rules, so those tablets are not protected.");
    process.exitCode = 3;
  }
  return { employees: [], focus: {}, proofDone: true };
}

async function runSyncInsuranceMaster(plan: Extract<OwnerOpsPlan, { job: "sync-insurance-master" }>, owner: AccessContext) {
  const { syncEmployeeMasterFromMedicalInsurance } = await import("@/lib/medical-insurance/service");
  const { MASTER_SYNC_FIELD_LABELS } = await import("@/lib/medical-insurance/master-sync");
  const result = await syncEmployeeMasterFromMedicalInsurance(owner);
  const verb = plan.apply ? "Filled" : "Would fill";
  console.log(`\nPolicy ${result.policyNumber ?? "(not numbered yet)"}, monthly cost of ${result.costMonth}. ${verb} ${result.updated.length} employee record(s):`);
  for (const update of result.updated) console.log(`  ${update.name} (${update.hrId}) — ${update.lines.join("; ")}`);
  if (result.unpriced.length > 0) {
    console.log(`\nCost not written — the module cannot price someone on their row (${result.unpriced.length}):`);
    for (const item of result.unpriced) console.log(`  ${item.name} (${item.hrId}) — ${item.people} person(s) unpriced`);
  }
  if (result.failed.length > 0) {
    console.log(`\nNot written (${result.failed.length}):`);
    for (const item of result.failed) console.log(`  ${item.name} (${item.hrId}) — ${item.error}`);
    process.exitCode = 1;
  }
  console.log(`\nDiffer on both sides — left for a person to settle (${result.differences.length}):`);
  for (const item of result.differences) {
    console.log(`  ${item.name} (${item.hrId}) — ${MASTER_SYNC_FIELD_LABELS[item.field]}: Employee Master ${item.master}, register ${item.register}`);
  }

  // The proof: the rows read back as the database holds them now.
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const hrIds = result.updated.map((update) => update.hrId);
  if (hrIds.length > 0) {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, medical_insurance, medical_insurance_number, national_id, birth_date, gender, mobile_number")
      .in("hr_id", hrIds);
    if (error) throw new Error(`the proof read failed: ${error.message}`);
    console.log(`\nPROOF — the Employee Master rows as they are now${plan.apply ? "" : " (the dry run changed nothing)"}:`);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) console.log(`  ${JSON.stringify(row)}`);
  }
  return { employees: [], focus: {}, proofDone: true };
}

async function runEndInsuranceCover(plan: Extract<OwnerOpsPlan, { job: "end-insurance-cover" }>, owner: AccessContext) {
  const { assertPermission } = await import("@/lib/auth/permissions");
  const { getMedicalInsuranceView, updateMedicalInsuranceMember } = await import("@/lib/medical-insurance/service");
  // The same check the Add/Remove screen's PATCH makes before it ends anyone.
  await assertPermission(owner, "medical_insurance", "update");
  const view = await getMedicalInsuranceView();
  if (!view) throw new Error("there is no medical insurance policy in force");
  const removals = new Map(view.actions.filter((action) => action.kind === "remove" && action.memberId && action.hrId).map((action) => [action.hrId!.toUpperCase(), action]));
  const chosen = plan.hrIds.map((hrId) => ({ action: removals.get(hrId.toUpperCase()) ?? null, hrId }));
  const missing = chosen.filter((item) => !item.action).map((item) => item.hrId);
  // Never a guessed end day: someone the screen does not list to remove is not this job's to end.
  if (missing.length > 0) throw new Error(`the Add/Remove screen lists no removal for ${missing.join(", ")} — nothing was ended`);
  const verb = plan.apply ? "Ending" : "Would end";
  const memberIds: string[] = [];
  for (const { action } of chosen) {
    const item = action!;
    console.log(`  ${verb} ${item.name} (${item.hrId}) — cover ends ${item.effectiveOn}${item.voidFromStart ? " (voided from its first day)" : ""}: ${item.reason}`);
    await updateMedicalInsuranceMember(owner, item.memberId!, { action: "end", coverageEnd: item.effectiveOn, endReason: item.reason });
    memberIds.push(item.memberId!);
  }

  // The proof: each person's row, and their family's, as the register holds them now.
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_members")
    .select("hr_id, full_name, member_type, coverage_starts_on, coverage_ends_on, end_reason")
    .or(`id.in.(${memberIds.join(",")}),principal_member_id.in.(${memberIds.join(",")})`);
  if (error) throw new Error(`the proof read failed: ${error.message}`);
  console.log(`\nPROOF — the register rows as they are now${plan.apply ? "" : " (the dry run changed nothing)"}:`);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) console.log(`  ${JSON.stringify(row)}`);
  return { employees: [], focus: {}, proofDone: true };
}

async function runReinstateInsuranceCover(plan: Extract<OwnerOpsPlan, { job: "reinstate-insurance-cover" }>, owner: AccessContext) {
  const { assertPermission } = await import("@/lib/auth/permissions");
  const { updateMedicalInsuranceMember } = await import("@/lib/medical-insurance/service");
  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  // The same check the register's PATCH makes before it puts anyone back.
  await assertPermission(owner, "medical_insurance", "update");
  const supabase = getSupabaseAdmin();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const { data: policies, error: policyError } = await supabase
    .from("medical_insurance_policies")
    .select("id, starts_on, ends_on")
    .lte("starts_on", today)
    .gte("ends_on", today);
  if (policyError) throw new Error(`the policy read failed: ${policyError.message}`);
  if ((policies ?? []).length !== 1) throw new Error(`expected one policy in force on ${today}, found ${(policies ?? []).length} — nothing was put back`);
  const policyId = (policies![0] as { id: string }).id;
  const hrIds = plan.hrIds.map((hrId) => hrId.toUpperCase());
  const { data, error } = await supabase
    .from("medical_insurance_members")
    .select("id, hr_id, full_name, coverage_ends_on, end_reason")
    .eq("policy_id", policyId)
    .eq("member_type", "employee")
    .in("hr_id", hrIds)
    .not("coverage_ends_on", "is", null);
  if (error) throw new Error(`the register read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; hr_id: string; full_name: string; coverage_ends_on: string; end_reason: string | null }>;
  // Every name is settled before anything is written, so a refusal changes nobody.
  const chosen = hrIds.map((hrId) => ({ hrId, rows: rows.filter((row) => row.hr_id.toUpperCase() === hrId) }));
  const none = chosen.filter((item) => item.rows.length === 0).map((item) => item.hrId);
  if (none.length > 0) throw new Error(`no ended cover on the policy in force for ${none.join(", ")} — nothing was put back`);
  const many = chosen.filter((item) => item.rows.length > 1).map((item) => item.hrId);
  if (many.length > 0) throw new Error(`more than one ended row for ${many.join(", ")}, so which to put back is the register's call — nothing was put back`);
  const verb = plan.apply ? "Putting back" : "Would put back";
  const memberIds: string[] = [];
  for (const { rows: [row] } of chosen) {
    console.log(`  ${verb} ${row.full_name} (${row.hr_id}) — ended ${row.coverage_ends_on}: ${row.end_reason ?? "no reason"}`);
    await updateMedicalInsuranceMember(owner, row.id, { action: "reinstate" });
    memberIds.push(row.id);
  }
  const { data: proof, error: proofError } = await supabase
    .from("medical_insurance_members")
    .select("hr_id, full_name, member_type, coverage_starts_on, coverage_ends_on, end_reason")
    .or(`id.in.(${memberIds.join(",")}),principal_member_id.in.(${memberIds.join(",")})`);
  if (proofError) throw new Error(`the proof read failed: ${proofError.message}`);
  console.log(`
PROOF — the register rows as they are now${plan.apply ? "" : " (the dry run changed nothing)"}:`);
  for (const row of (proof ?? []) as Array<Record<string, unknown>>) console.log(`  ${JSON.stringify(row)}`);
  return { employees: [], focus: {}, proofDone: true };
}

function describeDeskClaim(claim: import("@/lib/outstation/approvals/types").DeskClaim): string {
  return `claim ${claim.requestId} · ${claim.employeeName} (${claim.hrId ?? "no HR id"}) · ${claim.from} → ${claim.to} · ${claim.tripStart} to ${claim.tripEnd} · EGP ${claim.total} · ${claim.standing}${claim.decidedAt ? ` · decided ${claim.decidedAt}` : ""}${claim.locked ? " · LOCKED by payroll" : ""}`;
}

async function runRejectExpense(plan: Extract<OwnerOpsPlan, { job: "reject-expense" }>, owner: AccessContext) {
  const { loadDeskClaims } = await import("@/lib/outstation/approvals/queue");
  const { decideDeskClaims } = await import("@/lib/outstation/approvals/decide");
  // Read as the desk reads it, so the press carries the claim's own version (a claim that moved since
  // is refused by the same check a stale screen meets).
  const before = (await loadDeskClaims(owner, [plan.requestId])).get(plan.requestId);
  if (!before) throw new Error(`Expense Approvals shows no claim ${plan.requestId} to this owner — nothing was rejected`);
  console.log(`  ${plan.apply ? "Rejecting" : "Would reject"} ${describeDeskClaim(before)}`);
  console.log(`  Reason the employee reads: ${plan.reason}`);
  const [outcome] = await decideDeskClaims(owner, [{ action: "reject", comment: plan.reason, requestId: plan.requestId, revision: before.revision }]);
  if (!outcome) throw new Error("the desk answered nothing for this claim");
  // A dry run's writes never land, so the desk's own re-read finds the claim unchanged and answers
  // "not saved": that answer proves nothing either way, and the writes listed below are the reading.
  if (!plan.apply) console.log(`  (dry run: the desk's re-read cannot see a write the fence held back, so its "${outcome.code}" is not a verdict)`);
  else if (outcome.code !== "saved") throw new Error(`the desk answered ${outcome.code}: ${outcome.message ?? "no message"}`);
  const after = (await loadDeskClaims(owner, [plan.requestId])).get(plan.requestId);
  console.log(`
PROOF — the claim as it stands now${plan.apply ? "" : " (the dry run changed nothing)"}:`);
  console.log(`  ${after ? describeDeskClaim(after) : "could not be re-read"}${after?.hrComment ? ` · comment: ${after.hrComment}` : ""}`);
  return { employees: [], focus: {}, proofDone: true };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(OWNER_OPS_USAGE);
    return;
  }
  const parsed = parseOwnerOpsArgs(argv);
  if (!parsed.ok) {
    console.error(`owner-ops: REFUSED — ${parsed.error}\n`);
    console.error(OWNER_OPS_USAGE);
    process.exit(2);
  }
  const plan = parsed.plan;

  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https:\/\//, "").split(".")[0] ?? "";
  const database = KNOWN_PROJECTS[ref];
  if (!database) fail(`the database in this environment (${ref || "none"}) is neither production nor staging — load .env.local`, 2);

  // 🔴 Before ANY domain module is imported: a module that keeps `fetch` at import keeps the fenced one.
  const fenced: FencedWrite[] = [];
  if (plan.apply) {
    const { assertTreeIsCurrent } = await import("./lib/tree-is-current.ts");
    assertTreeIsCurrent("owner-ops");
  } else {
    installOwnerOpsDryRunFence(fenced);
  }

  console.log(`owner-ops ${plan.job} — ${plan.apply ? "APPLYING: this writes" : "DRY RUN: the job runs through the app's own checks and nothing is written"}`);
  console.log(`Database: ${database} (${ref})`);
  const owner = await liveAccessContext(OWNER_LOGIN_ID);
  console.log(`Acting as: ${owner.label}`);

  let outcome: { employees: string[]; focus: { doctorNames?: string[]; pharmacyIds?: string[] }; proofDone?: boolean } | null = null;
  let refused: string | null = null;
  try {
    if (plan.job === "link-doctor") outcome = await runLinkDoctor(plan, owner.access);
    else if (plan.job === "merge-venues") outcome = await runMergeVenues(plan, owner.access);
    else if (plan.job === "merge-customers") outcome = await runMergeCustomers(plan, owner.access);
    else if (plan.job === "remove-customer-pharmacy") outcome = await runRemoveCustomerPharmacy(plan, owner.access);
    else if (plan.job === "load-crm-list") outcome = await runLoadCrmList(plan, owner.access);
    else if (plan.job === "seat-in-building") outcome = await runSeatInBuilding(plan, owner.access);
    else if (plan.job === "tablet-agents") outcome = await runTabletAgents(owner.access);
    else if (plan.job === "start-tablet-agent") outcome = await runStartTabletAgent(plan, owner.access);
    else if (plan.job === "bind-tablet-agent") outcome = await runBindTabletAgent(plan, owner.access);
    else if (plan.job === "revoke-tablet-agent") outcome = await runRevokeTabletAgent(plan, owner.access);
    else if (plan.job === "match-app-version") outcome = await runMatchAppVersion(plan, owner.access);
    else if (plan.job === "lock-rep-tablets") outcome = await runLockRepTablets(plan, owner.access);
    else if (plan.job === "sync-insurance-master") outcome = await runSyncInsuranceMaster(plan, owner.access);
    else if (plan.job === "end-insurance-cover") outcome = await runEndInsuranceCover(plan, owner.access);
    else if (plan.job === "reinstate-insurance-cover") outcome = await runReinstateInsuranceCover(plan, owner.access);
    else if (plan.job === "reject-expense") outcome = await runRejectExpense(plan, owner.access);
    else outcome = await runPinPharmacy(plan, owner.access);
  } catch (error) {
    refused = errorText(error);
  }

  if (!plan.apply) {
    console.log(`\nWrites the dry run answered without sending (${fenced.length}):`);
    for (const write of fenced) console.log(`  ${write.method} ${write.target}${write.detail ? `  ${write.detail}` : ""}`);
  }

  if (refused) {
    console.error(`\nREFUSED by the app — nothing ${plan.apply ? "further was" : "would be"} written: ${refused}`);
    process.exitCode = 1;
    return;
  }

  const employees = outcome?.employees ?? [];
  if (employees.length === 0 && !outcome?.proofDone) {
    console.log("\nPROOF — no employee holds a doctor linked to this pharmacy, so no workspace to open (pass --employee).");
  }
  // A proof that could not be read is exit 3, never 1: on --apply the write has already happened, and
  // "refused" would read as "nothing changed".
  if (!plan.apply && employees.length > 0) console.log("\n(The proof below is the workspace as it is NOW — the dry run changed nothing.)");
  for (const hrId of employees) {
    try {
      await proofRead(hrId, outcome!.focus);
    } catch (error) {
      console.error(`\nPROOF NOT READ — ${hrId}'s workspace did not open: ${errorText(error)}`);
      process.exitCode = 3;
    }
  }
  console.log(plan.apply ? "\nWritten." : "\nDry run — nothing was written. Add --apply to write.");
}

await main();
