import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import {
  contactListChangeRefusal,
  contactListChangesInForce,
  contactListDecisionRefusal,
  contactListSpecialityOptions,
  contactListStateRefusal,
  parseContactListGrade,
  type ContactListChangeInput,
} from "../src/lib/crm/contact-lists/rules.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Doctor lists maintained in Phoenix — CRM phase 7.
//
// WHAT THIS FILE GUARDS:
//   · THE OWNER'S RULE (2026-09-14): "Rep asks, DM approves, SFE and system admin can edit, add or
//     delete." A rep only asks, for his OWN list; only the stored manager answers, for a rep beneath
//     him; the SFE Manager and the administrator apply a change directly.
//   · NOT BEFORE A REP'S TEAM HAS STARTED in Phoenix CRM (or a global CRM cutover date, if one is ever
//     set): until then iReports360 owns HIS list, the service and the database both refuse a change, and
//     the hourly refresh keeps re-deriving it. The per-rep half of that rule, and the measured reason the
//     global-date-only version refused everyone, are pinned in tests/doctor-lists-follow-team-starts.test.ts.
//   · A PHARMACY IS NOT A CONTACT. No pharmacy goes on a doctor list; AM and PM only.
//   · NOBODY DECIDES FOR ANYONE. The approval is applied by the database function with the stored
//     manager's id, which it re-checks; the service never writes a decision literal.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const addExisting: ContactListChangeInput = {
  action: "add",
  listType: "AM",
  contactCrmId: 4501,
  newContact: null,
  grade: "A",
  reason: "New clinic opened in my brick",
};

export function runCrmContactListChangesTests() {
  // ── 1. In force from a global cutover date, or from the rep's own team start ───────────────────
  const setting = (cutoverDate: string | null) => ({ cutoverDate }) as Parameters<typeof contactListChangesInForce>[0];
  assert.equal(contactListChangesInForce(setting(null), "2026-10-01"), false, "no cutover date: lists stay iReports360's");
  assert.equal(contactListChangesInForce(setting("2026-10-01"), "2026-09-30"), false, "the day before the cutover");
  assert.equal(contactListChangesInForce(setting("2026-10-01"), "2026-10-01"), true, "the cutover day itself");

  // ── 2. The shape of a change ──────────────────────────────────────────────────────────────────
  assert.equal(contactListChangeRefusal(addExisting), null);
  assert.ok(contactListChangeRefusal({ ...addExisting, action: null }));
  assert.ok(contactListChangeRefusal({ ...addExisting, listType: null }), "AM or PM must be chosen");
  assert.ok(contactListChangeRefusal({ ...addExisting, reason: "  " }), "a reason is required");
  assert.ok(contactListChangeRefusal({ ...addExisting, reason: "x".repeat(1001) }));
  assert.ok(contactListChangeRefusal({ ...addExisting, grade: null }), "an add needs a grade");
  assert.ok(contactListChangeRefusal({ ...addExisting, contactCrmId: 100000 }), "the catch-all contact is not a doctor");
  const speciality = contactListSpecialityOptions()[0];
  const newDoctor = { name: "Dr. Mona Adel", speciality, address: "12 Tahrir St" };
  assert.equal(
    contactListChangeRefusal({ ...addExisting, contactCrmId: null, newContact: newDoctor }),
    null,
    "a doctor not yet in Phoenix can be described",
  );
  assert.ok(contactListChangeRefusal({ ...addExisting, newContact: newDoctor }), "not both a search pick and a description");
  assert.ok(
    contactListChangeRefusal({ ...addExisting, contactCrmId: null, newContact: { ...newDoctor, speciality: "Pharmacy" } }),
    "a pharmacy is not a contact",
  );
  assert.ok(
    contactListChangeRefusal({ ...addExisting, contactCrmId: null, newContact: { ...newDoctor, speciality: "Astrology" } }),
    "the speciality comes from the list",
  );
  const remove: ContactListChangeInput = { ...addExisting, action: "remove", grade: null };
  assert.equal(contactListChangeRefusal(remove), null);
  assert.ok(contactListChangeRefusal({ ...remove, contactCrmId: null }), "a removal names the doctor on the list");
  assert.ok(contactListChangeRefusal({ ...remove, grade: "B" }), "a removal carries no grade");
  assert.ok(contactListChangeRefusal({ ...remove, action: "regrade" }), "a grade change needs the new grade");
  assert.equal(parseContactListGrade(" b "), "B");
  assert.equal(parseContactListGrade("D"), null);

  // ── 3. Against the list as it stands ──────────────────────────────────────────────────────────
  const state = { action: "add" as const, onList: false, currentGrade: null, newGrade: "A" as const, contactSpeciality: "Pediatrics" };
  assert.equal(contactListStateRefusal(state), null);
  assert.ok(contactListStateRefusal({ ...state, onList: true }), "already on the list");
  assert.ok(contactListStateRefusal({ ...state, contactSpeciality: "Pharmacy" }), "a pharmacy found by search is refused too");
  assert.ok(contactListStateRefusal({ ...state, action: "remove" }), "cannot remove a doctor who is not on the list");
  assert.ok(contactListStateRefusal({ ...state, action: "regrade", onList: true, currentGrade: "a" }), "the same grade is no change");
  assert.equal(contactListStateRefusal({ ...state, action: "regrade", onList: true, currentGrade: "B" }), null);

  // ── 4. Who answers ────────────────────────────────────────────────────────────────────────────
  const decide = (overrides: Partial<Parameters<typeof contactListDecisionRefusal>[0]>) =>
    contactListDecisionRefusal({
      viewerHrKey: "DM-1",
      repHrKey: "REP-1",
      managerHrKey: "DM-1",
      direct: false,
      status: "pending",
      repInViewerScope: true,
      decision: "approved",
      note: null,
      ...overrides,
    });
  assert.equal(decide({}), null, "the stored manager approves a rep beneath him");
  assert.ok(decide({ viewerHrKey: null }));
  assert.ok(decide({ viewerHrKey: "RM-9" }), "only the manager the request was sent to answers it");
  assert.ok(decide({ viewerHrKey: "REP-1", managerHrKey: "REP-1" }), "nobody answers their own request");
  assert.ok(decide({ repInViewerScope: false }), "scope runs downward only");
  assert.ok(decide({ status: "approved" }), "a request is answered once");
  assert.ok(decide({ status: "cancelled" }), "a withdrawn request cannot be answered");
  assert.ok(decide({ direct: true, managerHrKey: null }), "a direct change needs no answer");
  assert.ok(decide({ decision: "rejected", note: " " }), "a refusal must say why");
  assert.equal(decide({ decision: "rejected", note: "Outside your brick" }), null);

  // ── 5. The permission matrix: rep asks, managers answer, SFE and the administrator edit ───────
  const matrix = permissionMatrix as unknown as Record<string, Record<string, readonly string[] | undefined> | undefined>;
  const grants = (role: string) => [...(matrix[role]?.crm_contact_lists ?? [])].sort();
  assert.deepEqual(grants("Medical Rep"), ["create", "read"], "a rep asks; he never edits directly");
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager"]) {
    assert.deepEqual(grants(role), ["approve", "read"], `${role} answers, never edits directly`);
  }
  for (const role of ["SFE Manager", "Super Admin"]) {
    assert.ok(grants(role).includes("update"), `${role} edits directly`);
    assert.ok(!grants(role).includes("approve"), `${role} does not answer a rep's request in his manager's place`);
  }
  for (const role of ["CEO", "HR Operations", "Employee"]) {
    assert.deepEqual(grants(role).filter((action) => action !== "read"), [], `${role} cannot change a doctor list`);
  }

  // ── 6. The service ────────────────────────────────────────────────────────────────────────────
  const service = read("src/lib/crm/contact-lists/service.ts");
  const exported = [...service.matchAll(/export async function (\w+)\(/g)].map((match) => match[1]);
  assert.ok(exported.length >= 8, "the doctor-list service's exported functions must be found");
  for (const name of exported) {
    const guard =
      name === "assertContactListAccess" || name === "getContactListAvailability"
        ? /viewerCapabilities\(access\)/
        : /assertPermission\(access, "crm_contact_lists", "(create|approve|update)"\)|assertContactListAccess\(access\)/;
    assert.match(functionBody(service, name), guard, `${name} must check the viewer's access itself, not trust its caller`);
  }
  for (const name of ["requestContactListChange", "applyContactListChangeDirectly"]) {
    assert.match(
      functionBody(service, name),
      /await assertPhoenixOwnsList\(rep\)/,
      `${name} is refused while iReports360 still owns that rep's list`,
    );
  }

  const requestBody = functionBody(service, "requestContactListChange");
  assert.match(requestBody, /requireActiveSelf\(access, directory\)/, "the rep is the session");
  assert.match(requestBody, /rep_hr_id: rep\.hrId, requested_by: rep\.hrId/, "a rep asks only for his own list");
  assert.match(requestBody, /direct: false/, "a rep's change always waits for his manager");
  assert.match(requestBody, /managementChain\(rep, directory\)\[0\]/, "it goes to his nearest active manager");

  const applyBody = functionBody(service, "applyContactListChangeDirectly");
  assert.match(applyBody, /assertPermission\(access, "crm_contact_lists", "update"\)/, "only an editor applies directly");
  assert.match(applyBody, /isAgentInScope\(scope, rep\.hrId\)/, "an editor changes only a rep in his scope");
  assert.match(applyBody, /p_decided_by: editor\.hrId/, "a direct change is decided by the editor himself");

  const decideBody = functionBody(service, "decideContactListChange");
  assert.match(
    decideBody,
    /if \(decision === "approved"\) \{[\s\S]{0,200}await assertPhoenixOwnsList\(/,
    "an approval is refused while iReports360 still owns that rep's list",
  );
  assert.match(decideBody, /contactListDecisionRefusal\(/);
  assert.match(decideBody, /p_decided_by: record\.managerHrId/, "the approval is the stored manager's own");
  assert.match(decideBody, /decided_by: record\.managerHrId/, "the refusal is the stored manager's own");
  assert.match(decideBody, /\.eq\("status", "pending"\)/, "a refusal only moves a pending request");
  assert.doesNotMatch(service, /status:\s*"(approved|rejected)"/, "the service must never write a decision literal");
  assert.match(functionBody(service, "cancelContactListChange"), /requireActiveSelf\(access, directory\)/, "a rep withdraws only his own");
  assert.doesNotMatch(
    service,
    /\.from\(CRM_CONTACT_ASSIGNMENTS_TABLE\)\s*\.(insert|update|upsert|delete)/,
    "a list changes only through the database function",
  );
  assert.match(functionBody(service, "searchContactListDoctors"), /isPharmacySpeciality/, "the search never offers a pharmacy");
  // An applied change moves a list, so the cached list sizes are busted on both paths that apply one.
  assert.match(
    service,
    /function bustListSummaries\(\)[^{]*\{\s*try \{\s*revalidateTag\(CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG, \{ expire: 0 \}\)/,
    "the list-size cache tag is busted, inside a try so a cache failure never fails an applied change",
  );
  assert.match(applyBody, /throw applied\.error;\s*\}\s*bustListSummaries\(\);\s*return \{ changeId \}/, "a direct change busts the list sizes once applied");
  assert.match(
    decideBody,
    /throw applied\.error;\s*\}\s*bustListSummaries\(\);\s*return \{ changeId, status: decision \}/,
    "an approval busts the list sizes once applied",
  );

  // ── 7. The route ──────────────────────────────────────────────────────────────────────────────
  const route = read("app/api/crm/contact-lists/route.ts");
  assert.doesNotMatch(route, /body\.(hrId|hr_id|repHrId|agentHrId|managerHrId|decidedBy)/, "the route takes no person from the body");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(post.indexOf("assertSameOriginMutation(request)") < post.indexOf("resolveAccessContext(request)"));
  assert.match(post, /assertContactListAccess\(access\)/);
  assert.match(
    route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST")),
    /assertContactListAccess\(access\)/,
  );

  // ── 8. The migration ──────────────────────────────────────────────────────────────────────────
  const sql = read("supabase/migrations/20260914020000_crm_contact_list_changes.sql").replace(/--[^\n]*/g, "");
  const applyStart = sql.indexOf("create or replace function public.crm_contact_list_change_apply");
  const refreshStart = sql.indexOf("create or replace function public.crm_contact_master_refresh");
  assert.ok(applyStart > 0 && refreshStart > applyStart, "the apply function and the recreated refresh must both exist");
  const apply = sql.slice(applyStart, refreshStart);
  assert.doesNotMatch(apply, /security definer/, "the apply function runs with the caller's rights");
  assert.match(apply, /Only the manager this change was sent to can approve it\./, "the database refuses an approval by anyone but the stored manager");
  // The gate AS THIS MIGRATION SHIPPED IT. Superseded on 2026-10-04 by
  // 20261004120000_doctor_lists_follow_each_team_start.sql, because `v_cutover is null or ...` refused
  // EVERY change while the global date stayed unset — crm_contact_list_changes held 0 rows. The live
  // rule is each team's own Phoenix CRM start, pinned in tests/doctor-lists-follow-team-starts.test.ts;
  // this line is history, not current behaviour.
  assert.match(apply, /until the CRM cutover date/, "this migration's own gate was the global cutover date");
  assert.match(apply, /revoke execute on function public\.crm_contact_list_change_apply\(uuid, text, text\) from public, anon, authenticated/);
  assert.match(sql, /manager_hr_id <> rep_hr_id/, "a rep is never his own manager");
  assert.match(sql, /list_type in \('AM', 'PM'\)/, "a pharmacy list is never changed here");
  assert.equal(sql.match(/enable row level security/g)?.length, 2);
  const refresh = sql.slice(refreshStart);
  assert.match(refresh, /v_lists_live/, "the nightly scrape stops touching lists from the cutover");
  assert.match(refresh, /a\.source = 'ireports360'/, "the scrape never closes a list row Phoenix wrote");
  assert.doesNotMatch(sql, /salary|deduction|payroll/i, "the migration touches no pay table");

  // ── 9. Reachability: linked once the cutover date is set; the pages refuse others ─────────────
  assert.match(read("app/employee-portals/visits/page.tsx"), /doctorList\.show \? \(\s*<Link[^>]*href="\/employee-portals\/visits\/doctor-list"/);
  assert.match(read("src/config/system-navigation.ts"), /href: "\/admin\/doctor-list-changes"/);
  for (const page of ["app/employee-portals/visits/doctor-list/page.tsx", "app/(admin)/admin/doctor-list-changes/page.tsx"]) {
    assert.match(read(page), /assertContactListAccess\(access\)[\s\S]*?if \(!allowed\) redirect\(/, `${page} redirects a viewer who can neither ask, answer nor edit`);
  }
}
