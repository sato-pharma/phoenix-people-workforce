import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { permissionMatrix, phoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  buildSkillsSurveyChainIndex,
  canEditSkillsSurveySettings,
  canOpenSkillsSurvey,
  canRateSkillsSurveyMember,
  canRateSkillsSurveys,
  canReadSkillsSurveyMember,
  isSkillsSurveyMember,
  isSkillsSurveySubject,
} from "../src/lib/coaching/skills-survey/access.ts";
import { stripComments } from "./support/comment-strip.ts";

// WHO RATES, READS AND CHANGES THE TEAM COACHING SKILLS SURVEY (owner and Salma Labib, Training
// Manager, 2026-10-31). The person rated never sees it — "so the managers rate honestly" — and that
// is asked before any role, so the later "Line Managers rate District Managers" step can never show a
// District Manager his own survey through his role. The rep is never told either: no email, bell or
// Telegram anywhere in the survey's code.

type Person = {
  hrId: string;
  jobTitle: string | null;
  positionTitle: string | null;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
};

function person(hrId: string, jobTitle: string, managerHrId: string | null, extra: Partial<Person> = {}): Person {
  return { hrId, jobTitle, managerHrId, pendingManagerReplacementForHrId: null, positionTitle: null, ...extra };
}

// One chain: Rep -> District Manager -> Regional Manager -> National Sales Manager, plus a second
// District Manager's rep elsewhere in the company.
const nsm = person("N-1", "National Sales Manager", null);
const rm = person("RM-1", "Regional Manager", "N-1");
const dm = person("D-1", "District Sales Manager", "RM-1");
const rep = person("R-1", "Medical Representative", "D-1");
const otherNsm = person("N-2", "National Sales Manager", null);
const otherDm = person("D-2", "District Sales Manager", "N-2");
const otherRep = person("R-2", "Medical Representative", "D-2");
const directory = [nsm, rm, dm, rep, otherNsm, otherDm, otherRep];
const chain = buildSkillsSurveyChainIndex(directory);

function viewer(role: PhoenixRole, hrId: string | null) {
  return { hrId, role };
}

function runWhoRates() {
  assert.equal(canRateSkillsSurveyMember(viewer("District Manager", "D-1"), rep), true, "a District Manager rates his own rep");
  assert.equal(canRateSkillsSurveyMember(viewer("District Manager", "D-2"), rep), false, "never another team's rep");
  assert.equal(
    canRateSkillsSurveyMember(viewer("District Manager", "D-1"), person("R-9", "Medical Representative", "N-1", {
      pendingManagerReplacementForHrId: "D-1",
    })),
    true,
    "a rep held by the seat while it is vacant still belongs to that seat",
  );
  assert.equal(
    canRateSkillsSurveyMember(viewer("District Manager", "D-1"), person("D-9", "District Sales Manager", "D-1")),
    false,
    "only Medical Reps are rated today",
  );
  assert.equal(
    canRateSkillsSurveyMember(viewer("District Manager", "D-1"), person("D-1", "Medical Representative", "D-1")),
    false,
    "nobody rates himself",
  );
  for (const role of ["National Sales Manager", "Regional Manager", "Training Manager", "CEO", "SFE Manager", "Super Admin"] as const) {
    assert.equal(canRateSkillsSurveyMember(viewer(role, "N-1"), rep), false, `${role} reads the survey but does not fill it`);
  }
  assert.equal(canRateSkillsSurveys(viewer("District Manager", null)), false, "a District Manager with no HR id rates nobody");
  assert.equal(canRateSkillsSurveys(viewer("District Manager", "D-1")), true);
}

function runWhoReads() {
  assert.equal(canReadSkillsSurveyMember(viewer("District Manager", "D-1"), rep, chain), true, "his own team");
  assert.equal(canReadSkillsSurveyMember(viewer("Regional Manager", "RM-1"), rep, chain), true, "the Regional Manager's chain");
  assert.equal(canReadSkillsSurveyMember(viewer("National Sales Manager", "N-1"), rep, chain), true, "the National Sales Manager's chain");
  assert.equal(canReadSkillsSurveyMember(viewer("National Sales Manager", "N-2"), rep, chain), false, "never outside the chain");
  assert.equal(canReadSkillsSurveyMember(viewer("District Manager", "D-2"), rep, chain), false, "never another District Manager's rep");
  assert.equal(
    canReadSkillsSurveyMember(viewer("District Manager", "D-2"), rep, chain, true),
    true,
    "a District Manager keeps reading the survey he saved after the rep moves team",
  );
  for (const role of ["CEO", "SFE Manager", "Training Manager", "Super Admin"] as const) {
    assert.equal(canReadSkillsSurveyMember(viewer(role, "X-1"), otherRep, chain), true, `${role} reads the whole company`);
  }
  for (const role of ["Medical Rep", "Employee", "Marketing Manager", "Product Manager", "Manager", "HR Operations"] as const) {
    assert.equal(canOpenSkillsSurvey(viewer(role, "R-2")), false, `${role} has no door into the survey`);
    assert.equal(canReadSkillsSurveyMember(viewer(role, "R-2"), rep, chain), false, `${role} reads no survey`);
  }
}

function runThePersonRatedNeverSeesIt() {
  for (const role of ["Medical Rep", "District Manager", "National Sales Manager", "CEO", "Training Manager", "Super Admin"] as const) {
    assert.equal(
      canReadSkillsSurveyMember(viewer(role, "R-1"), rep, chain, true),
      false,
      `the person rated never reads his own survey, even as ${role}`,
    );
  }
  assert.equal(isSkillsSurveySubject(viewer("Medical Rep", "r-1"), "R-1"), true, "HR ids match whatever their case");
  assert.equal(isSkillsSurveySubject(viewer("CEO", null), "R-1"), false);

  const service = stripComments(readFileSync(new URL("../src/lib/coaching/skills-survey/service.ts", import.meta.url), "utf8"));
  for (const name of ["getSkillsSurveyMemberForm", "saveSkillsSurvey", "getSkillsSurveyHistoryForMember"]) {
    const start = service.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} must exist in the survey service`);
    const end = service.indexOf("\nexport ", start + 1);
    const body = service.slice(start, end < 0 ? undefined : end);
    assert.match(body, /isSkillsSurveySubject\(access,/, `${name} must refuse the person rated before anything else`);
  }

  for (const path of [
    "../app/employee-portals/employee-360/[hrId]/page.tsx",
    "../app/(admin)/employee-360/[hrId]/page.tsx",
  ]) {
    const source = stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
    assert.match(
      source,
      /isSkillsSurveyMember\(target\)\s*&&\s*!isSkillsSurveySubject\(access, target\.hrId\)/,
      `${path} must pass the survey only when the viewer is not the person rated`,
    );
  }
  for (const path of [
    "../app/employee-portals/employee-360/page.tsx",
    "../app/employee-portals/page.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /skillsSurvey|SkillsSurveyHistory/, `${path} (a rep's own pages) must never carry the survey`);
  }
}

// YEARS OF EXPERIENCE (owner, 2026-10-31: "make hr or dm can fill years of experience of the rep").
// HR fills it on the Employee Master; the team member's own District Manager may fill or correct it
// on the survey form. The District Manager's write sits behind the own-team check, and the survey
// service is the only code outside the employee record's own module that writes it.
function runTheDistrictManagerFillsYears() {
  const service = stripComments(readFileSync(new URL("../src/lib/coaching/skills-survey/service.ts", import.meta.url), "utf8"));
  const start = service.indexOf("export async function saveSkillsSurvey(");
  assert.ok(start >= 0, "saveSkillsSurvey must exist in the survey service");
  const end = service.indexOf("\nexport ", start + 1);
  const save = service.slice(start, end < 0 ? undefined : end);
  const ownTeamCheck = save.indexOf("canRateSkillsSurveyMember(access, member)");
  const yearsWrite = save.indexOf("saveTotalExperienceYears(");
  assert.ok(ownTeamCheck >= 0, "saveSkillsSurvey must check the team member is the District Manager's own");
  assert.ok(yearsWrite >= 0, "the District Manager's years must be saved to the team member's record");
  assert.ok(
    yearsWrite > ownTeamCheck,
    "the District Manager writes a team member's years only after the check that the team member is his own",
  );
  assert.match(save, /years_in_role: yearsInRole/, "the survey keeps the years the District Manager just saved");

  const route = stripComments(readFileSync(new URL("../app/api/coaching/skills-survey/route.ts", import.meta.url), "utf8"));
  assert.match(route, /totalExperienceYears: body\.totalExperienceYears/,"the save route passes the typed years to the service");

  const form = stripComments(
    readFileSync(new URL("../src/components/coaching/skills-survey/skills-survey-form.tsx", import.meta.url), "utf8"),
  );
  assert.match(
    form,
    /totalExperienceYears: typedYears !== initialYears \? typedYears : undefined/,
    "the form sends the years only when the District Manager changed them, so an untouched box never restarts HR's as-of day",
  );
  assert.match(form, /form\.canEdit \? \([\s\S]{0,400}?<FormField/,"only the District Manager who may rate this survey gets the box");

  const writers: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name) && /saveTotalExperienceYears\(/.test(stripComments(readFileSync(child, "utf8")))) {
        writers.push(decodeURIComponent(child.pathname).replace(/^.*?\/(src|app)\//, "$1/"));
      }
    }
  };
  walk(new URL("../src/", import.meta.url));
  walk(new URL("../app/", import.meta.url));
  assert.deepEqual(
    writers.sort(),
    ["src/lib/coaching/skills-survey/service.ts", "src/lib/employees/total-experience.ts"],
    "only the survey save (and the helper itself) writes years through saveTotalExperienceYears",
  );
}

function runTheRepIsNeverTold() {
  for (const path of [
    "../src/lib/coaching/skills-survey/service.ts",
    "../src/lib/coaching/skills-survey/access.ts",
    "../app/api/coaching/skills-survey/route.ts",
    "../app/api/coaching/skills-survey/settings/route.ts",
  ]) {
    const imports = stripComments(readFileSync(new URL(path, import.meta.url), "utf8"))
      .split("\n")
      .filter((line) => /^\s*import\b|from\s+["']/.test(line))
      .join("\n");
    assert.doesNotMatch(
      imports,
      /notification|email|mail|telegram|resend|outbox|bell/i,
      `${path} must send nothing — the rep is never told about the survey`,
    );
  }
}

function runSettingsAndPermissions() {
  assert.equal(canEditSkillsSurveySettings(viewer("Training Manager", "T-1")), true);
  assert.equal(canEditSkillsSurveySettings(viewer("Super Admin", "B-10")), true);
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "CEO", "SFE Manager", "Medical Rep"] as const) {
    assert.equal(canEditSkillsSurveySettings(viewer(role, "X-1")), false, `${role} does not change the settings`);
  }

  const expected: Partial<Record<PhoenixRole, string[]>> = {
    CEO: ["read"],
    "District Manager": ["create", "read", "update"],
    "National Sales Manager": ["read"],
    "Regional Manager": ["read"],
    "SFE Manager": ["read"],
    "Super Admin": ["create", "read", "update"],
    "Training Manager": ["read", "update"],
  };
  for (const role of phoenixRoles) {
    const actions = [...(permissionMatrix[role].coaching_skills_survey ?? [])].sort();
    assert.deepEqual(actions, expected[role] ?? [], `${role}: coaching_skills_survey must be [${(expected[role] ?? []).join(", ")}]`);
  }
}

export function runCoachingSkillsSurveyAccessTests() {
  assert.equal(isSkillsSurveyMember(rep), true);
  assert.equal(isSkillsSurveyMember(dm), false);
  runWhoRates();
  runWhoReads();
  runThePersonRatedNeverSeesIt();
  runTheRepIsNeverTold();
  runTheDistrictManagerFillsYears();
  runSettingsAndPermissions();
}
