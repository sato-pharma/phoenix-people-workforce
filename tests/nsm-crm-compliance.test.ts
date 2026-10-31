import assert from "node:assert/strict";

import {
  EARLY_BIRD_LIMIT,
  buildNsmCrmCompliance,
  rosterCountedFromPhoenix,
} from "../src/lib/employee-portal/nsm-crm-compliance.ts";
import { normalizeHrIdForAccess } from "../src/lib/hr-id.ts";

// The NSM / RM "CRM First Visit" board and its Early Birds ranking. This rule shipped with no test
// at all and has already been repaired twice in production (#1192 canonical visit time, #1207 GPS
// correlation), so the invariants below are pinned deliberately:
//
//   - the ranked time is the matched GPS check-in, never the rep's own save time when a check-in exists;
//   - a submitted visit the vendor sent no clock for still RANKS (it used to vanish off the board);
//   - Early Birds keeps the first EARLY_BIRD_LIMIT submitters, and everyone past that cap simply
//     goes unlisted — they must never fall back into the red not-yet-submitted list;
//   - the red list means "no real field visit mirrored today" and nothing else.

const DAY = "2026-08-08";

type TestVisit = {
  agent_hr_id: string | null;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  double_hr_id: string | null;
  // Slot 2 — a chain visit's second partner. Required, not optional: the whole point of the slot is
  // that a reader cannot forget to ask for it, and an optional field here would let a test pass while
  // the production row silently carried `undefined`.
  double2_hr_id: string | null;
  crm_save_date: string | null;
  synced_at: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  contact_name: string | null;
  customer_name: string | null;
  comment: string | null;
};

type TestCheckin = {
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  check_date: string | null;
};

function visit(overrides: Partial<TestVisit> = {}): TestVisit {
  return {
    agent_hr_id: "B-100",
    agent_crm_id: 100,
    contact_crm_id: 555,
    double_hr_id: null,
    double2_hr_id: null,
    crm_save_date: `${DAY}T10:00:00+00:00`,
    synced_at: `${DAY}T10:05:00.000Z`,
    visit_type: 0,
    visit_type_description: "Regular Visit",
    contact_name: "د. أحمد سعيد",
    customer_name: null,
    comment: null,
    ...overrides,
  };
}

function checkin(overrides: Partial<TestCheckin> = {}): TestCheckin {
  return {
    agent_crm_id: 100,
    contact_crm_id: 555,
    check_date: `${DAY}T09:00:00+00:00`,
    ...overrides,
  };
}

export function runNsmCrmComplianceTests() {
  // ── The ranked time is the GPS check-in, not the save time ──────────────────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [{ hrId: "B-100", name: "Rep One" }],
      dsms: [],
      visits: [visit()],
      checkins: [checkin()],
    });

    assert.equal(data.synced, true, "one mirrored row means the day HAS synced");
    assert.equal(data.earlyBirds.length, 1);
    assert.equal(
      data.earlyBirds[0].at,
      "2026-08-08T09:00:00.000Z",
      "the 09:00 GPS check-in outranks the 10:00 save time — ranking on save time alone lets a rep who merely logged fast beat one who actually arrived earlier",
    );
    assert.equal(data.earlyBirds[0].source, "gps_checkin");
    assert.equal(data.earlyBirds[0].visitType, "Regular", "visit_type 0 shows as the compact 'Regular', not the vendor's longer 'Regular Visit'");
    assert.equal(data.earlyBirds[0].account, "د. أحمد سعيد", "the DM board names the account that first record was captured at");
    assert.equal(data.lastSyncAt, "2026-08-08T10:05:00.000Z");
    assert.deepEqual(data.reps.missing, [], "a submitter is never in the not-yet-submitted list");
  }

  // ── Campaign visits carry no account in the vendor feed — that must show as null ──
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [
        { hrId: "B-100", name: "Regular Rep" },
        { hrId: "B-101", name: "Campaign Rep" },
      ],
      dsms: [],
      visits: [
        // Regular: the account lives in contact_name (79,744 of 79,798 production rows).
        visit({ contact_crm_id: 0, crm_save_date: `${DAY}T09:00:00+00:00` }),
        // Campaign/Prospection: iReports360 sends NEITHER column — 0 of 30,367 rows carry an
        // account. `customer_name` is an empty string on every row in the mirror, which is why a
        // bare count(customer_name) misreads as ~30k populated.
        visit({
          agent_hr_id: "B-101",
          agent_crm_id: 101,
          contact_crm_id: 0,
          crm_save_date: `${DAY}T09:30:00+00:00`,
          visit_type: -8,
          visit_type_description: "Campaign (Prospection)",
          contact_name: null,
          customer_name: "",
        }),
      ],
      checkins: [],
    });

    assert.deepEqual(
      data.earlyBirds.map((b) => [b.visitType, b.account]),
      [
        ["Regular", "د. أحمد سعيد"],
        ["Campaign", null],
      ],
      "a Campaign visit has no account to show, so it must resolve to null (a dash on screen) — never to a substituted rep or customer name the rep never logged",
    );
  }

  // ── The account waterfall falls through to customer_name if it is ever filled ───
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [
        { hrId: "B-100", name: "Blank Contact" },
        { hrId: "B-101", name: "Whitespace Only" },
      ],
      dsms: [],
      visits: [
        visit({ contact_crm_id: 0, contact_name: null, customer_name: "صيدلية النور" }),
        visit({ agent_hr_id: "B-101", agent_crm_id: 101, contact_crm_id: 0, contact_name: "   ", customer_name: "  " }),
      ],
      checkins: [],
    });

    const byName = new Map(data.earlyBirds.map((b) => [b.name, b.account]));
    assert.equal(byName.get("Blank Contact"), "صيدلية النور", "customer_name is the defensive fallback for the day the vendor starts filling it");
    assert.equal(byName.get("Whitespace Only"), null, "a whitespace-only account name is no account at all");
  }

  // ── A submitted visit with NO usable clock still ranks (must not vanish) ────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [{ hrId: "B-100", name: "Rep One" }],
      dsms: [],
      // Campaign-style row: no real contact (so no check-in can ever match) and a midnight
      // crm_save_date, which the vendor writes as a date-only placeholder on ~3% of rows.
      visits: [visit({ contact_crm_id: 0, crm_save_date: `${DAY}T00:00:00+00:00` })],
      checkins: [],
    });

    assert.equal(data.reps.submitted, 1);
    assert.equal(
      data.earlyBirds.length,
      1,
      "a visit the vendor sent no clock for must still appear on the board — it used to be dropped, so the rep showed as neither an early bird nor missing",
    );
    assert.equal(data.earlyBirds[0].at, null, "no fabricated time: `at` is null and the UI renders a dash");
    assert.equal(data.earlyBirds[0].source, "none");
    assert.deepEqual(data.reps.missing, []);
  }

  // ── Timeless submitters rank LAST, never ahead of a real clock ──────────────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [
        { hrId: "B-100", name: "No Clock" },
        { hrId: "B-101", name: "Real Clock" },
      ],
      dsms: [],
      visits: [
        visit({ contact_crm_id: 0, crm_save_date: `${DAY}T00:00:00+00:00` }),
        visit({ agent_hr_id: "B-101", agent_crm_id: 101, contact_crm_id: 0, crm_save_date: `${DAY}T11:59:00+00:00` }),
      ],
      checkins: [],
    });

    assert.deepEqual(
      data.earlyBirds.map((b) => b.name),
      ["Real Clock", "No Clock"],
      "an 11:59 save time still beats a row with no clock at all — a missing time must sort last, not first",
    );
  }

  // ── The cap is EARLY_BIRD_LIMIT, and passing it never returns you to the red list ──
  {
    const reps = Array.from({ length: 12 }, (_, i) => ({
      hrId: `B-${200 + i}`,
      name: `Rep ${String(i + 1).padStart(2, "0")}`,
    }));
    const visits = reps.map((rep, i) =>
      visit({
        agent_hr_id: rep.hrId,
        agent_crm_id: 200 + i,
        contact_crm_id: 900 + i,
        crm_save_date: `${DAY}T09:${String(i + 1).padStart(2, "0")}:00+00:00`,
      }),
    );

    const data = buildNsmCrmCompliance({ date: DAY, reps, dsms: [], visits, checkins: [] });

    assert.equal(EARLY_BIRD_LIMIT, 10, "the owner asked for the first 10 med reps on the board");
    assert.equal(data.earlyBirds.length, EARLY_BIRD_LIMIT, "12 submitters, 10 chips");
    assert.equal(data.earlyBirds[0].name, "Rep 01", "earliest save time ranks first");
    assert.equal(data.earlyBirds[EARLY_BIRD_LIMIT - 1].name, "Rep 10");
    assert.equal(data.reps.submitted, 12, "all 12 still count as submitted");
    assert.deepEqual(
      data.reps.missing,
      [],
      "reps 11 and 12 submitted, so they drop off the green list WITHOUT reappearing in the red one — the two lists answer different questions",
    );
  }

  // ── District Manager board: uncapped, so nobody who submitted disappears ────────
  {
    const reps = Array.from({ length: 12 }, (_, i) => ({
      hrId: `B-${200 + i}`,
      name: `Rep ${String(i + 1).padStart(2, "0")}`,
    }));
    const visits = reps.map((rep, i) =>
      visit({
        agent_hr_id: rep.hrId,
        agent_crm_id: 200 + i,
        contact_crm_id: 900 + i,
        crm_save_date: `${DAY}T09:${String(i + 1).padStart(2, "0")}:00+00:00`,
      }),
    );
    // Plus one rep who logged nothing at all — the only person who may stay red.
    reps.push({ hrId: "B-999", name: "No Show" });

    const data = buildNsmCrmCompliance({
      date: DAY,
      reps,
      dsms: [],
      visits,
      checkins: [],
      limit: Number.POSITIVE_INFINITY,
    });

    assert.equal(
      data.earlyBirds.length,
      12,
      "a DM's board ranks every submitter — on a team this size a cap would hide reps the DM is meant to act on",
    );
    assert.equal(data.earlyBirds[11].name, "Rep 12", "the 12th submitter is still ranked, not dropped");
    assert.deepEqual(
      data.reps.missing.map((person) => person.hrId),
      ["B-999"],
      "only the rep with no record at all stays red; every submitter is green",
    );
    assert.equal(
      data.earlyBirds.length + data.reps.missing.length,
      reps.length,
      "green + red must account for the whole team — on the DM board nobody is invisible",
    );
  }

  // ── The red list holds only people with no field visit at all today ─────────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [
        { hrId: "B-100", name: "Submitted" },
        { hrId: "B-101", name: "Nothing Today" },
      ],
      dsms: [],
      visits: [visit()],
      checkins: [checkin()],
    });

    assert.equal(data.reps.submitted, 1);
    assert.deepEqual(
      data.reps.missing.map((person) => person.hrId),
      ["B-101"],
      "only the rep with zero mirrored rows stays red",
    );
  }

  // ── Only Regular (0) and Campaign (-8) are real field visits ────────────────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [
        { hrId: "B-100", name: "Campaign Rep" },
        { hrId: "B-101", name: "On Vacation" },
        { hrId: "B-102", name: "Positive Code" },
      ],
      dsms: [],
      visits: [
        visit({ contact_crm_id: 0, visit_type: -8, visit_type_description: "Campaign (Prospection)" }),
        visit({ agent_hr_id: "B-101", agent_crm_id: 101, visit_type: -4, visit_type_description: "Vacation" }),
        // No positive code exists in production today; the predicate used to accept `>= 0`, which
        // would silently count a future administrative code as fieldwork here and nowhere else.
        visit({ agent_hr_id: "B-102", agent_crm_id: 102, visit_type: 1, visit_type_description: "Some Future Admin Type" }),
      ],
      checkins: [],
    });

    assert.equal(data.reps.submitted, 1, "vacation and unknown positive codes are not submitted field visits");
    assert.equal(data.earlyBirds[0].visitType, "Campaign", "visit_type -8 shows as the compact 'Campaign'");
    assert.deepEqual(
      data.reps.missing.map((person) => person.hrId).sort(),
      ["B-101", "B-102"],
      "a positive visit_type must not count as fieldwork — the canonical list is exactly {0, -8}",
    );
  }

  // ── Tied times break by name, not by roster (achievement) order ─────────────────
  {
    const sameClock = `${DAY}T09:30:00+00:00`;
    const data = buildNsmCrmCompliance({
      date: DAY,
      // Roster order is achievement-sorted, so "Zoe" arrives first here on purpose.
      reps: [
        { hrId: "B-9", name: "Zoe Top Seller" },
        { hrId: "B-8", name: "Adam Low Seller" },
      ],
      dsms: [],
      visits: [
        visit({ agent_hr_id: "B-9", agent_crm_id: 9, contact_crm_id: 0, crm_save_date: sameClock }),
        visit({ agent_hr_id: "B-8", agent_crm_id: 8, contact_crm_id: 0, crm_save_date: sameClock }),
      ],
      checkins: [],
    });

    assert.deepEqual(
      data.earlyBirds.map((b) => b.name),
      ["Adam Low Seller", "Zoe Top Seller"],
      "an identical clock must break by name — sorting on time alone left ties in roster order, which ranks by sales figures and can swap between renders",
    );
  }

  // ── A DSM earns credit by accompanying a rep, not only by a solo visit ──────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [{ hrId: "B-100", name: "Rep One" }],
      dsms: [{ hrId: "B-500", name: "Dsm One" }],
      visits: [visit({ double_hr_id: "B-500" })],
      checkins: [checkin()],
    });

    assert.equal(data.dsms.submitted, 1, "riding along on a rep's visit counts as the DSM's own submission");
    assert.deepEqual(data.dsms.missing, []);
    assert.deepEqual(
      data.earlyBirds.map((b) => b.role).sort(),
      ["DSM", "Med Rep"],
      "both the visiting rep and the accompanying DSM rank off the same row",
    );
  }

  // ── Roster HR IDs match the mirror hyphen- and case-insensitively ───────────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [{ hrId: "b100", name: "Rep One" }],
      dsms: [],
      visits: [visit({ agent_hr_id: "B-100" })],
      checkins: [checkin()],
    });

    assert.equal(data.reps.submitted, 1, "canonical 'b100' and stored 'B-100' are the same person (hr-id hyphen trap)");
    assert.deepEqual(data.reps.missing, []);
  }

  // ── Nothing mirrored yet reads as "not synced", not as mass absence ─────────────
  {
    const data = buildNsmCrmCompliance({
      date: DAY,
      reps: [{ hrId: "B-100", name: "Rep One" }],
      dsms: [{ hrId: "B-500", name: "Dsm One" }],
      visits: [],
      checkins: [],
    });

    assert.equal(data.synced, false);
    assert.equal(data.lastSyncAt, null);
    assert.deepEqual(data.earlyBirds, []);
    assert.equal(data.reps.missing.length, 1, "before the sync lands everyone is listed as outstanding, but `synced: false` is what the UI reads");
    assert.equal(data.dsms.missing.length, 1);
  }

  // A ROSTER WHOLLY ON STARTED PHOENIX CRM TEAMS IS CHECKED NOW (owner, 2026-10-31). A per-team start
  // never sets the global cutover, so the board waited all day on the iReports360 pull for a team that
  // records its visits in Phoenix itself. Only a WHOLE roster counts — one rep still on the vendor keeps it.
  {
    const window = { hrIdKey: normalizeHrIdForAccess("B-158"), agentCrmId: null, from: "2026-10-03", until: null };
    const started = { hrId: "B-158", name: "Started Rep" };
    const vendor = { hrId: "B-999", name: "Vendor Rep" };
    assert.equal(rosterCountedFromPhoenix([window], [started], "2026-10-31"), true, "a started rep's day is Phoenix's to answer");
    assert.equal(rosterCountedFromPhoenix([window], [started, vendor], "2026-10-31"), false, "a mixed roster keeps the vendor ledger");
    assert.equal(rosterCountedFromPhoenix([window], [started], "2026-10-02"), false, "the day before his team's start is the vendor's");
    assert.equal(rosterCountedFromPhoenix([window], [], "2026-10-31"), false, "an empty roster is never counted from Phoenix");
    assert.equal(
      rosterCountedFromPhoenix([{ ...window, until: "2026-10-20" }], [started], "2026-10-31"),
      false,
      "a start that has ended no longer covers the day",
    );
  }
}
