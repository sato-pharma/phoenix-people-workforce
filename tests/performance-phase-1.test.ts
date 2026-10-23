import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { managerNamesFromEmployeeRows, REFERENCE_LIST_TTL_MS } from "../src/lib/employees/employee-directory.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Performance phase 1 (2026-10-23): fewer database calls for the same answers.
//
// Measured on production from the edge logs over 24 h, before the change:
//   - every employee-directory load (~4,200 a day) re-read the managers' names (~374 ms) and the
//     pending-replacement list (~388 ms) the load's own employee select could carry;
//   - the reference lists (departments, lines, areas, positions, teams) were re-read on every load;
//   - the rep visits page read the whole company's check-ins for the month and threw away all but one
//     rep's, and read the rep directory twice, the second time in front of the visit list;
//   - the probation reminder run wrote ~8,900 upserts a day into notification_events, and ZERO probation
//     events were created in the same 24 h — every one was an ignoreDuplicates no-op.
//
// Each pin below names what it holds, and each one is handed a broken copy and must fire.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** What is missing from employee-directory.ts's phase-1 shape. Comments are stripped first. */
export function directoryPhase1Missing(source: string): string[] {
  const code = stripComments(source).replace(/\r\n/g, "\n");
  const missing: string[] = [];

  // The three directory loads build manager names from rows they already hold, never a second read.
  const builderCalls = code.match(/Promise\.resolve\(managerNamesFromEmployeeRows\(employeeRows\)\)/g) ?? [];
  if (builderCalls.length !== 3) {
    missing.push(`the three directory loads must build manager names from their own rows (found ${builderCalls.length})`);
  }
  const loadManagerNamesCalls = (code.match(/\bloadManagerNames\(/g) ?? []).length;
  // One definition plus the new-hire vacancy close, which needs a fresh read on a write path.
  if (loadManagerNamesCalls > 2) missing.push("loadManagerNames must stay on the new-hire write path only");

  // The pending-replacement column rides on the employee select in both loaders.
  const pendingAppends = code.match(/,\$\{PENDING_REPLACEMENT_COLUMN\}`/g) ?? [];
  if (pendingAppends.length !== 2) {
    missing.push(`both employee selects must carry the pending-replacement column (found ${pendingAppends.length})`);
  }

  // Reference lookups are cut from the shared list, never an `id=in.(...)` read per load.
  const lookup = code.match(/async function loadLookup\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/loadReferenceNameMap\(table, label\)/.test(lookup)) missing.push("loadLookup must read the shared reference list");
  if (/supabaseRest|idInFilter/.test(lookup)) missing.push("loadLookup must not read the table itself");
  const options = code.match(/async function loadAllOptions\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/cachedReferenceList\(/.test(options)) missing.push("loadAllOptions must go through the reference-list cache");
  if (!/options\.map\(\(option\) => \(\{ \.\.\.option \}\)\)/.test(options)) {
    missing.push("loadAllOptions must hand each caller its own copies");
  }

  // A write clears the reference lists with the directory, and a load a write overtook is not kept.
  const invalidate = code.match(/export function invalidateEmployeeDirectoryCache\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/invalidateReferenceLists\(\);/.test(invalidate)) {
    missing.push("invalidateEmployeeDirectoryCache must also clear the reference lists");
  }
  const cache = code.match(/async function cachedReferenceList<T>\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/startedGeneration === referenceListGeneration/.test(cache)) {
    missing.push("a reference-list load overtaken by a write must not be stored");
  }
  if (!/referenceListInFlight/.test(cache)) missing.push("the reference-list cache must load one copy at a time");
  return missing;
}

/** What is missing from probation/service.ts's skip of already-stored reminder keys. */
export function probationPhase1Missing(source: string): string[] {
  const code = stripComments(source).replace(/\r\n/g, "\n");
  const missing: string[] = [];
  const run = code.match(/export async function processDueProbationReminderEvents\([\s\S]*?\n}\n/)?.[0] ?? "";
  const keyRead = run.indexOf("await loadStoredProbationEventKeys(");
  const ensures = run.indexOf("await Promise.all(\n    probationEmployees.map(");
  if (keyRead < 0) missing.push("the reminder run must read the stored keys once");
  else if (ensures >= 0 && keyRead > ensures) missing.push("the stored keys must be read before the ensure calls");
  if (!/ensureProbationReminderEvents\(employee, employees, lookups, storedKeys\)/.test(run)) {
    missing.push("the scheduled reminders must be handed the stored keys");
  }
  if (!/ensureOverdueProbationReminderEvents\(employee, row, employees, lookups, storedKeys\)/.test(run)) {
    missing.push("the overdue reminder must be handed the stored keys");
  }

  const scheduled = code.match(/async function ensureProbationReminderEvents\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/storedKeys \? rows\.filter\(\(row\) => !storedKeys\.has\(row\.event_key\)\) : rows/.test(scheduled)) {
    missing.push("the scheduled reminders must leave out keys already stored");
  }
  if (!/\.upsert\(missingRows, \{ onConflict: "event_key", ignoreDuplicates: true \}\)/.test(scheduled)) {
    missing.push("the scheduled upsert must write only the missing rows, still with ignoreDuplicates");
  }
  const overdue = code.match(/async function ensureOverdueProbationReminderEvents\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/storedKeys\?\.has\(overdueProbationReminderEventKey\(employee\.hrId, probationEndDate, plan\.weekBucket\)\)\) return;/.test(overdue)) {
    missing.push("the overdue reminder must skip a week already stored");
  }
  if (!/ignoreDuplicates: true/.test(overdue)) missing.push("the overdue upsert must keep ignoreDuplicates");

  // A failed key read falls back to writing every row — never to skipping one.
  const loader = code.match(/async function loadStoredProbationEventKeys\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/if \(error\) return null;/.test(loader)) missing.push("a failed key read must return null so every row is written");
  if (!/\?\? undefined;/.test(run)) missing.push("a null key read must reach the ensure calls as no stored keys");
  if (!/\.eq\("category", "probation"\)/.test(loader)) missing.push("the key read must stay on the probation category");
  if (!/page\.length < STORED_PROBATION_KEY_PAGE/.test(loader)) missing.push("the key read must page to the end");
  return missing;
}

/** What is missing from the rep visits page's read cuts (rep-visits-data.ts and rep-visits-page.tsx). */
export function repVisitsPhase1Missing(dataSource: string, pageSource: string): string[] {
  const data = stripComments(dataSource).replace(/\r\n/g, "\n");
  const page = stripComments(pageSource).replace(/\r\n/g, "\n");
  const missing: string[] = [];

  // The check-ins read is narrowed at the database by the CRM id the filter below already narrows by.
  const checkinRead = data.match(/queryCheckins<CheckinRow>\(\{[\s\S]*?\n    \}\)/)?.[0] ?? "";
  if (!/\.\.\.\(input\.agentCrmId != null \? \{ agentCrmIds: \[input\.agentCrmId\] \} : \{\}\)/.test(checkinRead)) {
    missing.push("a rep with a CRM id must have the check-ins read narrowed to that id");
  }
  if (/agentHrId/.test(checkinRead)) {
    missing.push("the check-ins read must never narrow by hr id at the database");
  }
  // The post-filter stays: it is what keeps the narrowed read and the company-wide read equal.
  if (!/checkins\.filter\(\(checkin\) => checkin\.agent_crm_id === input\.agentCrmId\)/.test(data)) {
    missing.push("the CRM-id post-filter on check-ins must stay");
  }
  if (!/canonicalHrIdKey\(checkin\.agent_hr_id\) === hrKey/.test(data)) {
    missing.push("a rep with only an hr id must still be matched by the canonical key");
  }

  // The partner names reuse the directory read the page already made, never a second one.
  if (/partnerNameByHrId: await loadRepNamesByHrId\(/.test(page)) {
    missing.push("the partner names must reuse the page's own directory read");
  }
  if (!/partnerNameByHrId = repNameByHrId;/.test(page)) missing.push("the page must keep its directory read for the partner names");
  if ((page.match(/\bloadRepNamesByHrId\(/g) ?? []).length > 1) {
    missing.push("the page must read the rep names once");
  }
  return missing;
}

/** Replace one exact fragment and require that it was there. */
function breakCopy(source: string, from: string | RegExp, to: string): string {
  const broken = source.replace(from, to);
  assert.notEqual(broken, source, `the broken copy must actually change the source: ${String(from)}`);
  return broken;
}

function assertFires(missing: string[], expected: string, label: string) {
  assert.ok(
    missing.some((entry) => entry.startsWith(expected)),
    `${label}: expected the pin "${expected}" to fire, got ${JSON.stringify(missing)}`,
  );
}

export async function runPerformancePhase1Tests() {
  // ── Behaviour: the manager-name builder gives the old lookup's keys and withholds a leaver's name.
  const names = managerNamesFromEmployeeRows([
    { hr_id: "PD-0031", full_name: "Test Manager One", nickname: null, employment_status: "active" },
    { hr_id: "pd-0040", full_name: "Test Manager Two", nickname: null, employment_status: "on_leave" },
    { hr_id: "PD-0050", full_name: "Test Leaver", nickname: null, employment_status: "resigned" },
  ]);
  assert.equal(names.get("PD-0031"), "Test Manager One", "an active manager is named by the raw hr_id");
  assert.equal(names.get("pd-0031"), "Test Manager One", "and by its lower-case lookup key");
  assert.equal(names.get("PD-0040"), "Test Manager Two", "a manager on leave is still named, by the upper-case key");
  assert.equal(names.has("PD-0050"), false, "a leaver's name is never a live manager label");
  assert.equal(names.has("pd-0050"), false, "under any lookup key");

  assert.equal(REFERENCE_LIST_TTL_MS, 60_000, "the reference lists are bounded at one minute");

  // ── The directory pins hold on the real source, and each fires on its broken copy.
  const directory = read("../src/lib/employees/employee-directory.ts");
  assert.deepEqual(directoryPhase1Missing(directory), [], "the directory keeps every phase-1 read cut");
  assertFires(
    directoryPhase1Missing(breakCopy(directory, "Promise.resolve(managerNamesFromEmployeeRows(employeeRows))", "loadManagerNames(managerHrIds)")),
    "the three directory loads must build manager names",
    "a directory load back on the separate manager read",
  );
  assertFires(
    directoryPhase1Missing(breakCopy(directory, /,\$\{PENDING_REPLACEMENT_COLUMN\}`/, "`")),
    "both employee selects must carry the pending-replacement column",
    "a select that drops the pending column",
  );
  assertFires(
    directoryPhase1Missing(breakCopy(directory, "const all = await loadReferenceNameMap(table, label);", "const all = await supabaseRest<LookupRow[]>(table);")),
    "loadLookup must read the shared reference list",
    "a lookup back on its own read",
  );
  assertFires(
    directoryPhase1Missing(breakCopy(directory, /directoryRowsCache\.clear\(\);\n  invalidateReferenceLists\(\);/, "directoryRowsCache.clear();")),
    "invalidateEmployeeDirectoryCache must also clear the reference lists",
    "an invalidation that forgets the reference lists",
  );
  assertFires(
    directoryPhase1Missing(breakCopy(directory, "if (startedGeneration === referenceListGeneration) {", "if (true) {")),
    "a reference-list load overtaken by a write must not be stored",
    "a cache that keeps a load a write overtook",
  );
  assertFires(
    directoryPhase1Missing(breakCopy(directory, "return options.map((option) => ({ ...option }));", "return options;")),
    "loadAllOptions must hand each caller its own copies",
    "a shared option list handed out by reference",
  );

  // ── The probation pins hold on the real source, and each fires on its broken copy.
  const probation = read("../src/lib/probation/service.ts");
  assert.deepEqual(probationPhase1Missing(probation), [], "the reminder run skips only the keys already stored");
  assertFires(
    probationPhase1Missing(breakCopy(probation, "storedKeys ? rows.filter((row) => !storedKeys.has(row.event_key)) : rows", "rows")),
    "the scheduled reminders must leave out keys already stored",
    "a run that rewrites every stored reminder",
  );
  assertFires(
    probationPhase1Missing(breakCopy(probation, "ensureOverdueProbationReminderEvents(employee, row, employees, lookups, storedKeys)", "ensureOverdueProbationReminderEvents(employee, row, employees, lookups)")),
    "the overdue reminder must be handed the stored keys",
    "an overdue call that never sees the stored keys",
  );
  assertFires(
    probationPhase1Missing(breakCopy(probation, "if (error) return null;\n    const page", "if (error) return keys;\n    const page")),
    "a failed key read must return null",
    "a failed read that would skip reminders",
  );
  assertFires(
    probationPhase1Missing(breakCopy(probation, /\.upsert\(missingRows, \{ onConflict: "event_key", ignoreDuplicates: true \}\)/, '.upsert(missingRows, { onConflict: "event_key" })')),
    "the scheduled upsert must write only the missing rows, still with ignoreDuplicates",
    "an upsert that would start overwriting stored reminders",
  );

  // ── The rep visits pins hold on the real source, and each fires on its broken copy.
  const repData = read("../src/lib/crm/rep-visits-data.ts");
  const repPage = read("../src/components/crm/rep-visits-page.tsx");
  assert.deepEqual(repVisitsPhase1Missing(repData, repPage), [], "the rep visits page keeps its narrowed reads");
  assertFires(
    repVisitsPhase1Missing(breakCopy(repData, "...(input.agentCrmId != null ? { agentCrmIds: [input.agentCrmId] } : {}),\n    }),\n    loadCrmRegionTerritoryIndex()", "}),\n    loadCrmRegionTerritoryIndex()"), repPage),
    "a rep with a CRM id must have the check-ins read narrowed",
    "a check-ins read back on the whole company",
  );
  assertFires(
    repVisitsPhase1Missing(breakCopy(repData, "...(input.agentCrmId != null ? { agentCrmIds: [input.agentCrmId] } : {}),\n    }),\n    loadCrmRegionTerritoryIndex()", "...(input.agentCrmId != null ? { agentCrmIds: [input.agentCrmId] } : {}),\n      ...(hrId ? { agentHrIdILike: hrId } : {}),\n    }),\n    loadCrmRegionTerritoryIndex()"), repPage),
    "the check-ins read must never narrow by hr id",
    "a check-ins read narrowed by an hr id spelling",
  );
  assertFires(
    repVisitsPhase1Missing(breakCopy(repData, "checkins.filter((checkin) => checkin.agent_crm_id === input.agentCrmId)", "checkins"), repPage),
    "the CRM-id post-filter on check-ins must stay",
    "a narrowed read that drops its post-filter",
  );
  assertFires(
    repVisitsPhase1Missing(repData, breakCopy(repPage, "      partnerNameByHrId,\n", "      partnerNameByHrId: await loadRepNamesByHrId().catch(() => undefined),\n")),
    "the partner names must reuse the page's own directory read",
    "a page back on a second directory read",
  );
}
