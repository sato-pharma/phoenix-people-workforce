import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// The CRM "single door" invariant (Phase 3 of the CRM single-source module).
//
// NO module outside src/lib/crm/ may run its own query against the iReports360 mirror tables
// (ireports360_visits / _checkins / _visits_sync_runs / _crm_identity_resolutions / _plan_entries
// and the _visits_effective view). Every consumer reads CRM data through the crm/reads.ts service
// functions instead, so the CRM module is the only code that touches the feed. This test fails
// loudly if a raw mirror `.from(...)` reappears anywhere else — the regression guard that keeps
// the centralization from eroding one convenient query at a time.
//
// INSIDE src/lib/crm/ the exemption used to be blanket, which is how two consumer reads
// (visit-workload.ts, visit-partners.ts) queried the visits mirror directly for months. It is now an
// explicit allow-list of the machinery that legitimately writes, reconciles, probes or administers
// the mirror. The native-visits cutover will union vendor history with native rows in ONE place (the
// read door), so a new consumer file reaching the visits table directly must fail here.

// `.from("ireports360_...")` — a raw string-literal mirror query.
//
// The CRM cutover's three unified views (crm_visits_unified, crm_checkins_unified,
// crm_plan_entries_unified) ARE the mirror from a reader's point of view — vendor history plus native
// rows — so they sit behind the same door and the same allow-lists as the tables they union.
const literalFrom =
  /\.from\(\s*["'`](?:ireports360_(?:visits|checkins|visits_sync_runs|crm_identity_resolutions|plan_entries|visits_effective)|crm_(?:visits|checkins|plan_entries)_unified|crm_visits_checkin_flags)\b/;
// `.from(SOME_CONST)` where the const names a mirror table — the migrated local consts plus the
// canonical crm/tables constants (importing those into a non-CRM file and querying would bypass
// the door just as surely as a string literal).
const constFrom =
  /\.from\(\s*(?:visitsTable|checkinsTable|DV_SOURCE_TABLE|VISITS_MIRROR_TABLE|CRM_VISITS_TABLE|CRM_CHECKINS_TABLE|CRM_SYNC_RUNS_TABLE|CRM_IDENTITY_RESOLUTIONS_TABLE|CRM_PLAN_ENTRIES_TABLE|CRM_VISITS_EFFECTIVE_VIEW|CRM_VISITS_CHECKIN_FLAGS_VIEW|CRM_VISITS_UNIFIED_VIEW|CRM_CHECKINS_UNIFIED_VIEW|CRM_PLAN_ENTRIES_UNIFIED_VIEW)\s*\)/;

// Inside src/lib/crm/: any reference to the VISITS mirror — a literal/local-const `.from`, or ANY use
// of the canonical visits constants (which also catches `.from(table)` indirection over a list).
const visitsMirrorRef: RegExp[] = [
  /\.from\(\s*["'`](?:ireports360_visits(?:_effective)?|crm_visits_unified|crm_visits_checkin_flags)\b/,
  /\.from\(\s*visitsTable\s*\)/,
  /\b(?:CRM_VISITS_TABLE|CRM_VISITS_EFFECTIVE_VIEW|CRM_VISITS_CHECKIN_FLAGS_VIEW|CRM_VISITS_UNIFIED_VIEW)\b/,
];
// Inside src/lib/crm/: any reference to the OTHER mirror tables (check-ins, sync runs, identity
// resolutions, plan entries).
const otherMirrorRef: RegExp[] = [
  /\.from\(\s*["'`](?:ireports360_(?:checkins|visits_sync_runs|crm_identity_resolutions|plan_entries)|crm_(?:checkins|plan_entries)_unified)\b/,
  /\.from\(\s*checkinsTable\s*\)/,
  /\b(?:CRM_CHECKINS_TABLE|CRM_SYNC_RUNS_TABLE|CRM_IDENTITY_RESOLUTIONS_TABLE|CRM_PLAN_ENTRIES_TABLE|CRM_CHECKINS_UNIFIED_VIEW|CRM_PLAN_ENTRIES_UNIFIED_VIEW)\b/,
];

/** Files in src/lib/crm/ allowed to touch the VISITS mirror directly. Each is machinery, not a
 * consumer read. Adding a file here needs a reason that is not "it was convenient". */
export const CRM_VISITS_MIRROR_ALLOW_LIST: Readonly<Record<string, string>> = {
  "src/lib/crm/tables.ts": "defines the table-name constants",
  "src/lib/crm/reads.ts": "THE read door itself",
  "src/lib/crm/sync.ts": "the vendor → mirror sync writer (upsert, delete-reconcile, re-stamp)",
  "src/lib/crm/parity.ts": "vendor-vs-mirror parity sweep; must see history before the resigned exclusion",
  "src/lib/crm/schema.ts": "schema-readiness probes",
  "src/lib/crm/admin.ts": "sync-run ledger and the unmapped-identity punch-list behind identity resolution",
  "src/lib/crm/customer-brick.ts": "distinct contact scan feeding the customer→brick resolution table",
  "src/lib/crm/region-brick.ts": "distinct CRM region scan feeding the region→brick resolution table",
  "src/lib/crm/contacts-sync.ts": "resolves contact-list sync targets (hr id → agent crm id)",
  "src/lib/crm/master.ts": "CRM Master raw-mirror browser (Super Admin exact-mirror tabs)",
  "src/lib/crm/rep-day.ts": "rep-day drill-down: live-first before the CRM cutover, the unified visits view as its fallback and its only source after it",
  // 🔴 THE DOOR CANNOT ANSWER THIS ONE. `queryVisits` selects from `crm_visits_unified`, and from a
  // team rep's day that Phoenix also holds, that view ANTI-JOINS his iReports360 rows out — the owner's
  // rule of 2026-10-02, narrowed to "Phoenix wins the day" on 2026-10-16, and never to be weakened. So
  // "who recorded the SAME day in both apps" is exactly the question the door is built to answer zero
  // to, and the mirror is the only place those rows survive.
  "src/lib/crm/phoenix-vendor-leftovers.ts":
    "who recorded a day in both apps after his team moved — the unified view anti-joins exactly those rows out, so the door would answer a confident zero",
};

/** Files in src/lib/crm/ allowed to touch the OTHER mirrors (check-ins, sync runs, identity
 * resolutions, plan entries) directly. Wider than the visits list: the plan and check-in readers
 * below have not been routed through a door yet — that is out of scope of the visits cutover and is
 * listed here so it is VISIBLE debt, not a blanket exemption. */
export const CRM_OTHER_MIRROR_ALLOW_LIST: readonly string[] = [
  "src/lib/crm/tables.ts",
  "src/lib/crm/reads.ts",
  "src/lib/crm/sync.ts",
  "src/lib/crm/schema.ts",
  "src/lib/crm/admin.ts",
  "src/lib/crm/identity.ts",
  "src/lib/crm/live-poller.ts",
  "src/lib/crm/plan-sync.ts",
  "src/lib/crm/contacts-sync.ts",
  "src/lib/crm/master.ts",
  // Consumer reads of plan entries / check-ins not yet behind a door (known debt, not visits):
  // Reads the reference weekly PLANS to answer "when is this doctor usually planned" on Phoenix
  // CRM's List (owner, 2026-09-30). The weekday/week pattern exists nowhere but the plan mirror,
  // and src/lib/crm IS the door for it; its visits read goes through reads.ts, not from here.
  "src/lib/crm/plan-board.ts",
  "src/lib/crm/shared-customers.ts",
  "src/lib/crm/plan-verification-service.ts",
  "src/lib/crm/rep-doctor-lists.ts",
  "src/lib/crm/reps-list.ts",
];

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
}

function matchesAny(source: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

/** Pure classifier, exported so the allow-list logic can be exercised without the filesystem. */
export function crmModuleMirrorViolations(
  files: ReadonlyArray<{ rel: string; source: string }>,
): { otherViolations: string[]; staleAllowListEntries: string[]; visitsViolations: string[] } {
  const visitsViolations: string[] = [];
  const otherViolations: string[] = [];
  const seenVisits = new Set<string>();
  const seenOther = new Set<string>();
  for (const { rel, source } of files) {
    if (!rel.startsWith("src/lib/crm/")) continue;
    if (matchesAny(source, visitsMirrorRef)) {
      seenVisits.add(rel);
      if (!(rel in CRM_VISITS_MIRROR_ALLOW_LIST)) visitsViolations.push(rel);
    }
    if (matchesAny(source, otherMirrorRef)) {
      seenOther.add(rel);
      if (!CRM_OTHER_MIRROR_ALLOW_LIST.includes(rel)) otherViolations.push(rel);
    }
  }
  const staleAllowListEntries = [
    ...Object.keys(CRM_VISITS_MIRROR_ALLOW_LIST).filter((rel) => !seenVisits.has(rel)).map((rel) => `visits: ${rel}`),
    ...CRM_OTHER_MIRROR_ALLOW_LIST.filter((rel) => !seenOther.has(rel)).map((rel) => `other: ${rel}`),
  ];
  return { otherViolations, staleAllowListEntries, visitsViolations };
}

export function runCrmSingleSourceTests() {
  const files: string[] = [];
  walkTsFiles("src", files);
  walkTsFiles("app", files);

  const violations: string[] = [];
  const crmFiles: Array<{ rel: string; source: string }> = [];
  for (const file of files) {
    const rel = file.split(sep).join("/");
    const source = readFileSync(file, "utf8");
    // Inside the CRM module the explicit allow-lists below decide; outside it, nothing may query.
    if (rel.startsWith("src/lib/crm/")) {
      crmFiles.push({ rel, source });
      continue;
    }
    if (literalFrom.test(source) || constFrom.test(source)) violations.push(rel);
  }

  assert.deepEqual(
    violations,
    [],
    `These files query the iReports360 mirror directly instead of going through src/lib/crm/reads.ts:\n  ${violations.join("\n  ")}`,
  );

  // Inside src/lib/crm/: only the allow-listed machinery may reference the mirrors directly.
  const crm = crmModuleMirrorViolations(crmFiles);
  assert.deepEqual(
    crm.visitsViolations,
    [],
    `These CRM-module files reach the VISITS mirror directly but are not visits machinery — read through src/lib/crm/reads.ts (or justify an allow-list entry):\n  ${crm.visitsViolations.join("\n  ")}`,
  );
  assert.deepEqual(
    crm.otherViolations,
    [],
    `These CRM-module files reach the check-in / plan / sync-run / identity mirrors directly and are not allow-listed:\n  ${crm.otherViolations.join("\n  ")}`,
  );
  // An allow-list entry whose file no longer touches that mirror must be removed, so the list only
  // ever shrinks back toward the door instead of quietly staying wide.
  assert.deepEqual(
    crm.staleAllowListEntries,
    [],
    `These allow-list entries no longer reference their mirror — remove them:\n  ${crm.staleAllowListEntries.join("\n  ")}`,
  );

  // The pure classifier itself: a consumer file in src/lib/crm/ reaching the visits table fails,
  // allow-listed machinery passes.
  const probe = crmModuleMirrorViolations([
    { rel: "src/lib/crm/some-new-consumer.ts", source: 'supabase.from(CRM_VISITS_TABLE).select("id")' },
    { rel: "src/lib/crm/another-consumer.ts", source: 'supabase.from("ireports360_visits").select("id")' },
    { rel: "src/lib/crm/sync.ts", source: "supabase.from(visitsTable).upsert(rows)" },
  ]);
  assert.deepEqual(probe.visitsViolations, ["src/lib/crm/some-new-consumer.ts", "src/lib/crm/another-consumer.ts"]);

  // The two outstation workload reads go through the door — never the mirror table directly.
  for (const rel of ["src/lib/crm/visit-workload.ts", "src/lib/crm/visit-partners.ts"]) {
    const source = readFileSync(rel, "utf8");
    assert.match(
      source,
      /import \{[^}]*\bqueryVisits\b[^}]*\} from "@\/lib\/crm\/reads";/,
      `${rel} must read visits through queryVisits from @/lib/crm/reads`,
    );
    assert.doesNotMatch(source, /@\/lib\/crm\/tables/, `${rel} must not import the mirror table constants`);
    assert.doesNotMatch(source, /\bCRM_VISITS_TABLE\b/, `${rel} must not reference the visits table constant`);
    // `Array.from(...)` is ordinary JS; any other `.from(` would be a query builder.
    assert.doesNotMatch(source, /(?<!\bArray)\.from\(/, `${rel} must not run its own .from(...) query`);
    assert.doesNotMatch(source, /getSupabaseAdmin/, `${rel} must not open its own Supabase client`);
    assert.match(source, /participantCrmIds:/, `${rel} must use the door's agent-or-partner filter`);
    // Their documented contract is "no departed-agent exclusion" — keep it explicit at the door.
    assert.match(source, /includeResignedAgents: true,/, `${rel} must opt out of the resigned-agent exclusion explicitly`);
  }

  // The read layer every consumer must use actually exists and exposes the shared primitives.
  const reads = readFileSync("src/lib/crm/reads.ts", "utf8");
  for (const fn of [
    "queryVisits",
    "queryVisitsLimited",
    "queryCheckins",
    "getDoubleVisitRows",
    "queryVisitsPage",
    "scanVisitsForRange",
    "scanVisitsForRangeCreditingPartners",
    "getVisitAgentNames",
    "getMappedAgentHrIds",
    "getVisitsReportData",
  ]) {
    assert.match(reads, new RegExp(`export async function ${fn}\\b`), `crm/reads.ts exposes ${fn}()`);
  }
  assert.match(reads, /participantCrmIds\?: readonly number\[\];/, "crm/reads.ts exposes the participantCrmIds visit filter");

  // The resigned-agent exclusion stays the default everywhere — only an explicit,
  // documented opt-in (still going through the one door) may bypass it.
  assert.match(
    reads,
    /includeResignedAgents\?: boolean;/,
    "the door must expose an explicit opt-in to see resigned-agent rows, not require callers to bypass the door themselves",
  );
  // BOTH doors, named separately. These used to be one assertion matching a single source line,
  // which the CHECK-IN door happened to satisfy on its own — so when the visit door grew its second
  // opt-in (`creditDepartedAgentPartners`, 2026-10-07) the pin went on passing without ever reading
  // the visit door again.
  assert.match(
    reads,
    /const excludedInList = options\.includeResignedAgents \? "" : await getEffectiveExcludedInList\(\);/,
    "the CHECK-IN door's resigned-agent exclusion must default ON — only skipped when a caller explicitly opts in",
  );
  assert.match(
    reads,
    /const excludedInList =\s*\n?\s*options\.includeResignedAgents \|\| options\.creditDepartedAgentPartners \? "" : await getEffectiveExcludedInList\(\);/,
    "the VISIT door's resigned-agent exclusion must default ON, with exactly two documented opt-ins and no third",
  );
  // The second opt-in is only safe because it anonymises the agent side of what it lets through.
  assert.match(
    reads,
    /markPartnerCreditOnlyRows\(rows, excludedCrmIds\);/,
    "creditDepartedAgentPartners must mark and anonymise the rows it keeps, or it is includeResignedAgents without the review",
  );
}
