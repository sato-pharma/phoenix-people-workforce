import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SENSITIVE_KEYWORDS = ["salary", "payroll", "bank", "national id", "passport"];

function stripBlockComments(sql: string) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripLineComments(sql: string) {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export async function runContractNonRenewalTerminalTests() {
  const service = readFileSync("src/lib/contracts/service.ts", "utf8");
  const flags = readFileSync("src/lib/contracts/feature-flags.ts", "utf8");
  const email = readFileSync("src/lib/notifications/email.ts", "utf8");

  // (a) feature flag is literal false
  assert.match(
    flags,
    /export\s+const\s+WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED\s*=\s*false\s*;/,
    "feature flag must be defined as literal false",
  );

  // (b) service imports resignEmployeeAndOpenVacancy from the resignations service
  assert.match(
    service,
    /import\s*\{[^}]*resignEmployeeAndOpenVacancy[^}]*\}\s*from\s*["']@\/lib\/resignations\/service["']/,
    "service.ts must import resignEmployeeAndOpenVacancy from the resignations service",
  );

  // (c) service imports the feature flag from the feature-flags module
  assert.match(
    service,
    /import\s*\{[^}]*WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED[^}]*\}\s*from\s*["']\.\/feature-flags["']/,
    "service.ts must import WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED from ./feature-flags",
  );

  // (d) the call site is guarded by the feature flag (guard dominates the call).
  // We require at least one occurrence of the flag identifier appearing within a
  // reasonable window before any call to resignEmployeeAndOpenVacancy. The
  // import line is excluded by scanning every occurrence of the call.
  const guardWindowChars = 2000;
  const callIndices: number[] = [];
  let cursor = 0;
  while (true) {
    const next = service.indexOf("resignEmployeeAndOpenVacancy", cursor);
    if (next < 0) break;
    callIndices.push(next);
    cursor = next + 1;
  }
  // Filter out the import-statement occurrence so we only count actual call sites.
  const importLineRegex = /import[^;]*resignEmployeeAndOpenVacancy[^;]*;/g;
  const importRanges: Array<[number, number]> = [];
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importLineRegex.exec(service)) !== null) {
    importRanges.push([importMatch.index, importMatch.index + importMatch[0].length]);
  }
  const callSiteIndices = callIndices.filter(
    (idx) => !importRanges.some(([start, end]) => idx >= start && idx < end),
  );
  assert.ok(
    callSiteIndices.length > 0,
    "resignEmployeeAndOpenVacancy must be invoked at least once in service.ts (outside of imports)",
  );
  for (const callIdx of callSiteIndices) {
    const windowStart = Math.max(0, callIdx - guardWindowChars);
    const window = service.slice(windowStart, callIdx);
    assert.ok(
      /WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED/.test(window),
      `resignEmployeeAndOpenVacancy call at offset ${callIdx} must be guarded by WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED`,
    );
  }

  // (e) employeeStatus literal "terminated" is passed
  assert.match(
    service,
    /employeeStatus\s*:\s*"terminated"/,
    'service.ts must pass employeeStatus: "terminated" to the resignation helper',
  );

  // (f) reason / notes mention "Contract not renewed"
  assert.ok(
    /contract not renewed/i.test(service),
    'service.ts must mention "Contract not renewed" in the non-renewal terminal lifecycle path',
  );

  // (g) non-renew branch must not directly mutate the employees table
  assert.doesNotMatch(
    service,
    /from\(\s*["']employees["']\s*\)\s*\.update/,
    "non-renew branch must NOT bypass the resignation helper via a direct employees.update",
  );

  // (h) non-renew branch must not directly mutate app_auth_users
  assert.doesNotMatch(
    service,
    /from\(\s*["']app_auth_users["']\s*\)\s*\.update/,
    "non-renew branch must NOT directly mutate app_auth_users (use the resignation helper)",
  );

  // (i) existing renew + cancel branches and notifyContractWorkflow regression sentinel
  assert.match(service, /action === "renew"/, "renew branch must still exist");
  assert.match(service, /action === "cancel"/, "cancel branch must still exist (validateWorkflowTransition)");
  assert.match(
    service,
    /notifyContractWorkflow\s*\(/,
    "notifyContractWorkflow must still be called from runContractRenewalWorkflow",
  );

  // (j) email policy unchanged OR extended with FYI + employee opt-in; never references sensitive data.
  // Extract the policy object literal by walking back from the `type: "contract_renewal"`
  // marker to the nearest opening brace, then forward to the matching closing brace.
  const typeMarker = `type: "contract_renewal"`;
  const typeIdx = email.indexOf(typeMarker);
  assert.ok(typeIdx >= 0, "contract_renewal policy entry must remain in email.ts");
  // Walk back to the opening { of the policy object literal.
  let braceDepth = 0;
  let policyStart = -1;
  for (let i = typeIdx; i >= 0; i--) {
    const ch = email[i];
    if (ch === "}") braceDepth++;
    else if (ch === "{") {
      if (braceDepth === 0) {
        policyStart = i;
        break;
      }
      braceDepth--;
    }
  }
  assert.ok(policyStart >= 0, "could not locate the opening brace of the contract_renewal policy entry");
  // Walk forward to the matching closing brace.
  braceDepth = 0;
  let policyEnd = -1;
  for (let i = policyStart; i < email.length; i++) {
    const ch = email[i];
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        policyEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(policyEnd > policyStart, "could not locate the closing brace of the contract_renewal policy entry");
  const policyBlock = email.slice(policyStart, policyEnd);
  const policyLower = policyBlock.toLowerCase();
  const hasTrainingManager = policyLower.includes("training_manager") || policyLower.includes("training manager");
  const hasNotRenewedEmployeeOptIn =
    /not_?renewed/i.test(policyBlock) && /employee/i.test(policyBlock);
  if (hasTrainingManager || hasNotRenewedEmployeeOptIn) {
    // Extended policy: must mention both training_manager and employee opt-in.
    assert.ok(
      hasTrainingManager,
      "extended contract_renewal policy must mention training_manager as FYI recipient option",
    );
    assert.ok(
      hasNotRenewedEmployeeOptIn,
      "extended contract_renewal policy must mention employee notification opt-in for not_renewed",
    );
  }
  // Sensitive-data denylist: template strings must not leak salary/payroll/bank/ID data.
  for (const keyword of SENSITIVE_KEYWORDS) {
    assert.ok(
      !policyLower.includes(keyword),
      `contract_renewal policy template must not include sensitive keyword "${keyword}"`,
    );
  }

  // Silence unused-helper warnings under strict TS — these helpers are defined
  // for forward-compatibility when the policy block expands beyond a literal.
  void stripBlockComments;
  void stripLineComments;
}
