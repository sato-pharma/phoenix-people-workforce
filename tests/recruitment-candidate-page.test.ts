import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  candidatePageHref,
  parseCandidatePageId,
  recruitmentRootFromPathname,
} from "../src/lib/recruitment/candidate-page-link.ts";
import { candidateRecordSections, type CandidateRecordSection } from "../src/lib/recruitment/candidate-record-fields.ts";
import { getCvPositionSchema, type CvPositionSchema } from "../src/lib/recruitment/cv-field-schemas.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// One candidate's own page — pressing a name opens everything on file for that person.
//
// The owner, 2026-09-18: "when I press on the name of the person, I am jumped to a new page which
// shows the full details on everything for this candidate." Pinned here:
//
//   1. the link stays in the shell it was pressed in (admin, /hr, portal);
//   2. an edited or cut-off link is refused before the database is asked;
//   3. the record prints every field on file, section by section, by the CV reader's own rules;
//   4. both routes carry the screening page's gate, the portal twin forwards the candidate;
//   5. the pool and WhatsApp Applicants names both open it;
//   6. the page is READ-ONLY: it never marks a CV read and never claims it for the viewer.
// ─────────────────────────────────────────────────────────────────────────────

const CANDIDATE_ID = "0b6f7a52-3a0e-4c1e-9d63-5a7c2f0e8b11";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** The source without its comments — the loader's own header says it never calls "the /seen route". */
function codeOnly(source: string): string {
  return stripComments(source);
}

function fakeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    createdAt: "2026-09-01T09:00:00.000Z",
    fullName: "Mona Adel",
    id: CANDIDATE_ID,
    positionSpecificFields: {},
    screeningExtraAnswers: {},
    status: "new",
    ...overrides,
  } as Candidate;
}

function section(sections: CandidateRecordSection[], key: string): CandidateRecordSection | undefined {
  return sections.find((entry) => entry.key === key);
}

function runLinkTests() {
  // ── 1 · The shell the name was pressed in ──────────────────────────────────
  assert.equal(recruitmentRootFromPathname("/recruitment"), "/recruitment");
  assert.equal(recruitmentRootFromPathname("/recruitment/whatsapp-applicants"), "/recruitment");
  assert.equal(recruitmentRootFromPathname("/hr/recruitment"), "/hr/recruitment", "the HR shell keeps the HR sidebar");
  assert.equal(recruitmentRootFromPathname("/hr/recruitment/whatsapp-applicants"), "/hr/recruitment");
  assert.equal(
    recruitmentRootFromPathname(`/hr/recruitment/candidate/${CANDIDATE_ID}`),
    "/hr/recruitment",
    "a link built on the candidate page itself stays in its shell",
  );
  assert.equal(recruitmentRootFromPathname("/employee-portals/recruitment"), "/employee-portals/recruitment");
  assert.equal(recruitmentRootFromPathname("/employee-portals/recruitment/screening"), "/employee-portals/recruitment");
  assert.equal(
    recruitmentRootFromPathname("/hr/recruitmentx"),
    "/recruitment",
    "a longer word is not under /hr/recruitment — it falls back rather than being claimed",
  );
  assert.equal(recruitmentRootFromPathname("/employee-portals/recruitment-archive"), "/recruitment");
  assert.equal(recruitmentRootFromPathname(""), "/recruitment");
  assert.equal(recruitmentRootFromPathname(null), "/recruitment");
  assert.equal(recruitmentRootFromPathname(undefined), "/recruitment");

  // ── 2 · The address ────────────────────────────────────────────────────────
  assert.equal(candidatePageHref("/recruitment", CANDIDATE_ID), `/recruitment/candidate/${CANDIDATE_ID}`);
  assert.equal(candidatePageHref("/hr/recruitment/", CANDIDATE_ID), `/hr/recruitment/candidate/${CANDIDATE_ID}`);
  assert.equal(
    candidatePageHref("/employee-portals/recruitment", CANDIDATE_ID),
    `/employee-portals/recruitment/candidate/${CANDIDATE_ID}`,
  );
  assert.equal(
    candidatePageHref("/recruitment", "a/../b?c"),
    "/recruitment/candidate/a%2F..%2Fb%3Fc",
    "an id is encoded, so it can never add a path segment or a query",
  );

  // ── 3 · The id, checked before the database is asked ───────────────────────
  assert.equal(parseCandidatePageId(CANDIDATE_ID), CANDIDATE_ID);
  assert.equal(parseCandidatePageId(CANDIDATE_ID.toUpperCase()), CANDIDATE_ID, "upper case is the same id");
  assert.equal(parseCandidatePageId(`  ${CANDIDATE_ID}  `), CANDIDATE_ID);
  assert.equal(parseCandidatePageId([CANDIDATE_ID, "other"]), CANDIDATE_ID);
  assert.equal(parseCandidatePageId(CANDIDATE_ID.slice(0, 30)), null, "a cut-off link is not an id");
  assert.equal(parseCandidatePageId(`${CANDIDATE_ID}0`), null);
  assert.equal(parseCandidatePageId("not-a-candidate"), null);
  assert.equal(parseCandidatePageId("%"), null, "a malformed escape is refused, not thrown");
  assert.equal(parseCandidatePageId(""), null);
  assert.equal(parseCandidatePageId([]), null);
  assert.equal(parseCandidatePageId(null), null);
  assert.equal(parseCandidatePageId(undefined), null);
  assert.equal(
    parseCandidatePageId(candidatePageHref("/recruitment", CANDIDATE_ID).split("/").pop()),
    CANDIDATE_ID,
    "the page reads back exactly the id the link was built from",
  );
}

function runRecordSectionTests(schema: CvPositionSchema) {
  // ── 4 · A thin record reads short ──────────────────────────────────────────
  const bare = candidateRecordSections(fakeCandidate(), schema);
  assert.deepEqual(
    bare.map((entry) => entry.key),
    ["identity"],
    "a section with nothing in it is dropped rather than printed as an empty heading",
  );
  assert.deepEqual(bare[0]?.rows, [{ key: "fullName", kind: "text", label: "Full name", text: "Mona Adel" }]);

  // ── 5 · Irrelevant says so ─────────────────────────────────────────────────
  const woman = section(candidateRecordSections(fakeCandidate({ gender: "Female" }), schema), "personal");
  assert.deepEqual(
    woman?.rows.find((row) => row.key === "militaryStatus"),
    { key: "militaryStatus", kind: "irrelevant", label: "Military status" },
    "military service for a woman reads Irrelevant — it neither vanishes nor reads blank",
  );
  assert.deepEqual(
    section(candidateRecordSections(fakeCandidate({ gender: "أنثى", militaryStatus: "Exempted" }), schema), "personal")?.rows.find(
      (row) => row.key === "militaryStatus",
    ),
    { key: "militaryStatus", kind: "irrelevant", label: "Military status" },
    "the Arabic answer counts, and a stale value under it is not printed as though it applied",
  );
  assert.deepEqual(
    section(candidateRecordSections(fakeCandidate({ militaryStatus: "Completed" }), schema), "personal")?.rows.find(
      (row) => row.key === "militaryStatus",
    ),
    { key: "militaryStatus", kind: "text", label: "Military status", text: "Completed" },
    "an unstated gender leaves military service an ordinary answer",
  );

  // ── 6 · A follow-up is only printed when its question was asked ────────────
  const noRep = section(
    candidateRecordSections(fakeCandidate({ hasMedicalRepExperience: false, medicalRepEmployer: "Pharco" }), schema),
    "pharma",
  );
  assert.ok(noRep, "`false` is an answer, so the section it sits in is kept");
  assert.deepEqual(noRep.rows.find((row) => row.key === "hasMedicalRepExperience"), {
    key: "hasMedicalRepExperience",
    kind: "text",
    label: "Medical Rep experience",
    text: "No",
  });
  assert.equal(
    noRep.rows.some((row) => row.key === "medicalRepEmployer"),
    false,
    "the rep employer is not asked of someone with no rep experience",
  );
  const rep = section(
    candidateRecordSections(fakeCandidate({ hasMedicalRepExperience: true, medicalRepEmployer: "Pharco" }), schema),
    "pharma",
  );
  assert.deepEqual(rep?.rows.find((row) => row.key === "hasMedicalRepExperience")?.kind, "text");
  assert.deepEqual(rep?.rows.find((row) => row.key === "medicalRepEmployer"), {
    key: "medicalRepEmployer",
    kind: "text",
    label: "Medical Rep employer",
    text: "Pharco",
  });

  // ── 7 · Repeating blocks: one entry per job, nothing invented ──────────────
  const history = section(
    candidateRecordSections(
      fakeCandidate({
        positionSpecificFields: {
          workHistory: [
            { employer: "Pharco", from: "2021-03-01", jobTitle: "Medical Representative", to: null },
            { employer: "  ", jobTitle: "" },
            "not an entry",
            { employer: "EIPICO", location: "Tanta" },
          ],
        },
      }),
      schema,
    ),
    "history",
  );
  const workHistory = history?.rows.find((row) => row.key === "workHistory");
  assert.ok(workHistory && workHistory.kind === "entries", "a work history on file prints as entries");
  assert.deepEqual(
    workHistory.entries,
    [
      [
        { label: "Employer", text: "Pharco" },
        { label: "Job title", text: "Medical Representative" },
        { label: "From", text: "2021-03-01" },
      ],
      [
        { label: "Employer", text: "EIPICO" },
        { label: "Location", text: "Tanta" },
      ],
    ],
    "a blank line is left out, and an entry with nothing in it is not printed as an empty job",
  );
  assert.equal(
    section(candidateRecordSections(fakeCandidate({ positionSpecificFields: { workHistory: [] } }), schema), "history"),
    undefined,
    "an empty history is no section at all",
  );
  const education = section(
    candidateRecordSections(
      fakeCandidate({
        positionSpecificFields: {
          educationHistory: [{ degree: "BSc Pharmacy", institution: "Cairo University", year: 2019 }],
        },
      }),
      schema,
    ),
    "history",
  )?.rows.find((row) => row.key === "educationHistory");
  assert.ok(education && education.kind === "entries", "an education history on file prints as entries");
  assert.deepEqual(
    education.entries,
    [
      [
        { label: "Institution", text: "Cairo University" },
        { label: "Degree", text: "BSc Pharmacy" },
        { label: "Year", text: "2019" },
      ],
    ],
    "a year saved as a number prints as the year, in the schema's own order",
  );
}

function runRouteTests() {
  const adminPage = read("app/(admin)/recruitment/candidate/[id]/page.tsx");
  const portalPage = read("app/employee-portals/recruitment/candidate/[id]/page.tsx");

  // ── 8 · The screening page's gate, on both routes ──────────────────────────
  assert.match(
    adminPage,
    /if \(!isHrAuthorityRole\(access\.role\) \|\| !\(await canAccess\(access, "recruitment", "read"\)\)\) \{\s*redirect\("\/employee-portals"\);/,
    "the admin page carries the recruitment module's own gate",
  );
  assert.match(
    portalPage,
    /if \(!isHrAuthorityRole\(access\.role\) \|\| !\(await canAccess\(access, "recruitment", "read"\)\)\) \{/,
    "the portal page carries the same gate",
  );
  for (const [name, source] of [
    ["admin", adminPage],
    ["portal", portalPage],
  ] as const) {
    assert.match(
      source,
      /canAccess\(access, "candidates", "read"\)/,
      `the ${name} page also needs the candidate pool's read grant, as screening does`,
    );
    assert.ok(
      source.indexOf("parseCandidatePageId(") >= 0 &&
        source.indexOf("parseCandidatePageId(") < source.indexOf("await loadCandidateRecord("),
      `the ${name} page checks the id before it asks the database`,
    );
    assert.match(source, /This candidate is not in the system\./, `the ${name} page says so when there is nobody to show`);
  }

  // ── 9 · The portal twin forwards the person, not just the module ───────────
  assert.match(
    portalPage,
    /if \(resolveNavigationMode\(access\) !== "employee-portal"\) \{[\s\S]{0,400}?redirect\(candidateId \? candidatePageHref\("\/recruitment", candidateId\) : "\/recruitment"\);/,
    "an admin-shell viewer on a portal link lands on that same candidate's admin page, rebuilt from the checked id",
  );
}

function runLinkWiringTests() {
  // ── 10 · Every name that should open the page does ─────────────────────────
  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    workspace,
    /const candidatePageRoot = recruitmentRootFromPathname\(poolPathname\);/,
    "the pool builds a name's link in the shell it is in, so an HR seat keeps the HR sidebar",
  );
  assert.match(
    workspace,
    /<a\s+className="[^"]*"\s+href=\{candidatePageHref\(candidatePageRoot, candidate\.id\)\}\s+rel="noopener"\s+target="_blank"\s+title=\{candidate\.fullName\}\s*>\s*\{displayName\}\s*<\/a>/,
    "the pool table's name opens the candidate's page in a new tab, and keeps the full stored name on hover",
  );
  assert.match(
    workspace,
    /candidateHref=\{candidatePageHref\(candidatePageRoot, candidate\.id\)\}/,
    "the phone card gets the same address",
  );
  assert.match(
    workspace,
    /href=\{candidateHref\}\s+rel="noopener"\s+target="_blank"\s+title=\{candidate\.fullName\}\s*>\s*\{candidateDisplayName\(candidate\.fullName\)\}/,
    "the phone card's name is the link",
  );
  assert.match(
    read("src/components/recruitment/whatsapp-applicants-search.tsx"),
    /href=\{candidatePageHref\(pool, row\.candidateId\)\}/,
    "a name on WhatsApp Applicants opens the candidate's page too",
  );
}

function runReadOnlyTests() {
  // ── 11 · Looking a person up never touches their place in anyone's queue ───
  //
  // Opening a CV on the screening page marks it read for the opener and holds it for them. A
  // look-up that did either would pull the CV out of a colleague's queue, or drop it from the
  // reader's own "not read yet" pile without their having screened it.
  const sources = [
    "src/components/recruitment/candidate-record-page.tsx",
    "src/lib/recruitment/candidate-record.ts",
    "app/(admin)/recruitment/candidate/[id]/page.tsx",
    "app/employee-portals/recruitment/candidate/[id]/page.tsx",
  ];
  for (const file of sources) {
    const source = codeOnly(read(file));
    assert.doesNotMatch(source, /\/seen\b/, `${file} must never call the route that marks a CV read`);
    assert.doesNotMatch(source, /markCandidateSeen/, `${file} must never mark a CV read`);
    assert.doesNotMatch(source, /\b(postJson|patchJson|deleteRequest)\(/, `${file} must not write anything`);
    assert.doesNotMatch(source, /method:\s*"(POST|PATCH|PUT|DELETE)"/, `${file} must not write anything`);
  }
  // The pieces it borrows from the screening workstation. Marking a CV read lives in the
  // workstation itself (screening-workstation.tsx), never in these, and has to stay that way while
  // this page draws them. (The notes tab does write — a note — but only behind canWrite, below.)
  for (const file of [
    "src/components/recruitment/candidate-facts-summary.tsx",
    "src/components/recruitment/workstation/workstation-cv-pane.tsx",
    "src/components/recruitment/workstation/workstation-history-tabs.tsx",
  ]) {
    const source = codeOnly(read(file));
    assert.doesNotMatch(source, /\/seen\b/, `${file} is drawn on the read-only candidate page, so it must not mark a CV read`);
    assert.doesNotMatch(source, /markCandidateSeen/, `${file} is drawn on the read-only candidate page`);
  }
  const page = codeOnly(read("src/components/recruitment/candidate-record-page.tsx"));
  assert.match(page, /<WorkstationNotesTab canWrite=\{false\}/, "notes are shown without a note box");
  assert.match(
    page,
    /href=\{screeningHref\(root, \{ candidate: candidate\.id, status: candidateDecisionTabOf\(candidate\.status\) \}\)\}/,
    "a decision is one click away, on the screening page, in the same shell, on the tab this CV sits on",
  );
}

export function runRecruitmentCandidatePageTests() {
  const schema = getCvPositionSchema("universal");
  assert.ok(schema, "the universal CV schema must resolve — every candidate record is read through it");
  runLinkTests();
  runRecordSectionTests(schema);
  runRouteTests();
  runLinkWiringTests();
  runReadOnlyTests();
}
