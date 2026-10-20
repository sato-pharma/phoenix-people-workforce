import assert from "node:assert/strict";

import {
  DIRECT_REPORTS_DISTRICT_NAME,
  assertDistrictInScope,
  assertRepInRoster,
  resolveEarlyBirdsScopeFrom,
  type EarlyBirdsScopeRow,
} from "../src/lib/early-birds/permissions.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

// Who sees which district. This is the module's security boundary: a mistake here shows one
// business line's reps to another line's manager.
//
// It exists because that happened in production. Every National Sales Manager reports to the CEO,
// and the CEO directly manages six Anti-Infective reps — so the CEO is himself a "district". The
// "a rep sees his own manager's district" branch was not gated to actual reps, so it fired for the
// NSMs and handed all three of them the CEO's district instead of their own line. A CNS NSM was
// looking at Anti-Infective reps.

const LINE_AI = 1;
const LINE_PEDIA = 2;
const LINE_CNS = 3;

function row(overrides: Partial<EarlyBirdsScopeRow> & { hrId: string }): EarlyBirdsScopeRow {
  return {
    displayName: overrides.hrId,
    managerHrId: null,
    lineId: null,
    jobTitle: "Medical Representative",
    positionTitle: null,
    ...overrides,
  };
}

/** Mirrors the real shape: DSMs report to the CEO on some lines, to the NSM on others. */
const DIRECTORY: EarlyBirdsScopeRow[] = [
  row({ hrId: "AA", displayName: "Dr Anwar Gaweesh", jobTitle: "Ceo", lineId: 4 }),
  // Anti-Infective: NSM plus two districts that report to the CEO, NOT to him.
  row({ hrId: "AI-0008", displayName: "AI NSM", jobTitle: "National Sales Manager", lineId: LINE_AI, managerHrId: "AA" }),
  row({ hrId: "AI-0001", displayName: "AI DSM One", jobTitle: "District Sales Manager", lineId: LINE_AI, managerHrId: "AA" }),
  row({ hrId: "B-12", displayName: "AI DSM Two", jobTitle: "District Sales Manager", lineId: LINE_AI, managerHrId: "AA" }),
  row({ hrId: "AI-R1", displayName: "AI Rep One", lineId: LINE_AI, managerHrId: "AI-0001" }),
  // An ACTING district manager who is still titled "Medical Representative" and reports straight to
  // the NSM. Real: B-1 holds SEAT-AIF-ADM-UE-1 while carrying a rep job title.
  row({ hrId: "AI-ADM", displayName: "AI Acting DM", lineId: LINE_AI, managerHrId: "AI-0008" }),
  row({ hrId: "AI-R4", displayName: "AI Rep Four", lineId: LINE_AI, managerHrId: "AI-ADM" }),
  row({ hrId: "AI-R2", displayName: "AI Rep Two", lineId: LINE_AI, managerHrId: "B-12" }),
  // The CEO directly manages a rep, which is what makes him a "district" at all.
  row({ hrId: "AI-R3", displayName: "AI Rep Three", lineId: LINE_AI, managerHrId: "AA" }),
  // CNS: districts DO report to their NSM.
  row({ hrId: "B-122", displayName: "CNS NSM", jobTitle: "National Sales Manager", lineId: LINE_CNS, managerHrId: "AA" }),
  row({ hrId: "B-118", displayName: "CNS DSM", jobTitle: "District Sales Manager", lineId: LINE_CNS, managerHrId: "B-122" }),
  row({ hrId: "CNS-R1", displayName: "CNS Rep", lineId: LINE_CNS, managerHrId: "B-118" }),
  // Pedia.
  row({ hrId: "A-12", displayName: "Pedia NSM", jobTitle: "National Sales Manager", lineId: LINE_PEDIA, managerHrId: "AA" }),
  row({ hrId: "B-94", displayName: "Pedia DSM", jobTitle: "District Sales Manager", lineId: LINE_PEDIA, managerHrId: "A-12" }),
  row({ hrId: "PD-R1", displayName: "Pedia Rep", lineId: LINE_PEDIA, managerHrId: "B-94" }),
];

function viewer(hrId: string, role: string): AccessContext {
  return { hrId, loginId: hrId, role: role as AccessContext["role"], scope: "line", source: "system" };
}

const keys = (scope: { districts: Array<{ hrIdKey: string }> }) =>
  scope.districts.map((district) => district.hrIdKey).sort();

export function runEarlyBirdsScopeTests() {
  // ── An NSM is never his OWN district ────────────────────────────────────────────
  //
  // Checked FIRST so that a failure names the rule that broke rather than surfacing as a diff in
  // the district list below.
  {
    // The second defect, and it only appeared once the DATA was correct. Districts are inferred
    // from "who manages a medical rep", and an ACTING DM can still be titled "Medical
    // Representative". The moment that acting DM's manager row was repaired to point at her NSM,
    // the NSM satisfied the "viewer is himself a district" test and saw exactly one district:
    // himself.
    const ai = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("AI-0008", "National Sales Manager"));
    assert.equal(
      ai.districts.some((district) => district.hrIdKey === "ai0008"),
      false,
      "a National Sales Manager must never appear as a district of his own board",
    );
    assert.equal(
      ai.districts.some((district) => district.hrIdKey === "aiadm"),
      true,
      "but the acting DM reporting to him IS one of his districts, even though she is titled a rep",
    );
    assert.ok(ai.districts.length >= 3, "and he keeps his real districts rather than collapsing to himself");
  }

  // ── An NSM is scoped by LINE, never by the reporting tree ───────────────────────
  {
    const ai = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("AI-0008", "National Sales Manager"));
    assert.deepEqual(
      keys(ai),
      ["ai0001", "aiadm", "b12"],
      "the Anti-Infective NSM sees his own line's districts — including the acting DM who reports directly to him, and never himself",
    );
    assert.equal(
      ai.districts.some((district) => district.hrIdKey === "aa"),
      false,
      "and never the CEO's district, which is what he was actually being shown",
    );

    const cns = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("B-122", "National Sales Manager"));
    assert.deepEqual(keys(cns), ["b118"], "the CNS NSM sees only CNS");
    assert.deepEqual(
      keys(resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("A-12", "National Sales Manager"))),
      ["b94"],
      "and Pedia only Pedia",
    );
  }

  // ── No line's manager can ever see another line ─────────────────────────────────
  {
    for (const [hrId, forbidden] of [
      ["AI-0008", "b118"],
      ["B-122", "ai0001"],
      ["A-12", "b118"],
    ] as const) {
      const scope = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer(hrId, "National Sales Manager"));
      assert.equal(
        scope.districts.some((district) => district.hrIdKey === forbidden),
        false,
        `${hrId} must never see district ${forbidden} — that is a cross-line data leak`,
      );
    }
  }

  // ── The manager's-district branch is gated to ACTUAL medical reps ───────────────
  {
    // The exact defect: the NSM's manager is the CEO, and the CEO manages reps, so an ungated
    // branch handed the NSM the CEO's district.
    const rep = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("AI-R1", "Medical Rep"));
    assert.deepEqual(keys(rep), ["ai0001"], "a real rep still sees the district he competes in");

    const nsm = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("AI-0008", "National Sales Manager"));
    assert.equal(
      nsm.districts.length > 1,
      true,
      "while a manager whose own manager happens to manage reps must NOT be treated as one of those reps",
    );
  }

  // ── A District Manager still sees exactly his own district ──────────────────────
  {
    const dm = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("B-118", "District Manager"));
    assert.deepEqual(keys(dm), ["b118"]);
    assert.equal(dm.scopeLabel, "your team");
  }

  // ── Executives see everything; nobody else falls open ───────────────────────────
  {
    const ceo = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("AA", "CEO"));
    assert.equal(ceo.isCompanyWide, true);
    // Seven: the five real districts, the acting DM, and the NSM above her — because districts are
    // inferred from "manages someone titled a medical rep" and the acting DM carries that title.
    // Cosmetic on a company-wide board, and the reason the ordering guard above has to exist at all.
    assert.equal(ceo.districts.length, 7, "every manager who has at least one rep reporting to him");

    const stranger = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("NOBODY", "Manager"));
    assert.deepEqual(stranger.districts, [], "an unknown viewer fails CLOSED, never to the whole company");
  }

  // ── A district named in the URL is validated against the viewer's scope ─────────
  {
    const cns = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("B-122", "National Sales Manager"));
    assert.equal(
      assertDistrictInScope(cns, "AI-0001"),
      null,
      "?district= must never read a line the viewer does not own",
    );
    assert.equal(assertDistrictInScope(cns, "B-118")?.hrIdKey, "b118");
    assert.equal(assertDistrictInScope(cns, null)?.hrIdKey, "b118", "no district named falls back to the first in scope");
  }

  // ── An unreadable directory is DISTINGUISHABLE from an empty one ────────────────
  {
    // resolveEarlyBirdsScope used to end in `.catch(() => [])`, so a database outage produced the
    // same shape as an honest empty scope: zero districts, scopeLabel "your team". The board then
    // told a National Sales Manager with six districts that none reported to him. It fooled a live
    // debugging session with the real data on screen; it would fool a manager at 08:00.
    //
    // The scope object must therefore carry WHY it is empty, and an honest empty scope must not
    // claim an outage.
    const outage = resolveEarlyBirdsScopeFrom([], viewer("AI-0008", "National Sales Manager"));
    assert.deepEqual(outage.districts, [], "no directory means no districts — still fails closed");
    assert.equal(
      outage.directoryUnavailable,
      true,
      "an empty directory must be reported as an OUTAGE, not as an empty scope the viewer can believe",
    );

    const populated = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("AI-0008", "National Sales Manager"));
    assert.equal(
      populated.directoryUnavailable,
      false,
      "a scope resolved from a real directory must never claim the directory was unavailable",
    );

    // The honest-empty case: the directory WAS read, and this viewer genuinely owns nothing in it.
    const genuinelyEmpty = resolveEarlyBirdsScopeFrom(DIRECTORY, viewer("NOBODY", "Manager"));
    assert.deepEqual(genuinelyEmpty.districts, []);
    assert.equal(
      genuinelyEmpty.directoryUnavailable,
      false,
      "an empty scope over a healthy directory is an ANSWER, and must not be reported as an outage",
    );
  }

  // ── The ?rep= guard ─────────────────────────────────────────────────────────────
  // A second URL parameter reaching for a person, added 2026-09-18 with the rep record panel. The
  // district gate above has already decided WHOSE reps this viewer may read; this narrows it to one
  // of them, and it is checked against the ROSTER of the district and fortnight already on screen —
  // data the viewer is authorised to see by construction — rather than against a second permission
  // model that could drift out of step with the first.
  {
    const roster = [
      { hrId: "B-100", hrIdKey: "b100", name: "Ahmed Mohamed" },
      { hrId: "B-101", hrIdKey: "b101", name: "Mona Saleh" },
    ];

    assert.deepEqual(
      assertRepInRoster(roster, "B-101"),
      roster[1],
      "a rep who IS in this district's ranking opens normally",
    );

    // ── HEADLINE: it REFUSES, it does not substitute ───────────────────────────────
    // Unlike assertDistrictInScope, which defaults to the viewer's first district when nothing is
    // named, an unknown rep must come back null. Falling back to roster[0] would open one man's
    // start times under the name of another, on a board whose whole subject is who arrives first.
    assert.equal(
      assertRepInRoster(roster, "B-999"),
      null,
      "a rep outside this roster must REFUSE. Returning the first rep instead would show one " +
        "person's start times while the URL names another.",
    );

    // Nor may it be used to probe for HR ids: outside the roster is indistinguishable from
    // does-not-exist, because both answer null.
    assert.equal(assertRepInRoster(roster, "B-102"), null);

    assert.equal(assertRepInRoster(roster, undefined), null, "no ?rep= opens no panel");
    assert.equal(assertRepInRoster(roster, null), null);
    assert.equal(assertRepInRoster(roster, ""), null);
    assert.equal(assertRepInRoster([], "B-100"), null, "an empty roster grants nothing");

    // Same rep, four spellings. employee_hr_id_compact stores normalizeHrIdForAccess's output, and
    // a link built from stored casing must still match the row it points at.
    for (const spelling of ["B-100", "b100", "B100", " b-100 "]) {
      assert.deepEqual(
        assertRepInRoster(roster, spelling),
        roster[0],
        `"${spelling}" must resolve to the same rep as "B-100" — the ids on this board come from ` +
          `three different sources and none of them agree on hyphens or case`,
      );
    }
  }

  runVacantSeatScopeTests();
}

/**
 * Owner, 2026-10-20: "when filter by manager u find no manager … u find no field force." A rep
 * under a VACANT district seat reports straight to the NSM in the directory (production:
 * AI-0029, under the vacant Alex-BHR seat, reports to AI-0008), and the NSM's board dropped his own
 * key unconditionally — so that rep was on no board her NSM could open. Equally, reps whose manager
 * has LEFT still point at him, and that district fell off every line.
 */
function runVacantSeatScopeTests() {
  const directory: EarlyBirdsScopeRow[] = [
    ...DIRECTORY,
    // A medical rep reporting straight to the AI NSM — the vacant district's rep. NOT a district.
    row({ hrId: "AI-0029", displayName: "AI Direct Rep", lineId: LINE_AI, managerHrId: "AI-0008", regionName: "Alexandria" }),
    // Two reps whose District Manager left (no directory row): one AI, one CNS.
    row({ hrId: "AI-R9", displayName: "AI Orphan Rep", lineId: LINE_AI, managerHrId: "AI-0050", regionName: "Delta" }),
    row({ hrId: "CNS-R9", displayName: "CNS Orphan Rep", lineId: LINE_CNS, managerHrId: "CNS-0099", regionName: "Giza" }),
    // Pedia's Regional Manager: a District Manager under him, and a rep reporting straight to him.
    row({ hrId: "PD-0001", displayName: "Pedia RSM", jobTitle: "Regional Sales Manager", lineId: LINE_PEDIA, managerHrId: "A-12" }),
    row({ hrId: "PD-DM2", displayName: "Pedia DSM Two", jobTitle: "District Sales Manager", lineId: LINE_PEDIA, managerHrId: "PD-0001" }),
    row({ hrId: "PD-R2", displayName: "Pedia Rep Two", lineId: LINE_PEDIA, managerHrId: "PD-DM2" }),
    row({ hrId: "PD-R7", displayName: "Pedia Direct Rep", lineId: LINE_PEDIA, managerHrId: "PD-0001" }),
  ];

  // ── The NSM keeps the reps who report straight to him ───────────────────────────
  const ai = resolveEarlyBirdsScopeFrom(directory, viewer("AI-0008", "National Sales Manager"));
  assert.deepEqual(
    keys(ai),
    ["ai0001", "ai0008", "ai0050", "aiadm", "b12"],
    "the AI NSM sees his own direct reps and the district whose manager left, beside his real districts",
  );
  const own = ai.districts.find((district) => district.hrIdKey === "ai0008");
  assert.equal(own?.name, DIRECT_REPORTS_DISTRICT_NAME, "his own district reads as his direct reports, never his own name");
  assert.equal(own?.hrId, "AI-0008", "and opens his own reps' board");

  // ── A district whose manager left is named by its region, never by an HR id ─────
  const vacant = ai.districts.find((district) => district.hrIdKey === "ai0050");
  assert.equal(vacant?.name, "Vacant — Delta");
  assert.equal(vacant?.hrId, "AI-0050", "the stored spelling, so the board's manager_hr_id reads still match it");
  assert.equal(
    ai.districts.some((district) => district.hrIdKey === "cns0099"),
    false,
    "a vacant district on ANOTHER line is never his — the line guard holds for vacant districts too",
  );
  assert.deepEqual(
    keys(resolveEarlyBirdsScopeFrom(directory, viewer("B-122", "National Sales Manager"))),
    ["b118", "cns0099"],
    "the CNS NSM gets the CNS vacant district, and still never himself (no rep reports straight to him)",
  );
  const ceo = resolveEarlyBirdsScopeFrom(directory, viewer("AA", "CEO"));
  assert.equal(
    ceo.districts.find((district) => district.hrIdKey === "cns0099")?.name,
    "Vacant — Giza",
    "a company-wide viewer sees the vacant district by name too, never as a code",
  );

  // ── A Regional Manager with a direct rep still sees every district under him ────
  // He manages a rep, so he IS a district; the District Manager branch used to stop there and
  // show him only his own direct reps.
  const rsm = resolveEarlyBirdsScopeFrom(directory, viewer("PD-0001", "Regional Manager"));
  assert.deepEqual(keys(rsm), ["pd0001", "pddm2"], "his own direct reps AND the districts under him");
  assert.equal(rsm.districts.find((district) => district.hrIdKey === "pd0001")?.name, DIRECT_REPORTS_DISTRICT_NAME);

  // The District Manager rule is unchanged for a real District Manager.
  assert.deepEqual(keys(resolveEarlyBirdsScopeFrom(directory, viewer("PD-DM2", "District Manager"))), ["pddm2"]);
}
