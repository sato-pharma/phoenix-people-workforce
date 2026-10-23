import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Item D: the outstation employee-lookup route silently showed a resigned/terminated HR_ID
 * as a plain "found" match, identical to an active employee. This is cosmetic-only (the real
 * submit/validation path never reads this state), but an admin adding a manual outstation
 * expense should see that the matched employee isn't currently active.
 */
export function runOutstationEmployeeLookupStatusTests() {
  const route = readFileSync("app/api/admin/outstation/employee-lookup/route.ts", "utf8");
  const component = readFileSync("src/components/outstation/admin-manager-expense-modal.tsx", "utf8");

  // The route must import the canonical terminal-status predicate and derive isActive from it,
  // while keeping the existing raw status field as-is.
  assert.match(
    route,
    /import \{[^}]*\bisTerminalEmploymentStatus\b[^}]*\} from "@\/lib\/auth\/session-lifecycle";/,
    "employee-lookup route must import isTerminalEmploymentStatus",
  );
  assert.match(
    route,
    /isActive: !isTerminalEmploymentStatus\(data\.employment_status\),/,
    "employee-lookup route must return isActive derived from the canonical terminal-status predicate",
  );
  assert.match(
    route,
    /status: data\.employment_status,/,
    "employee-lookup route must keep the existing raw status field",
  );

  // The component's EmployeeLookup "found" variant must carry isActive.
  assert.match(
    component,
    /\| \{ status: "found"; name: string; jobTitle: string \| null; isActive: boolean \}/,
    "EmployeeLookup 'found' variant must include isActive: boolean",
  );

  // lookupEmployee() must widen the fetch-response type and pass isActive through, defaulting
  // to true (cosmetic-only, not a security control) whenever the field is ever absent.
  assert.match(
    component,
    /isActive\?:\s*boolean;/,
    "lookupEmployee's destructured fetch-response type must include isActive?: boolean",
  );
  assert.match(
    component,
    /isActive: payload\.isActive !== false,/,
    "lookupEmployee must pass isActive through to setEmployeeLookup, defaulting to true when absent",
  );

  // The initialName prefill path (already-existing request, no fresh lookup data) must preserve
  // its current behavior exactly by defaulting to isActive: true.
  assert.match(
    component,
    /initialName \? \{ status: "found", name: initialName, jobTitle: null, isActive: true \} : \{ status: "idle" \}/,
    "the initialName prefill path must default isActive to true",
  );

  // A new amber/warning-styled branch must render when a found employee is not active,
  // distinct from (and in addition to) the existing green "found" style.
  assert.match(
    component,
    /employeeLookup\.status === "found" && employeeLookup\.isActive/,
    "the found+active render branch must gate on employeeLookup.isActive",
  );
  assert.match(
    component,
    /employeeLookup\.status === "found" && !employeeLookup\.isActive/,
    "a new found+inactive render branch must exist",
  );
  assert.match(
    component,
    /Found — but not currently active/,
    "the inactive-found branch must render the expected warning copy",
  );

  // Purely cosmetic: handleSubmit must not read employeeLookup state for gating.
  const submitStart = component.indexOf("async function handleSubmit(");
  assert.ok(submitStart >= 0, "could not locate handleSubmit in the component");
  const submitEnd = component.indexOf("\n  const canSubmit =", submitStart);
  assert.ok(submitEnd > submitStart, "could not locate the end of handleSubmit");
  const handleSubmitBody = component.slice(submitStart, submitEnd);
  assert.doesNotMatch(
    handleSubmitBody,
    /employeeLookup/,
    "handleSubmit must not read employeeLookup state — isActive is cosmetic-only, not a submit gate",
  );
}
