import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// Completing a resignation must leave the vacated seat with EXACTLY ONE open vacancy —
// never zero, never two.
//
// The invariant is enforced jointly by TypeScript and SQL, which is why this file reads both:
//
//   * NEVER ZERO is the database's job. runResignationWorkflow's "complete" action writes the
//     employee's terminal lifecycle row, and that UPDATE fires the `phx_employee_terminal_vacancy_guard`
//     trigger, which runs `phx_ensure_terminal_employee_vacancy` and opens the seat's vacancy.
//     Nothing in TypeScript says so, so nothing in TypeScript stops someone from narrowing the
//     trigger, dropping employment_status from the payload, or "simplifying" the guard away.
//
//   * NEVER TWO is the application's job. The guard has already run by the time control returns,
//     so an unconditional insert on the app side would add a SECOND open vacancy — under a
//     different code convention (vacancyCodeFromEmployee -> short code, guard -> VAC-TERM-…) so
//     not even the unique index on vacancy_code would catch it. The app may only insert after a
//     read has PROVEN no open vacancy exists.
//
// Verified against production (project ozucdzovmcqvepbozvqf) on 2026-08-01: employee_resignations
// carries zero triggers, so the ordinary createResignation path never creates a vacancy itself;
// all 31 live resignation rows came from the Employees-page path. Of 33 employees in a terminal
// lifecycle state, 24 have exactly one open vacancy and 7 have theirs already filled — the guard,
// not the resignations service, is what produces them.
export function runResignationCompletionVacancyTests() {
  const service = readFileSync(
    new URL("../src/lib/resignations/service.ts", import.meta.url),
    "utf8",
  );
  const directory = readFileSync(
    new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
    "utf8",
  );
  const baseline = readFileSync(
    new URL("../supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql", import.meta.url),
    "utf8",
  );

  const workflow = service.slice(
    service.indexOf("export async function runResignationWorkflow"),
    service.indexOf("export async function runResignationSlaDaily"),
  );
  assert.ok(workflow.length > 0, "runResignationWorkflow must exist and precede runResignationSlaDaily");

  // ── NEVER ZERO — the database guard must exist and stay armed ──────────────────────────────
  assert.match(
    baseline,
    /CREATE FUNCTION public\.phx_ensure_terminal_employee_vacancy\(p_employee_hr_id text\)/,
    "phx_ensure_terminal_employee_vacancy is the only thing that opens a vacancy when a resignation is completed through the workflow — it must stay in the schema",
  );

  const triggerDef = baseline.slice(baseline.indexOf("CREATE TRIGGER phx_employee_terminal_vacancy_guard"));
  const triggerStatement = triggerDef.slice(0, triggerDef.indexOf(";") + 1);
  assert.match(
    triggerStatement,
    /AFTER INSERT OR UPDATE OF [^;]*\bemployment_status\b[^;]*ON public\.employees/,
    "the terminal-vacancy guard must stay armed on employees.employment_status — that column is the ONLY lever the complete action has on the vacancy; narrow the trigger's column list and completing a resignation silently opens no vacancy at all",
  );
  assert.match(
    triggerStatement,
    /EXECUTE FUNCTION public\.phx_terminal_employee_vacancy_guard_trigger\(\)/,
    "the guard trigger must still dispatch to phx_terminal_employee_vacancy_guard_trigger",
  );

  // The trigger only opens a vacancy when the row it sees is terminal. employment_status is what
  // makes it terminal, so it must be written unconditionally — never added to the strippable
  // optional-column list, which the schema-tolerant retry loop deletes from the payload on error.
  const lifecycleFallback = service.slice(
    service.indexOf("async function updateEmployeeLifecycleFallback"),
    service.indexOf("async function normalizeTerminalEmployeeLifecycleFlags"),
  );
  assert.ok(lifecycleFallback.length > 0, "updateEmployeeLifecycleFallback must exist");
  assert.match(
    lifecycleFallback,
    /employment_status:\s*input\.employeeStatus,/,
    "updateEmployeeLifecycleFallback must write employment_status — it is what arms the terminal-vacancy guard",
  );
  const optionalColumns = lifecycleFallback.slice(
    lifecycleFallback.indexOf("const optionalColumns"),
    lifecycleFallback.indexOf("const payload"),
  );
  assert.doesNotMatch(
    optionalColumns,
    /"employment_status"/,
    "employment_status must never become a strippable optional column — if the retry loop drops it the UPDATE still fires the guard, but the row is not terminal, so the guard returns employee_not_terminal and the seat gets NO vacancy",
  );

  assert.match(
    workflow,
    /if \(action === "complete"\)[\s\S]*?updateEmployeeLifecycleFallback\(/,
    "completing a resignation must write the terminal lifecycle row — that write is what opens the vacancy",
  );

  // ── NEVER TWO — the guard adopts before it inserts ─────────────────────────────────────────
  const guardBody = baseline.slice(
    baseline.indexOf("CREATE FUNCTION public.phx_ensure_terminal_employee_vacancy"),
    baseline.indexOf("CREATE FUNCTION public.phx_ensure_terminal_employee_vacancy") + 6000,
  );
  const guardLookupAt = guardBody.indexOf("into v_existing_vacancy_id");
  const guardInsertAt = guardBody.indexOf("insert into public.position_vacancies");
  assert.ok(guardLookupAt > -1, "the guard must look up an existing open vacancy for the seat");
  assert.ok(guardInsertAt > -1, "the guard must be able to open a vacancy when the seat has none");
  assert.ok(
    guardLookupAt < guardInsertAt,
    "the guard must look for the seat's existing OPEN vacancy before inserting one — reorder these and every terminal-lifecycle write opens a duplicate seat",
  );
  assert.match(
    guardBody.slice(guardLookupAt, guardInsertAt),
    /if v_existing_vacancy_id is not null then/,
    "the guard's insert must sit in the else-branch of the existing-vacancy check (adopt, else open)",
  );

  // ── NEVER TWO — the app only inserts after proving the seat has none ───────────────────────
  const linker = service.slice(
    service.indexOf("async function linkCompletedResignationVacancy"),
    service.indexOf("async function resignEmployeeWithFallback"),
  );
  assert.ok(
    linker.length > 0,
    "linkCompletedResignationVacancy must exist and be declared before resignEmployeeWithFallback",
  );

  assert.match(
    workflow,
    /if \(action === "complete"\)[\s\S]*?linkCompletedResignationVacancy\(/,
    "the complete action must reconcile the seat's vacancy through linkCompletedResignationVacancy",
  );
  assert.doesNotMatch(
    workflow,
    /insertFallbackVacancy\(/,
    "runResignationWorkflow must never insert a vacancy inline — the database guard has already opened one by the time the lifecycle write returns, so an inline insert is a guaranteed duplicate open seat",
  );

  const lookupAt = linker.indexOf("findOpenVacancyForSeat(");
  const insertAt = linker.indexOf("insertFallbackVacancy(");
  assert.ok(lookupAt > -1, "linkCompletedResignationVacancy must read the seat's open vacancy back");
  assert.ok(insertAt > -1, "linkCompletedResignationVacancy must be able to open a vacancy when the guard is absent");
  assert.ok(
    lookupAt < insertAt,
    "the seat lookup must run BEFORE any insert — inserting first is exactly the duplicate this module exists to prevent",
  );
  assert.match(
    linker,
    /if \(!lookup\.resolved\) return;/,
    "an unresolved vacancy read must fail CLOSED — reporting 'no vacancy exists' from a read that failed would make the caller open a second seat",
  );
  assert.match(
    linker,
    /if \(input\.resignationVacancyId\) return;/,
    "a resignation already linked to a vacancy (the Employees-page path) must be left alone",
  );
  assert.match(
    linker,
    /vacancyCodeFromEmployee\(/,
    "the fallback insert must use the same vacancy-code convention as the Employees-page fallback",
  );

  // The guard matches on lower(coalesce(status,'open')) = 'open'. The read-back must normalize the
  // same way, or a NULL/'Open' row reads as "no open vacancy" and the fallback opens a second one.
  const seatLookup = service.slice(
    service.indexOf("async function findOpenVacancyForSeat"),
    service.indexOf("async function linkCompletedResignationVacancy"),
  );
  assert.ok(seatLookup.length > 0, "findOpenVacancyForSeat must exist and be declared before linkCompletedResignationVacancy");
  assert.match(
    seatLookup,
    /\.eq\("replacement_for_hr_id", employeeHrId\)/,
    "the seat lookup must be scoped to the vacated seat's employee",
  );
  assert.match(
    seatLookup,
    /\?\?\s*"open"\)[\s\S]{0,40}?\.toLowerCase\(\)\s*===\s*"open"/,
    "the seat lookup must normalize status the way the SQL guard does (lower(coalesce(status,'open'))) — a NULL or 'Open' row must count as open, or the fallback opens a duplicate",
  );

  // ── THE LINK — vacancy_id is what resolves "who does this vacancy replace" ─────────────────
  assert.match(
    linker,
    /\.from\("employee_resignations"\)[\s\S]{0,200}?vacancy_id:/,
    "the completed resignation row must be stamped with the seat's vacancy_id",
  );
  assert.match(
    directory,
    /employee_resignations\?\$\{new URLSearchParams\(\{[\s\S]*?vacancy_id:\s*`eq\.\$\{vacancyId\}`/,
    "employee-directory's replacementForVacancy resolves the departing employee through employee_resignations.vacancy_id — that consumer is why the link is stamped; if it moves, revisit linkCompletedResignationVacancy",
  );
}
