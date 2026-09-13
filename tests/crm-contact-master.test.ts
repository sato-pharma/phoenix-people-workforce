import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  contactMasterRefreshIncludesActivity,
  isContactMasterMissingError,
  parseContactMasterRefreshResult,
} from "../src/lib/crm/contact-master.ts";
import { contactRecordFromMasterAssignment } from "../src/lib/direct-orders/venue-contact-options.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The CRM contact master (Phase 2 of the CRM build order).
//
// `ireports360_contacts` is each rep's list AS IT STANDS TODAY and forgets a removed doctor, so it
// cannot say who held a contact on a given date, and 6,929 visited contacts are on nobody's list.
// Native visits and plans need one contact id that outlives a list change. The master is that
// record, rebuilt from the read-only mirrors by one SQL function.
//
// WHAT THIS FILE GUARDS:
//   · A REMOVED CONTACT'S PERIOD ENDS ON THE LAST DAY IT WAS SEEN, NEVER TODAY. It was not on the
//     list today; closing it on today would credit a rep with a doctor he no longer holds.
//   · ONE OPEN PERIOD per (contact, agent, list), and a grade change or slot handover is a NEW period.
//   · CONTACT 100000 is the CRM's catch-all, never a contact.
//   · NO SECOND TAXONOMY. The master has no `kind` column and no speciality list; contact-taxonomy.ts
//     stays the one authority.
//   · THE MIRROR STAYS READ-ONLY (owner decision 19).
//   · THE PICKER READS THE MASTER, falls back to the mirror ONLY on a missing table, and is not widened.
//   · THE ACTIVITY PASS RUNS ONCE PER DAILY SWEEP — a full visit/plan scan on all twelve slices
//     would add seconds to every tick under a 30-second scheduler cap.
// ─────────────────────────────────────────────────────────────────────────────

/** Comments out, string literals kept: the pins below are about SQL, not the prose explaining it. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

export function runCrmContactMasterTests() {
  const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const migration = stripSqlComments(read("supabase/migrations/20260913150000_crm_contact_master.sql"));
  const options = read("src/lib/direct-orders/venue-contact-options.ts");
  const route = read("app/api/cron/crm-contact-lists/route.ts");
  const master = read("src/lib/crm/contact-master.ts");

  // ── 1. The activity pass runs on exactly one slice of the daily sweep ─────
  const slicesWithActivity = Array.from({ length: 12 }, (_unused, slice) => slice).filter((slice) =>
    contactMasterRefreshIncludesActivity({ slice, sliceOf: 12 }),
  );
  assert.deepEqual(
    slicesWithActivity,
    [11],
    "the visit/plan pass must run on the LAST slice only — after every agent's list is fresh, and once " +
      "rather than twelve times a day under the 30-second scheduler cap",
  );
  assert.equal(
    contactMasterRefreshIncludesActivity({ slice: 0, sliceOf: 1 }),
    true,
    "a by-hand ?all=1 sweep is one slice of one and must include the activity pass",
  );

  // ── 2. Only a missing FUNCTION reads as "not provisioned" ─────────────────
  assert.equal(isContactMasterMissingError({ code: "PGRST202", message: "x" }), true);
  assert.equal(isContactMasterMissingError({ code: "42883", message: "x" }), true);
  assert.equal(
    isContactMasterMissingError({ code: null, message: "Could not find the function public.crm_contact_master_refresh(p_include_activity) in the schema cache" }),
    true,
  );
  for (const code of ["57014", "23505", "55P03", "PGRST205"]) {
    assert.equal(
      isContactMasterMissingError({ code, message: "boom" }),
      false,
      `${code} is a real failure — folding it into "not provisioned" would hide a broken refresh behind a benign audit line`,
    );
  }

  // ── 3. The refresh answer parses defensively ──────────────────────────────
  const parsed = parseContactMasterRefreshResult({ assignmentsClosed: 3, includeActivity: "true" });
  assert.equal(parsed.assignmentsClosed, 3);
  assert.equal(parsed.assignmentsOpened, 0, "a field the function did not send must read as zero");
  assert.equal(parsed.includeActivity, false, "only a real boolean true means the activity pass ran");
  assert.equal(parseContactMasterRefreshResult(null).contactsTotal, 0);

  // ── 4. A master assignment maps onto the record the picker already reads ──
  const embed = { address: "12 Tahrir St", crm_region_name: "Giza", name: "Dr Mona", name_ar: "د. منى", speciality: "Pediatrics" };
  const base = { agent_crm_id: 1201, agent_hr_id: "B-55", contact_crm_id: 48291, grade: "A", list_type: "PM" };
  const fromObject = contactRecordFromMasterAssignment({ ...base, contact: embed });
  assert.deepEqual(fromObject, {
    address: "12 Tahrir St",
    agent_crm_id: 1201,
    agent_hr_id: "B-55",
    contact_crm_id: 48291,
    contact_grade: "A",
    contact_name: "Dr Mona",
    contact_name_ar: "د. منى",
    crm_region_name: "Giza",
    list_type: "PM",
    speciality: "Pediatrics",
  });
  assert.deepEqual(
    contactRecordFromMasterAssignment({ ...base, contact: [embed] }),
    fromObject,
    "an array-shaped embed must map the same — a client upgrade must not blank every contact's name",
  );
  const noEmbed = contactRecordFromMasterAssignment({ ...base, contact: null });
  assert.equal(noEmbed.contact_name, null);
  assert.equal(noEmbed.agent_hr_id, "B-55", "the scope key must survive a missing embed — it is on the assignment");

  // ── 5. The migration ──────────────────────────────────────────────────────
  assert.match(
    migration,
    /check \(contact_crm_id > 0 and contact_crm_id <> 100000\)/,
    "contact 100000 is the CRM's catch-all and must be refused by the table itself",
  );
  assert.match(
    migration,
    /on public\.crm_contact_assignments \(contact_crm_id, agent_crm_id, list_type\)\s*\n\s*where effective_to is null/,
    "exactly one OPEN period per (contact, agent, list)",
  );
  assert.match(
    migration,
    /set effective_to = greatest\(a\.effective_from, least\(a\.last_seen_on, v_today - 1\)\)/,
    "a removed contact's period must end on the last day it was seen and never on today — it was not on the list today",
  );
  assert.ok(
    migration.indexOf("set effective_to =") < migration.indexOf("insert into public.crm_contact_assignments"),
    "the refresh must CLOSE before it OPENS, or a grade change collides with its own open period",
  );
  assert.match(
    migration,
    /\(m\.agent_hr_id is null or a\.agent_hr_id is null or lower\(btrim\(m\.agent_hr_id\)\) = lower\(btrim\(a\.agent_hr_id\)\)\)\s*\n\s*and public\.crm_contact_fold_grade\(m\.contact_grade\) is not distinct from a\.grade/,
    "a slot handover (two different real HR ids) or a grade change must close the period, and an HR id merely " +
      "resolving from null must NOT — or the day the identity lookup answers, every period on that rep's lists " +
      "records a handover that never happened",
  );
  assert.doesNotMatch(
    migration,
    /lower\(\w\.agent_hr_id\) is not distinct from/,
    "no step may treat a null HR id as different from a real one",
  );
  {
    const discard = migration.indexOf("delete from public.crm_contact_assignments a");
    const close = migration.indexOf("set effective_to =");
    assert.ok(
      discard > -1 && discard < close,
      "an open period that began today must be discarded BEFORE the close runs — closing it would end it today, " +
        "and its replacement also starts today, leaving two periods covering one date",
    );
    assert.match(
      migration.slice(discard, close),
      /where a\.effective_to is null\s*\n\s*and a\.effective_from >= v_today/,
      "only an OPEN period that began today may ever be deleted — closed history is never deleted",
    );
  }
  assert.match(
    migration,
    /where c\.crm_region_id is null\s*\n\s*and lower\(btrim\(c\.crm_region_name\)\) = r\.region_key/,
    "a listed contact nobody has visited must still get a region id from its region name, or it stays brick-pending for good",
  );
  assert.match(migration, /having count\(distinct rr\.crm_region_id\) = 1/, "a region name shared by two region ids must not guess");
  {
    const fill = migration.indexOf("where c.crm_region_id is null");
    assert.ok(
      fill > migration.indexOf("analyze pg_temp.crm_contact_master_activity") && fill < migration.indexOf("with resolved as"),
      "the region-from-name fill must run AFTER the activity pass and BEFORE the bricks — filled earlier, the contacts " +
        "the activity pass adds wait a day for a brick and a repeat refresh is not a no-op (staging: 771 bricks moved)",
    );
  }
  assert.match(migration, /when upper\(btrim\(p_grade\)\) = 'A\+' then 'A'/, "A+ is folded into A (audit §11.3)");
  assert.doesNotMatch(
    migration,
    /\bkind\s+text\b|'pediatrics'|'internal medicine'|'hospital'|'general practitioner'/i,
    "no speciality classification in SQL — contact-taxonomy.ts is the one authority",
  );
  assert.doesNotMatch(
    migration,
    /(insert\s+into|update|delete\s+from)\s+public\.ireports360_/i,
    "the master must never write to the vendor mirror (owner decision 19)",
  );
  assert.ok(
    migration.indexOf("when cr.status = 'mapped'") > -1 &&
      migration.indexOf("when cr.status = 'mapped'") < migration.indexOf("when rr.status = 'mapped'"),
    "the customer brick mapping must win over the region mapping — master.ts's order, so a contact and its visits agree",
  );
  assert.doesNotMatch(migration, /security\s+definer/i, "the refresh runs as its caller, the service role");
  for (const fn of ["crm_contact_fold_grade(text)", "crm_contact_master_refresh(boolean)"]) {
    const revoke = migration.indexOf(`revoke execute on function public.${fn} from public, anon, authenticated`);
    const grant = migration.indexOf(`grant execute on function public.${fn} to service_role`);
    assert.ok(revoke > -1 && grant > revoke, `${fn}: the service_role grant must come AFTER the revoke from PUBLIC`);
  }
  for (const table of ["crm_contacts", "crm_contact_assignments"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`), `${table} must have RLS on`);
  }
  assert.match(migration, /perform public\.crm_contact_master_refresh\(true\)/, "the migration must seed, with the activity pass");
  assert.match(
    migration,
    /'ms', v_ms/,
    "the refresh must report per-step timings — it runs through PostgREST under an 8-second statement timeout, and " +
      "the audit row is the only place a step growing toward that limit would show before the refresh starts failing",
  );

  // ── 6. The picker reads the master, and falls back only on a missing table ─
  {
    const start = options.indexOf("async function readContactRecordsPage");
    const end = options.indexOf("\n}\n", start);
    assert.ok(start > -1 && end > start, "readContactRecordsPage must be findable");
    const body = options.slice(start, end);
    const masterRead = body.indexOf(".from(CRM_CONTACT_ASSIGNMENTS_TABLE)");
    const mirrorRead = body.indexOf(".from(CRM_CONTACTS_TABLE)");
    assert.ok(masterRead > -1 && mirrorRead > masterRead, "the master must be read first, the mirror only after");
    assert.match(body, /\.is\("effective_to", null\)/, "only OPEN assignments are on a list today");
    assert.match(
      body,
      /if \(!isCrmSchemaMissingError\(fromMaster\.error\)\) \{\s*\n\s*throw/,
      "any master error other than a missing table must throw — a silent mirror answer would hide a broken master",
    );
  }
  assert.equal(
    (options.match(/(?<!Array)\.from\(/g) ?? []).length,
    2,
    "every contact read in the picker module must go through readContactRecordsPage — a third .from() is a read that skips the master",
  );
  {
    const start = options.indexOf("const MASTER_SELECT_COLUMNS");
    const end = options.indexOf(";", start);
    assert.ok(start > -1 && end > start, "MASTER_SELECT_COLUMNS must be findable");
    assert.doesNotMatch(options.slice(start, end), /phone/, "the master read must not SELECT a phone either");
  }

  // ── 7. The cron rebuilds the master after the slice, and never fails the sync over it ─
  const syncAt = route.indexOf("await syncCrmContactLists(");
  const refreshAt = route.indexOf("await refreshCrmContactMaster(");
  const auditAt = route.indexOf("await writeAuditLog(");
  assert.ok(
    syncAt > -1 && refreshAt > syncAt && auditAt > refreshAt,
    "the master refresh must run after the slice is written and before the audit row that reports it",
  );
  assert.match(route, /includeActivity: contactMasterRefreshIncludesActivity\(\{ slice, sliceOf \}\)/);
  assert.match(
    route,
    /result\.agents === 0 \|\| contactMaster\.status === "failed" \? "fail" : "success"/,
    "a failed master refresh must fail the dead-man ping — the venue picker reads the master, and a refresh failing " +
      "every day would otherwise leave it serving a frozen list with nobody told",
  );
  {
    const start = master.indexOf("export async function refreshCrmContactMaster");
    assert.ok(start > -1, "refreshCrmContactMaster must be findable");
    assert.match(
      master.slice(start),
      /\} catch \(error\) \{\s*\n\s*return \{ error:/,
      "the refresh must never throw — the mirror rows are already written, and a 500 would misreport a successful sync",
    );
  }
}
