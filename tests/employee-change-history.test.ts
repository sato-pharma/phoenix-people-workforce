import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildChangeHistoryEntries,
  channelLabel,
  referenceIdsOf,
  scheduledJobName,
  type RecordChangeRow,
  type ReferenceNames,
  type SalaryChangeRow,
} from "../src/lib/employees/change-history.ts";
import { changeHistoryIncludesMoney } from "../src/lib/employees/change-history-service.ts";

/**
 * The Employee Master's Change History panel (owner, 19 Nov 2026: "Build the screen").
 *
 * What it must never do: show a value the log did not keep, show pay to a seat the master withholds
 * it from (not even the fact that a figure moved), print a UUID where a name exists, or let a reader
 * the directory would refuse see someone's history.
 */

const PEOPLE: Record<string, string> = { "B-10": "Hana Fathy", "A-1": "Sara Adel" };
const LOGINS: Record<string, string> = { "hana.login": "B-10" };

const NAMES: ReferenceNames = {
  person: (hrId) => PEOPLE[hrId] ?? null,
  loginHrId: (login) => LOGINS[login] ?? null,
  department: (id) => (id === "dep-1" ? "Sales" : null),
  line: (id) => (id === "line-1" ? "Pedia" : null),
  area: (id) => (id === "area-1" ? "Alex East" : null),
  position: (id) => (id === "pos-1" ? "Medical Representative" : null),
  team: () => null,
};

function recordRow(partial: Partial<RecordChangeRow>): RecordChangeRow {
  return {
    id: "r1",
    changed_at: "2026-11-19T08:00:00Z",
    change_kind: "update",
    actor_login_id: null,
    actor_hr_id: null,
    actor_name: null,
    actor_source: "unattributed",
    changed_fields: [],
    masked_fields: [],
    old_values: {},
    new_values: {},
    write_channel: null,
    ...partial,
  };
}

function salaryRow(partial: Partial<SalaryChangeRow>): SalaryChangeRow {
  return {
    id: "s1",
    changed_at: "2026-11-19T09:00:00Z",
    actor_login_id: null,
    actor_name: "Hana Fathy",
    actor_source: "app",
    changed_fields: ["gross_salary"],
    old_values: { gross_salary: 10000 },
    new_values: { gross_salary: 12500 },
    write_channel: "api",
    ...partial,
  };
}

export function runEmployeeChangeHistoryTests() {
  // 1. A masked field says it changed and carries neither value.
  {
    const [entry] = buildChangeHistoryEntries({
      recordRows: [
        recordRow({
          changed_fields: ["bank_account", "job_title"],
          masked_fields: ["bank_account"],
          old_values: { job_title: "Medical Rep", bank_account: "SHOULD-NOT-SHOW" },
          new_values: { job_title: "District Manager", bank_account: "SHOULD-NOT-SHOW-EITHER" },
        }),
      ],
      salaryRows: [],
      includeMoney: true,
      names: NAMES,
    });
    const bank = entry.fields.find((field) => field.field === "bank_account");
    assert.ok(bank, "a masked field still appears, so the reader knows it moved");
    assert.equal(bank.kept, false, "a masked field is marked as not kept");
    assert.equal(bank.before, null, "a masked field never carries its old value, even if one were present");
    assert.equal(bank.after, null, "a masked field never carries its new value, even if one were present");
    const title = entry.fields.find((field) => field.field === "job_title");
    assert.deepEqual(
      { label: title?.label, before: title?.before, after: title?.after, kept: title?.kept },
      { label: "Title", before: "Medical Rep", after: "District Manager", kept: true },
      "an unmasked field shows before and after under the details panel's own label",
    );
  }

  // 2. Money withheld: pay fields leave the record log, the salary log is dropped whole, and a change
  //    that was pay alone disappears instead of leaving an empty line.
  {
    const rows = [
      recordRow({ id: "pay-only", changed_fields: ["gross_salary", "net_salary"], masked_fields: ["gross_salary", "net_salary"] }),
      recordRow({
        id: "mixed",
        changed_fields: ["gross_salary", "employment_status"],
        masked_fields: ["gross_salary"],
        old_values: { employment_status: "active" },
        new_values: { employment_status: "resigned" },
      }),
    ];
    const withheld = buildChangeHistoryEntries({ recordRows: rows, salaryRows: [salaryRow({})], includeMoney: false, names: NAMES });
    assert.deepEqual(
      withheld.map((entry) => entry.id),
      ["record-mixed"],
      "a pay-only change and every salary-log row vanish for a viewer who may not see pay",
    );
    assert.deepEqual(
      withheld[0].fields.map((field) => field.field),
      ["employment_status"],
      "a mixed change keeps its other fields and loses the pay field, so the reader never learns pay moved",
    );
    const allowed = buildChangeHistoryEntries({ recordRows: rows, salaryRows: [salaryRow({})], includeMoney: true, names: NAMES });
    assert.equal(allowed.length, 3, "a viewer who may see pay gets every change, salary log included");
    const salary = allowed.find((entry) => entry.log === "salary");
    assert.equal(salary?.fields[0].before, "EGP 10,000", "salary figures read as EGP amounts");
    assert.equal(salary?.fields[0].after, "EGP 12,500", "salary figures read as EGP amounts");
  }

  // 3. Ids become names; an id nobody could name says so instead of printing a code.
  {
    const [entry] = buildChangeHistoryEntries({
      recordRows: [
        recordRow({
          actor_hr_id: "B-10",
          actor_name: "raw login name",
          actor_source: "app",
          changed_fields: ["manager_hr_id", "department_id", "area_id", "position_id", "team_id", "line_id"],
          old_values: { manager_hr_id: "A-1", department_id: "dep-1", area_id: null, position_id: "pos-1", team_id: "team-x", line_id: "line-1" },
          new_values: { manager_hr_id: "B-10", department_id: "dep-1", area_id: "area-1", position_id: "pos-1", team_id: null, line_id: "line-1" },
        }),
      ],
      salaryRows: [],
      includeMoney: true,
      names: NAMES,
    });
    const byField = Object.fromEntries(entry.fields.map((field) => [field.field, field]));
    assert.equal(entry.who, "Hana Fathy", "the actor is read by HR id as a display name, ahead of the stored login name");
    assert.equal(byField.manager_hr_id.before, "Sara Adel", "a manager id reads as the person's name");
    assert.equal(byField.manager_hr_id.after, "Hana Fathy", "a manager id reads as the person's name");
    assert.equal(byField.department_id.after, "Sales", "a department id reads as its name");
    assert.equal(byField.area_id.before, null, "an empty area reads as empty, not as a missing name");
    assert.equal(byField.area_id.after, "Alex East", "an area id reads as its name");
    assert.equal(byField.position_id.after, "Medical Representative", "a position id reads as its title");
    assert.equal(byField.team_id.before, "Name not available", "an id the lookup could not name never prints the raw code");
    const ids = referenceIdsOf([
      recordRow({
        actor_hr_id: "B-10",
        changed_fields: ["manager_hr_id", "area_id"],
        old_values: { manager_hr_id: "A-1", area_id: "area-1" },
        new_values: { manager_hr_id: "B-10", area_id: "area-2" },
      }),
    ]);
    assert.deepEqual([...ids.people].sort(), ["A-1", "B-10"], "every person id in the rows, actor included, is looked up");
    assert.deepEqual([...ids.area].sort(), ["area-1", "area-2"], "both sides of a reference change are looked up");

    // A manager the lookup cannot name is said to have no name, never printed as an HR id.
    const [orphan] = buildChangeHistoryEntries({
      recordRows: [recordRow({ changed_fields: ["manager_hr_id"], old_values: { manager_hr_id: "Z-99" }, new_values: { manager_hr_id: "A-1" } })],
      salaryRows: [],
      includeMoney: true,
      names: NAMES,
    });
    assert.equal(orphan.fields[0].before, "Name not available", "an unnamed manager id never prints the HR id itself");
    assert.equal(orphan.fields[0].after, "Sara Adel");
  }

  // 3b. The actor reads by DISPLAY name on both logs: by the row's HR id, else by the HR id behind its
  //     login, and only when neither names anybody does the view's full name stand in.
  {
    const entries = buildChangeHistoryEntries({
      recordRows: [
        recordRow({ id: "by-login", changed_at: "2026-11-19T07:00:00Z", actor_login_id: "hana.login", actor_name: "Hana Mohamed Fathy Ali", changed_fields: ["job_title"], new_values: { job_title: "DM" } }),
        recordRow({ id: "unknown-login", changed_at: "2026-11-19T06:00:00Z", actor_login_id: "gone.login", actor_name: "Former Login Holder", changed_fields: ["job_title"], new_values: { job_title: "DM" } }),
      ],
      salaryRows: [salaryRow({ id: "by-hr-id", actor_hr_id: "A-1", actor_login_id: "sara.login", actor_name: "Sara Adel Mahmoud Hassan" })],
      includeMoney: true,
      names: NAMES,
    });
    const who = Object.fromEntries(entries.map((entry) => [entry.id, entry.who]));
    assert.equal(who["salary-by-hr-id"], "Sara Adel", "a salary change names its actor by display name through actor_hr_id, ahead of the view's full name");
    assert.equal(who["record-by-login"], "Hana Fathy", "a login-only actor is named through the HR id behind the login");
    assert.equal(who["record-unknown-login"], "Former Login Holder", "a login nobody can map falls back to the view's full name, never to 'No person recorded'");

    const ids = referenceIdsOf(
      [recordRow({ actor_login_id: "hana.login" }), recordRow({ actor_hr_id: "B-10", actor_login_id: "ignored.login" })],
      [salaryRow({ actor_hr_id: "A-1" }), salaryRow({ actor_login_id: "sara.login" })],
    );
    assert.deepEqual([...ids.logins].sort(), ["hana.login", "sara.login"], "a login is looked up only for an actor with no HR id, on both logs");
    assert.deepEqual([...ids.people].sort(), ["A-1", "B-10"], "an actor's own HR id is read directly, on both logs");
  }

  // 4. Plumbing stays out; a creation is marked; the list is newest first across both logs.
  {
    const entries = buildChangeHistoryEntries({
      recordRows: [
        recordRow({ id: "old", changed_at: "2026-11-14T08:00:00Z", changed_fields: ["updated_at", "photo_updated_at"] }),
        recordRow({
          id: "born",
          changed_at: "2026-11-15T08:00:00Z",
          change_kind: "insert",
          changed_fields: ["created_at", "full_name", "payroll_eligible", "hire_date"],
          new_values: { full_name: "Mona Ali", payroll_eligible: true, hire_date: "2026-11-16" },
        }),
      ],
      salaryRows: [salaryRow({ id: "pay", changed_at: "2026-11-18T08:00:00Z" })],
      includeMoney: true,
      names: NAMES,
    });
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["salary-pay", "record-born"],
      "newest first across both logs, and a change made only of database timestamps is not shown at all",
    );
    const born = entries[1];
    assert.equal(born.kind, "created", "an insert reads as the record being created");
    assert.deepEqual(
      born.fields.map((field) => [field.field, field.after]),
      [
        ["full_name", "Mona Ali"],
        ["payroll_eligible", "Yes"],
        ["hire_date", "16 Nov 2026"],
      ],
      "created_at is plumbing; a boolean reads Yes/No and a date reads as a Cairo date",
    );
    assert.equal(born.who, "No person recorded", "an unattributed write says no person was recorded, never 'Unknown user'");
  }

  // 4b. A scheduled job names itself (owner, 19 Nov 2026: "Name scheduled jobs"): no person, a job →
  //     "Scheduled job: <its name>", on both logs; a person always comes first.
  {
    const entries = buildChangeHistoryEntries({
      recordRows: [
        recordRow({
          id: "exit",
          changed_at: "2026-11-20T05:04:00Z",
          actor_source: "job",
          actor_job: "cron/daily/resignation-sla",
          write_channel: "api",
          changed_fields: ["employment_status"],
          old_values: { employment_status: "active" },
          new_values: { employment_status: "resigned" },
        }),
        recordRow({
          id: "person-and-job",
          changed_at: "2026-11-20T05:00:00Z",
          actor_hr_id: "A-1",
          actor_source: "app",
          actor_job: "cron/probation-milestones",
          changed_fields: ["nickname"],
          new_values: { nickname: "Sara" },
        }),
      ],
      salaryRows: [
        salaryRow({ id: "pay-job", actor_name: null, actor_source: "job", actor_job: "cron/hire-handoff-reconcile" }),
      ],
      includeMoney: true,
      names: NAMES,
    });
    const who = Object.fromEntries(entries.map((entry) => [entry.id, entry.who]));
    assert.equal(
      who["record-exit"],
      "Scheduled job: Resignation approval reminders",
      "a morning job reads by its own name in the daily-jobs list, never 'No person recorded' and never its route",
    );
    assert.equal(who["salary-pay-job"], "Scheduled job: Hire handoff reconcile", "the salary log names the job too");
    assert.equal(who["record-person-and-job"], "Sara Adel", "a named person always comes before a job");
  }
  assert.equal(scheduledJobName("cron/probation-milestones"), "Probation milestones");
  assert.equal(scheduledJobName("notifications/daily"), "Morning jobs", "the morning fan-out runs every morning job in one request");
  assert.equal(scheduledJobName("cron/phoenix-crm-visit-rollup"), "Phoenix CRM visit rollup", "an initialism stays in capitals");
  assert.equal(scheduledJobName("cron/daily/not-a-real-key"), "Not a real key", "an unknown morning job still reads as words");
  assert.equal(scheduledJobName("notifications/contract-renewals"), "Notifications contract renewals");

  // 5. How a write arrived, in words; a row from before 19 Nov says the channel was not recorded.
  assert.equal(channelLabel("api"), "Through Phoenix");
  assert.equal(channelLabel("database_job"), "Scheduled database job");
  assert.equal(channelLabel("direct_sql"), "Direct database change");
  assert.equal(channelLabel(null), "Not recorded (before 19 Nov 2026)", "an old row is honest that its channel was never captured");

  // 6. Who gets pay: the master's own rule, with the retired HR Advisory seat closed outright.
  assert.equal(changeHistoryIncludesMoney({ role: "HR Administration" }, "A-1"), false, "the salary-blind seat never sees pay history");
  assert.equal(changeHistoryIncludesMoney({ role: "HR Advisory" }, "A-1"), false, "the retired HR Advisory seat gets no pay, never a wider rule");
  assert.equal(changeHistoryIncludesMoney({ role: "Super Admin" }, "A-1"), true, "the owner sees pay history");
  assert.equal(changeHistoryIncludesMoney({ role: "HR Operations" }, "A-1"), true, "HR Operations maintains pay on the master and sees its history");

  // 7. The route's door, by source: guest refused, employees read, the directory's own scope check,
  //    and pay decided before anything is read.
  {
    const route = readFileSync("app/api/employees/[hrId]/change-history/route.ts", "utf8");
    const guest = route.indexOf('access.source === "guest"');
    const read = route.indexOf('assertPermission(access, "employees", "read")');
    const scope = route.indexOf("canSeeEmployee(access");
    const load = route.indexOf("loadEmployeeChangeHistory(target.hr_id");
    assert.ok(guest > 0 && read > guest, "a signed-out caller is refused before the permission check");
    assert.ok(scope > read, "the person-level scope check runs after the employees read grant");
    assert.ok(load > scope, "nothing is read from either log before the viewer is known to see this person");
    assert.match(route, /includeMoney: changeHistoryIncludesMoney\(access, target\.hr_id\)/, "pay is decided per viewer and per person");
    assert.doesNotMatch(route, /export (async )?function (?!GET)/, "a route file exports only its handlers (Next refuses any other export)");

    const service = readFileSync("src/lib/employees/change-history-service.ts", "utf8");
    assert.match(
      service,
      /const salaryRead = options\.includeMoney\s*\?/,
      "the salary log is not even read for a viewer who may not see pay — not read and then filtered",
    );
    assert.doesNotMatch(service, /\.(insert|update|upsert|delete)\(/, "the history reader never writes");
    for (const columns of ["RECORD_COLUMNS", "SALARY_COLUMNS"]) {
      assert.match(
        service,
        new RegExp(`const ${columns} =\\s+"[^"]*\\bactor_job\\b[^"]*";`),
        `${columns} must read actor_job, or a job's change reads "No person recorded" again`,
      );
    }

    const panel = readFileSync("src/components/employees/employee-management.tsx", "utf8");
    assert.match(
      panel,
      /<EmployeeChangeHistoryCard hrId=\{masterDetailsEmployee\.hrId\} key=\{`history-\$\{masterDetailsEmployee\.hrId\}`\} \/>/,
      "the card mounts on the details panel, keyed per person so each employee starts fresh",
    );
    const card = readFileSync("src/components/employees/employee-change-history-card.tsx", "utf8");
    assert.match(card, /response\.status === 401 \|\| response\.status === 403/, "a refused reader gets no card at all");
    assert.doesNotMatch(card, /\brounded(-|\b)/, "square edges: the card carries no rounded corner");
    assert.doesNotMatch(card, /\btruncate\b|text-ellipsis|line-clamp/, "no ellipsis: values wrap, never cut");
  }
}
