import assert from "node:assert/strict";

import {
  candidateManagerSeatTier,
  managerSeatCanReceive,
  seatTierRank,
} from "../src/lib/recruitment/candidate-seat-rank.ts";
import {
  boardsForManager,
  managerApplicantBoards,
  placeCandidatesInDistrictFolders,
  type DistrictFolderCandidate,
  type DistrictSeatRow,
} from "../src/lib/recruitment/district-manager-folders.ts";

/**
 * "The district managers receive medical reps and the national sales managers receive district
 *  managers and medical reps. A district manager never receives district manager."
 *                                                                     — the owner, 2026-09-09
 *
 * THE BUG THIS PINS WAS LIVE AND NAMED. Measured on production that day, 135 of the 537 CVs eligible
 * to reach a folder carried a district-manager job title, and every one of them was being filed into
 * the folders of the district managers whose own post they were applying for — the Anti Infective
 * and CNS Upper Egypt managers were each holding a dozen applicants for their own seat, in their own
 * region. Nothing on the screen said so, because a folder full of CVs is what a working folder looks
 * like.
 *
 * TWO HALVES, AND ONLY ONE OF THEM IS THE OWNER'S SENTENCE. Dropping those CVs off the district
 * boards is the half he said out loud; sending them UP to the manager above is the half that stops
 * the fix from being worse than the bug, because a CV nobody can see reads as "nobody applied".
 * Every assertion below is one of those two, and the fixture is production's real shape: three
 * lines, one regional sales manager with three districts under him, an acting DM, and a vacant
 * district whose folders climb to the national sales manager.
 */

function seat(fields: Partial<DistrictSeatRow>): DistrictSeatRow {
  return { is_vacant: false, ...fields };
}

const ROWS: DistrictSeatRow[] = [
  seat({ line_name: "Anti Infective", occupant_hr_id: "AI-0008", seat_display_label: "ANTI_INFECTIVE NSM", seat_id: "nsm-ai", seat_tier: "NSM" }),
  seat({ line_name: "Pedia", occupant_hr_id: "a-12", seat_display_label: "PEDIA NSM", seat_id: "nsm-pd", seat_tier: "NSM" }),
  // The regional seat that makes the ladder more than two rungs. Alex-BHR sits under him, and he
  // sits under the Pedia NSM — so BOTH of them are entitled to an Alex-BHR district-manager CV.
  seat({ line_name: "Pedia", occupant_hr_id: "pd-0001", parent_seat_id: "nsm-pd", seat_display_label: "PEDIA RSM (Alex-BHR)", seat_id: "rsm-pd", seat_tier: "RSM" }),

  // ── Anti Infective · Cairo — occupied ──────────────────────────────────────────────────────────
  seat({ line_name: "Anti Infective", occupant_hr_id: "AI-0001", parent_seat_id: "nsm-ai", region_name: "Cairo", seat_display_label: "ANTI_INFECTIVE Cairo DM", seat_id: "ai-cairo", seat_tier: "DM" }),
  seat({ area_name: "Nasr City", parent_seat_id: "ai-cairo", seat_id: "ai-cairo-1", seat_tier: "REP" }),

  // ── Anti Infective · Upper Egypt 1 — a REP acting as the district manager ──────────────────────
  seat({ line_name: "Anti Infective", occupant_hr_id: "B-1", parent_seat_id: "nsm-ai", region_name: "Upper Egypt 1", seat_display_label: "ANTI_INFECTIVE Upper Egypt 1 acting DM", seat_id: "ai-ue1", seat_tier: "ACTING_DM" }),
  seat({ area_name: "Qena 1", parent_seat_id: "ai-ue1", seat_id: "ai-ue1-1", seat_tier: "REP" }),

  // ── Pedia · Alex-BHR — under the REGIONAL manager, not straight under the NSM ──────────────────
  seat({ line_name: "Pedia", occupant_hr_id: "pd-0010", parent_seat_id: "rsm-pd", region_name: "Alex-BHR", seat_display_label: "PEDIA Alex-BHR DM", seat_id: "pd-alex", seat_tier: "DM" }),
  seat({ area_name: "Alexandria 1", parent_seat_id: "pd-alex", seat_id: "pd-alex-1", seat_tier: "REP" }),

  // ── Pedia · Cairo — the district manager post is VACANT ────────────────────────────────────────
  seat({ is_vacant: true, line_name: "Pedia", occupant_hr_id: null, parent_seat_id: "nsm-pd", region_name: "Cairo", seat_display_label: "PEDIA Cairo DM (VACANT)", seat_id: "pd-cairo", seat_tier: "DM" }),
  seat({ area_name: "Nasr City", parent_seat_id: "pd-cairo", seat_id: "pd-cairo-1", seat_tier: "REP" }),

  // ── The "Others" pseudo-DM: no areas, nobody in it, nobody hired into it ───────────────────────
  seat({ is_other_pseudo_dm: true, is_vacant: true, line_name: "Anti Infective", occupant_hr_id: null, parent_seat_id: "nsm-ai", region_name: "Others", seat_display_label: "ANTI_INFECTIVE Others (pseudo-DM)", seat_id: "ai-others", seat_tier: "DM" }),
];

function candidate(id: string, fields: Partial<DistrictFolderCandidate> = {}): DistrictFolderCandidate {
  return {
    appliedForJobTitle: null,
    currentJobTitle: null,
    faculty: "Faculty of Pharmacy",
    fullName: `Candidate ${id}`,
    id,
    preferencesDeclaredAt: "2026-09-01T10:00:00.000Z",
    preferredAreaName: null,
    status: "new",
    ...fields,
  } as DistrictFolderCandidate;
}

/** Every board holding this candidate, as `seatId::folder` pairs, so a miss names itself. */
function placementsOf(candidateId: string, candidates: readonly DistrictFolderCandidate[]): string[] {
  const { boards } = placeCandidatesInDistrictFolders({ candidates, rows: ROWS });
  const out: string[] = [];
  for (const board of boards) {
    for (const folder of board.folders) {
      if (folder.candidates.some((entry) => entry.id === candidateId)) {
        out.push(`${board.seatId}::${folder.areaName}`);
      }
    }
  }
  return out.sort();
}

export function runRecruitmentManagerSeatRankTests(): void {
  // ── THE LADDER ITSELF ─────────────────────────────────────────────────────────────────────────
  {
    assert.equal(seatTierRank("ACTING_DM"), seatTierRank("DM"), "a rep acting as district manager does the job, so he ranks with it");
    assert.equal(seatTierRank("dm"), 1, "the tier is read case-insensitively — the org tree is not consistent about it");
    assert.equal(seatTierRank("SFE Manager"), null, "a tier this ladder does not know answers null rather than a number nobody chose");

    assert.equal(managerSeatCanReceive("NSM", "DM"), true, "a national sales manager receives district managers");
    assert.equal(managerSeatCanReceive("RSM", "DM"), true, "and so does a regional one, for the districts under him");
    assert.equal(managerSeatCanReceive("DM", "DM"), false, "THE OWNER'S SENTENCE: a district manager never receives a district manager");
    assert.equal(managerSeatCanReceive("ACTING_DM", "DM"), false, "and neither does the rep standing in for one");
    assert.equal(managerSeatCanReceive("RSM", "RSM"), false, "strictly below, so a regional manager does not read applications for his own seat either");
    assert.equal(managerSeatCanReceive("NSM", "RSM"), true, "the seat above a regional manager does");
    assert.equal(
      managerSeatCanReceive("CEO", "NSM"),
      false,
      "and the CEO receives NOTHING — he is above every seat in the company, so ranking alone would hand him every CV there is",
    );
  }

  // ── WHICH POST A CV IS FOR ────────────────────────────────────────────────────────────────────
  {
    assert.equal(
      candidateManagerSeatTier({ appliedForJobTitle: "District Manager" }),
      "DM",
      "the title a human typed on the record is the first and best answer",
    );
    assert.equal(
      candidateManagerSeatTier({ currentJobTitle: "District Sales Manger" }),
      "DM",
      "29 production rows name the job only in current_job_title, and three of them spell it 'manger'",
    );
    assert.equal(
      candidateManagerSeatTier({ appliedForJobTitle: "Medical Representative", currentJobTitle: "District Manager" }),
      null,
      "A DISTRICT MANAGER APPLYING FOR A REP SEAT IS A REP APPLICANT. What they asked for outranks what they hold, or the one person in production who did this would be routed over his own future manager's head",
    );
    assert.equal(
      candidateManagerSeatTier({ fullName: "Ahmed Sayed Subject( Cv for district manager job for upper Egypt )" }),
      "DM",
      "the forwarded subject line is the sender's own words about the job they want",
    );
    assert.equal(
      candidateManagerSeatTier({ currentJobTitle: "Regional Sales Manager" }),
      "RSM",
      "a regional manager is its own rung — reading it as a district manager would let a regional manager read applications for his own seat",
    );
    assert.equal(
      candidateManagerSeatTier({ currentJobTitle: "Area Sales Manager" }),
      "DM",
      "AN AREA SALES MANAGER IS A DISTRICT MANAGER HERE — the owner's own correction on 2026-08-28, reversing the placement shipped hours earlier. It reads like a synonym for the seat above and is not one, so it must land on the district rung or ten production candidates would be routed a level too high",
    );
    assert.equal(candidateManagerSeatTier({ currentJobTitle: "National Sales Manager" }), "NSM");
    assert.equal(
      candidateManagerSeatTier({ currentJobTitle: "Product Manager" }),
      null,
      "a Product Manager is a head-office marketing seat that manages nobody in the field — routing one over a district manager's head would be an invention",
    );
    assert.equal(
      candidateManagerSeatTier({ currentJobTitle: "Medical Rep" }),
      null,
      "and the ordinary case is null: nothing here says this person is applying over anybody's head",
    );
    assert.equal(
      candidateManagerSeatTier({ appliedForJobTitle: null, currentJobTitle: null, fullName: "Mohamed Ali" }),
      null,
      "MOST OF THE POOL HAS NO TITLE AT ALL. Null must mean 'route as before' and never 'hold back', or the fix would empty the folders it was meant to clean",
    );
  }

  // ── A DISTRICT MANAGER NEVER RECEIVES A DISTRICT MANAGER ──────────────────────────────────────
  {
    const reps = candidate("rep-nasr", { currentJobTitle: "Medical Representative", preferredAreaName: "Nasr City" });
    const dm = candidate("dm-nasr", { appliedForJobTitle: "District Manager", preferredAreaName: "Nasr City" });

    const repPlacements = placementsOf("rep-nasr", [reps]);
    assert.deepEqual(
      repPlacements,
      ["ai-cairo::Nasr City", "pd-cairo::Nasr City"],
      "UNCHANGED: a rep applicant still lands in the Nasr City folder of every district that holds Nasr City",
    );

    const dmPlacements = placementsOf("dm-nasr", [dm]);
    assert.ok(
      !dmPlacements.some((entry) => entry.startsWith("ai-cairo::") || entry.startsWith("pd-cairo::")),
      `a district-manager applicant must reach NO district board — reached ${dmPlacements.join(", ")}`,
    );
    assert.deepEqual(
      dmPlacements,
      ["nsm-ai::Cairo", "nsm-pd::Cairo"],
      "he reaches the national sales manager of each line instead, in that line's own Cairo folder",
    );
  }

  // ── THE VACANT DISTRICT DOES NOT BECOME A LOOPHOLE ────────────────────────────────────────────
  {
    // Pedia Cairo is vacant, so its REP folders climb to the Pedia NSM. That is the pre-existing
    // rule and it must not quietly hand him the same CV twice — once as the district's stand-in and
    // once as the manager above it.
    const dm = candidate("dm-vacant", { appliedForJobTitle: "District Manager", preferredAreaName: "Nasr City" });
    const { boards } = placeCandidatesInDistrictFolders({ candidates: [dm], rows: ROWS });
    const pediaNsmBoards = boardsForManager(boards, "a-12");
    const total = pediaNsmBoards.reduce((sum, board) => sum + board.candidateCount, 0);
    assert.equal(total, 1, "the Pedia national sales manager reads this applicant exactly once, not once per route into his hands");
    assert.equal(
      pediaNsmBoards.filter((board) => board.candidateCount > 0)[0]?.intake,
      "district_managers",
      "and he reads him on the board built for the district manager post, not among the rep folders he covers while the seat is empty",
    );
  }

  // ── THE WHOLE CHAIN, NOT JUST THE PARENT ──────────────────────────────────────────────────────
  {
    const dm = candidate("dm-alex", { appliedForJobTitle: "District Manager", preferredAreaName: "Alexandria 1" });
    assert.deepEqual(
      placementsOf("dm-alex", [dm]),
      ["nsm-pd::Alex-BHR", "rsm-pd::Alex-BHR"],
      "Alex-BHR sits under a regional manager who sits under the national one, and BOTH are entitled to it — reading 'reports to him' as direct reports only would hide three of Pedia's districts from the person accountable for the line",
    );

    const rsm = candidate("rsm-alex", { appliedForJobTitle: "Regional Sales Manager", preferredAreaName: "Alexandria 1" });
    assert.deepEqual(
      placementsOf("rsm-alex", [rsm]),
      ["nsm-pd::Alex-BHR"],
      "an applicant for the REGIONAL seat stops one rung higher — the regional manager does not read applications for his own job",
    );

    const nsm = candidate("nsm-alex", { appliedForJobTitle: "National Sales Manager", preferredAreaName: "Alexandria 1" });
    assert.deepEqual(
      placementsOf("nsm-alex", [nsm]),
      [],
      "and nobody at all reads an application for a national sales manager's seat: the only chair above it is the CEO's, and nothing is ever routed there",
    );
  }

  // ── A DISTRICT MANAGER WHO NAMED ONLY A REGION ────────────────────────────────────────────────
  {
    const dm = candidate("dm-region", {
      appliedForJobTitle: "DSM",
      preferencesDeclaredAt: null,
      preferredAreaName: null,
      preferredRegionName: "Cairo",
    });
    assert.deepEqual(
      placementsOf("dm-region", [dm]),
      ["nsm-ai::Cairo", "nsm-pd::Cairo"],
      "the region resolves to the same districts it always did — only the reader changes",
    );
  }

  // ── THE ACTING DISTRICT MANAGER IS A DISTRICT MANAGER ─────────────────────────────────────────
  {
    const dm = candidate("dm-qena", { appliedForJobTitle: "District Manager", preferredAreaName: "Qena 1" });
    const placements = placementsOf("dm-qena", [dm]);
    assert.deepEqual(
      placements,
      ["nsm-ai::Upper Egypt 1"],
      "Upper Egypt 1 is held by a REP acting as district manager — he does the job, so he must not read the applications for it either",
    );
  }

  // ── THE BOARDS THEMSELVES ─────────────────────────────────────────────────────────────────────
  {
    const boards = managerApplicantBoards(ROWS);
    assert.deepEqual(
      boards.map((board) => board.seatId).sort(),
      ["nsm-ai", "nsm-pd", "rsm-pd"],
      "one board per occupied manager seat above a district — and none for the CEO, who has none",
    );

    const antiInfective = boards.find((board) => board.seatId === "nsm-ai");
    assert.deepEqual(
      antiInfective?.folders.map((folder) => folder.areaName),
      ["Cairo", "Upper Egypt 1"],
      "one folder per district beneath him, named the way the company says it out loud — and the 'Others' pseudo-DM, which holds no areas and into which nobody is ever hired, is not one of them",
    );
    assert.ok(
      antiInfective?.folders.every((folder) => folder.kind === "district"),
      "these folders are DISTRICTS: somebody applying to run Delta (1) did not apply for a rep seat inside it",
    );
    assert.equal(
      antiInfective?.managerHrId,
      "AI-0008",
      "and the board belongs to the person sitting in the seat, which is what every scope check on this data keys on",
    );

    const pediaRegional = boards.find((board) => board.seatId === "rsm-pd");
    assert.deepEqual(
      pediaRegional?.folders.map((folder) => folder.areaName),
      ["Alex-BHR"],
      "the regional manager's board holds only the districts under HIM — a picker is never wider than its viewer",
    );
  }
}
