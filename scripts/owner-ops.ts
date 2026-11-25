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
//   pin-pharmacy  the desk-entry pin: captured_latitude/longitude/at on marketing_pharmacies with
//                 evidence_status 'pending' (no shop photo). No route writes this; the 25 Nov pins were
//                 one hand UPDATE, so it is done here with that UPDATE's own guard (no pin yet) plus a
//                 live venue and a coordinate inside Egypt.
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

  let outcome: { employees: string[]; focus: { doctorNames?: string[]; pharmacyIds?: string[] } } | null = null;
  let refused: string | null = null;
  try {
    if (plan.job === "link-doctor") outcome = await runLinkDoctor(plan, owner.access);
    else if (plan.job === "merge-venues") outcome = await runMergeVenues(plan, owner.access);
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
  if (employees.length === 0) {
    console.log("\nPROOF — no employee holds a doctor linked to this pharmacy, so no workspace to open (pass --employee).");
  }
  // A proof that could not be read is exit 3, never 1: on --apply the write has already happened, and
  // "refused" would read as "nothing changed".
  if (!plan.apply) console.log("\n(The proof below is the workspace as it is NOW — the dry run changed nothing.)");
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
