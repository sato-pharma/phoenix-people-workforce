import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  areaFolderKey,
  boardsForManager,
  districtManagerBoards,
  districtRoutingRegion,
  districtRoutingRegionOptions,
  placeCandidatesInDistrictFolders,
  REGION_FOLDER_LABEL,
  regionFamilyKey,
  type DistrictFolderCandidate,
  type DistrictSeatRow,
} from "../src/lib/recruitment/district-manager-folders.ts";

/**
 * "You will make a folder per district manager. Each folder has his areas. All his areas in the
 *  organogram. And populate the folders based on the CVs we receive."  — the owner, 2026-08-31.
 *
 * THE RISK THIS SUITE EXISTS FOR is not the folders; it is the routing inside them. An area belongs
 * to up to three district managers at once — Nasr City is a rep seat on Anti Infective, CNS and
 * Pedia — so every "which manager owns this area" question has more than one right answer, and a
 * module that picks one puts a CV in front of the wrong person while the right one sees nothing.
 * The failure is silent in both directions: the wrong manager reads a CV he cannot act on, and the
 * right one reads an empty folder as "no applicants".
 *
 * The fixture is production's real shape, taken 2026-08-31: three lines, the Cairo district on all
 * three, an ACTING_DM holding Upper Egypt 1, a VACANT Pedia district, and an "Others" pseudo-DM that
 * holds nothing. Area names are the organogram's own spellings, hyphen included.
 */

function seat(fields: Partial<DistrictSeatRow>): DistrictSeatRow {
  return { is_vacant: false, ...fields };
}

const ROWS: DistrictSeatRow[] = [
  // ── The chain above the districts ──────────────────────────────────────────────────────────────
  seat({ seat_id: "nsm-ai", seat_tier: "NSM", occupant_hr_id: "AI-0008", line_name: "Anti Infective", seat_display_label: "ANTI_INFECTIVE NSM" }),
  seat({ seat_id: "nsm-pd", seat_tier: "NSM", occupant_hr_id: "a-12", line_name: "Pedia", seat_display_label: "PEDIA NSM" }),

  // ── Anti Infective · Cairo — occupied ──────────────────────────────────────────────────────────
  seat({ seat_id: "ai-cairo", parent_seat_id: "nsm-ai", seat_tier: "DM", occupant_hr_id: "AI-0001", line_name: "Anti Infective", region_name: "Cairo", seat_display_label: "ANTI_INFECTIVE Cairo DM" }),
  seat({ seat_id: "ai-cairo-1", parent_seat_id: "ai-cairo", seat_tier: "REP", area_name: "Nasr City" }),
  seat({ seat_id: "ai-cairo-2", parent_seat_id: "ai-cairo", seat_tier: "REP", area_name: "Heliopolis" }),

  // ── CNS · Cairo — occupied, and it holds Nasr City too ─────────────────────────────────────────
  seat({ seat_id: "cns-cairo", seat_tier: "DM", occupant_hr_id: "B-116", line_name: "CNS", region_name: "Cairo", seat_display_label: "CNS Cairo DM" }),
  seat({ seat_id: "cns-cairo-1", parent_seat_id: "cns-cairo", seat_tier: "REP", area_name: "Nasr City" }),

  // ── Pedia · Cairo — the DM post is VACANT, and it holds Nasr City as well ───────────────────────
  seat({ seat_id: "pd-cairo", parent_seat_id: "nsm-pd", seat_tier: "DM", occupant_hr_id: null, is_vacant: true, line_name: "Pedia", region_name: "Cairo", seat_display_label: "PEDIA Cairo DM (VACANT)" }),
  seat({ seat_id: "pd-cairo-1", parent_seat_id: "pd-cairo", seat_tier: "REP", area_name: "Nasr City" }),

  // ── Anti Infective · Delta (1) — carries Kafr El-Sheikh 1, hyphen and all ───────────────────────
  seat({ seat_id: "ai-delta1", parent_seat_id: "nsm-ai", seat_tier: "DM", occupant_hr_id: "B-12", line_name: "Anti Infective", region_name: "Delta (1)", seat_display_label: "ANTI_INFECTIVE Delta (1) DM" }),
  seat({ seat_id: "ai-delta1-1", parent_seat_id: "ai-delta1", seat_tier: "REP", area_name: "Kafr El-Sheikh 1" }),
  seat({ seat_id: "ai-delta1-2", parent_seat_id: "ai-delta1", seat_tier: "REP", area_name: "Menoufia 1" }),

  // ── An ACTING_DM is a real district ────────────────────────────────────────────────────────────
  seat({ seat_id: "ai-ue1", parent_seat_id: "nsm-ai", seat_tier: "ACTING_DM", occupant_hr_id: "B-1", line_name: "Anti Infective", region_name: "Upper Egypt 1", seat_display_label: "ANTI_INFECTIVE Upper Egypt 1 acting DM" }),
  seat({ seat_id: "ai-ue1-1", parent_seat_id: "ai-ue1", seat_tier: "REP", area_name: "Qena 1" }),
  seat({ seat_id: "ai-ue1-2", parent_seat_id: "ai-ue1", seat_tier: "REP", area_name: "Qena 2" }),

  // ── The "Others" pseudo-DM: sales only, no target, nobody in it, no areas ───────────────────────
  seat({ seat_id: "ai-others", parent_seat_id: "nsm-ai", seat_tier: "DM", occupant_hr_id: null, is_vacant: true, is_other_pseudo_dm: true, line_name: "Anti Infective", region_name: "Others", seat_display_label: "ANTI_INFECTIVE Others (pseudo-DM, sales only, no target) (VACANT)" }),
];

function candidate(id: string, fields: Partial<DistrictFolderCandidate> = {}): DistrictFolderCandidate {
  return {
    fullName: `Candidate ${id}`,
    id,
    preferencesDeclaredAt: "2026-08-25T10:00:00.000Z",
    preferredAreaName: null,
    status: "new",
    ...fields,
  } as DistrictFolderCandidate;
}

export function runDistrictManagerFolderTests(): void {
  // ── The districts themselves, in the order an NSM scans them ───────────────────────────────────
  {
    const boards = districtManagerBoards(ROWS);
    assert.deepEqual(
      boards.map((board) => `${board.lineName} · ${board.regionName}`),
      [
        "Anti Infective · Cairo",
        "Anti Infective · Delta (1)",
        "Anti Infective · Upper Egypt 1",
        "CNS · Cairo",
        "Pedia · Cairo",
      ],
      "districts read by line, then region — the order an NSM scans",
    );

    assert.ok(
      !boards.some((board) => board.regionName === "Others"),
      "the Others pseudo-DM holds no areas and nobody is hired into it — three permanently empty districts is not a list",
    );
    assert.ok(
      boards.some((board) => board.seatLabel.includes("acting DM")),
      "an ACTING_DM is a real district — leaving the tier out would orphan Qena 1 and Qena 2 silently",
    );

    // ALL his areas, including the ones nothing has arrived for. An empty folder says "no applicants
    // for this area"; a missing folder says "this is not my area", which is false.
    const delta1 = boards.find((board) => board.regionName === "Delta (1)")!;
    assert.deepEqual(
      delta1.folders.filter((folder) => folder.kind === "area").map((folder) => folder.areaName),
      ["Kafr El-Sheikh 1", "Menoufia 1"],
      "every area the organogram gives him, alphabetical, empty ones included",
    );
    // And the catch-all closes the set, always last. It is a different KIND of folder, holding CVs
    // that reached the region without naming an area — see the backfill block below.
    assert.deepEqual(
      delta1.folders.map((folder) => folder.kind),
      ["area", "area", "region"],
    );
  }

  // ── A vacant district climbs, and says so ──────────────────────────────────────────────────────
  {
    const boards = districtManagerBoards(ROWS);
    const pedia = boards.find((board) => board.seatId === "pd-cairo")!;
    assert.equal(
      pedia.managerHrId,
      "a-12",
      "a vacant district manager post is opened by whoever the organogram puts above it — the owner's own rule on the send path",
    );
    assert.equal(
      pedia.coveringVacantSeat,
      "PEDIA Cairo DM (VACANT)",
      "…and the screen must be able to say which empty post this is, or the manager cannot tell why it is in front of him",
    );

    const cairo = boards.find((board) => board.seatId === "ai-cairo")!;
    assert.equal(cairo.managerHrId, "AI-0001");
    assert.equal(cairo.coveringVacantSeat, null, "an occupied district is nobody's stand-in");
  }

  // ── ONE CV, THREE MANAGERS — the reason this shape was chosen ──────────────────────────────────
  {
    const { boards, placements, unplaced } = placeCandidatesInDistrictFolders({
      candidates: [candidate("nasr", { preferredAreaName: "Nasr City" })],
      rows: ROWS,
    });

    assert.equal(unplaced.length, 0);
    assert.equal(
      placements,
      3,
      "Nasr City is a seat on three lines — the CV reaches all three district managers, each seeing only his own folder",
    );

    const holders = boards
      .filter((board) => board.candidateCount > 0)
      .map((board) => `${board.lineName} · ${board.regionName}`);
    assert.deepEqual(holders, ["Anti Infective · Cairo", "CNS · Cairo", "Pedia · Cairo"]);

    // And it is in the NAMED folder, not merely on the board.
    const cns = boards.find((board) => board.seatId === "cns-cairo")!;
    const nasr = cns.folders.find((folder) => folder.areaName === "Nasr City")!;
    assert.deepEqual(nasr.candidates.map((row) => row.id), ["nasr"]);

    // Nobody else's district moved. This is the half that would fail silently.
    const delta1 = boards.find((board) => board.seatId === "ai-delta1")!;
    assert.equal(delta1.candidateCount, 0, "a Cairo CV must not appear in Delta (1)");
  }

  // ── The key is tolerant of typing, and REFUSES to guess past that ──────────────────────────────
  {
    assert.equal(
      areaFolderKey("Kafr El Sheikh 1"),
      areaFolderKey("Kafr El-Sheikh 1"),
      "one hyphen must not lose a real applicant — this exact pair is in production",
    );
    assert.notEqual(
      areaFolderKey("Qena"),
      areaFolderKey("Qena 1"),
      "a governorate is not an area: matching it to one of the two would file the CV under a district guessed at",
    );

    const { boards, unplaced } = placeCandidatesInDistrictFolders({
      candidates: [
        candidate("hyphen", { preferredAreaName: "Kafr El Sheikh 1" }),
        candidate("governorate", { preferredAreaName: "Qena" }),
        candidate("nowhere", { preferredAreaName: "Ismailia" }),
      ],
      rows: ROWS,
    });

    const delta1 = boards.find((board) => board.seatId === "ai-delta1")!;
    assert.deepEqual(
      delta1.folders.find((folder) => folder.areaName === "Kafr El-Sheikh 1")!.candidates.map((row) => row.id),
      ["hyphen"],
      "the hyphen difference is absorbed",
    );

    assert.deepEqual(
      unplaced.map((row) => `${row.candidateId}:${row.reason}`).sort(),
      ["governorate:no-such-area", "nowhere:no-such-area"],
      "what cannot be placed is REPORTED, never guessed and never dropped — a person answers these",
    );
    // "Ismailia" is a real place with no rep seat under any district. It is not a spelling problem
    // and no amount of matching fixes it; the honest answer is that nobody holds it yet.
    assert.ok(unplaced.some((row) => row.declaredArea === "Ismailia"));
  }

  // ── Two areas that key alike place NOBODY ──────────────────────────────────────────────────────
  {
    // No such collision exists in production — all 40 area names key uniquely, measured 2026-08-31 —
    // and this asserts what happens the day one appears. Filing under whichever was indexed last is
    // the failure worth refusing: it is invisible, and it is wrong half the time.
    const collided: DistrictSeatRow[] = [
      ...ROWS,
      seat({ seat_id: "cns-delta1", seat_tier: "DM", occupant_hr_id: "B-120", line_name: "CNS", region_name: "Delta (1)", seat_display_label: "CNS Delta (1) DM" }),
      seat({ seat_id: "cns-delta1-1", parent_seat_id: "cns-delta1", seat_tier: "REP", area_name: "Kafr El Sheikh 1" }),
    ];
    const { boards, unplaced } = placeCandidatesInDistrictFolders({
      candidates: [candidate("kfs", { preferredAreaName: "Kafr El-Sheikh 1" })],
      rows: collided,
    });

    assert.deepEqual(
      unplaced.map((row) => row.reason),
      ["area-reads-two-ways"],
      "when the organogram spells one area two ways, the CV waits for a person rather than picking a district",
    );
    assert.equal(
      boards.reduce((total, board) => total + board.candidateCount, 0),
      0,
      "and it reaches NEITHER — filing it in both would show one manager somebody else's applicant",
    );
    // The folders themselves still exist. The ambiguity stops placement, not the shelf.
    assert.ok(boards.some((board) => board.folders.some((folder) => folder.areaName === "Kafr El Sheikh 1")));
  }

  // ── The two gates: who SAID it, and who is still in the running ────────────────────────────────
  {
    const { boards, placements, unplaced } = placeCandidatesInDistrictFolders({
      candidates: [
        // The extractor read "Nasr City" off a CV. That is where somebody WORKED, not where they
        // asked to work, and `preferencesDeclaredAt` is the only field that means the applicant
        // said it. 64 of production's 82 area-bearing rows came from an extraction.
        candidate("extracted", { preferencesDeclaredAt: null, preferredAreaName: "Nasr City" }),
        // Already turned down. The recruiter's own refusal, imported rather than restated.
        candidate("rejected", { preferredAreaName: "Nasr City", status: "rejected" }),
        candidate("blank", { preferredAreaName: "   " }),
        // Confirmed paramedical by an admin who read the CV. Routing them to a district manager
        // would quietly undo that decision: the shelf exists to take somebody OUT of the field-force
        // pool, and a folder in front of a hiring manager is as far in as it gets.
        candidate("paramedical", {
          folder: {
            filedAt: "2026-08-31T09:00:00.000Z",
            filedByHrId: "HR-001",
            filedByName: null,
            key: "Paramedical",
            kind: "paramedical",
          },
          preferredAreaName: "Nasr City",
        }),
      ],
      rows: ROWS,
    });

    assert.equal(
      placements,
      0,
      "an extraction, a rejection, a blank and a confirmed paramedical all reach no district manager",
    );
    assert.deepEqual(unplaced, [], "…and none of them is reported as unplaceable either — they were never candidates for placement");
    assert.equal(boards.reduce((total, board) => total + board.candidateCount, 0), 0);
  }

  // ── Whose board is whose, in mixed case ────────────────────────────────────────────────────────
  {
    const boards = districtManagerBoards(ROWS);
    // HR_IDs here are mixed case; the org tree holds "AI-0001" and a session can carry "ai-0001".
    // A plain equality has already lost 28% of a result set elsewhere in this codebase, and a
    // district manager seeing an empty screen reads it as "no CVs", not as a bug.
    assert.deepEqual(boardsForManager(boards, "ai-0001").map((board) => board.seatId), ["ai-cairo"]);
    assert.deepEqual(boardsForManager(boards, "AI-0001").map((board) => board.seatId), ["ai-cairo"]);
    assert.deepEqual(boardsForManager(boards, "a-12").map((board) => board.seatId), ["pd-cairo"], "the NSM holds the vacant Pedia district");
    assert.deepEqual(boardsForManager(boards, null), []);
    assert.deepEqual(boardsForManager(boards, "B-999"), [], "somebody with no district gets nothing, not everything");
  }

  // ── THE BACKFILL: 420 CVs that named no area, because the question did not exist yet ───────────
  //
  // "You will start backfilling from the historicals ... the two hundred eligible, you will backfill
  //  them. But anyone non eligible, you will make the admin be able to check first their CV and
  //  confirm."  — the owner, 2026-08-31.
  //
  // Every test above this line is about an applicant who ANSWERED. Not one of the 420 live archived
  // CVs did: they arrived by email and WhatsApp before the apply flow existed, so they carry a
  // governorate their own text mentions and nothing else. An area-only rule reaches none of them.
  {
    // Production's real shape for the case this block exists for: Anti Infective splits Upper Egypt
    // into 1 and 2, CNS holds it whole. Added HERE rather than to ROWS so the counts every earlier
    // test asserts stay exactly as they were.
    const ROWS_UE: DistrictSeatRow[] = [
      ...ROWS,
      seat({ seat_id: "cns-ue", seat_tier: "DM", occupant_hr_id: "B-119", line_name: "CNS", region_name: "Upper Egypt", seat_display_label: "CNS Upper Egypt DM" }),
      seat({ seat_id: "cns-ue-1", parent_seat_id: "cns-ue", seat_tier: "REP", area_name: "Sohag" }),
    ];

    const archived = (id: string, fields: Partial<DistrictFolderCandidate> = {}) =>
      candidate(id, { preferencesDeclaredAt: null, preferredAreaName: null, ...fields });

    // ── The one rule that decides whether anti-infective ever sees an Upper Egypt CV ────────────
    //
    // A trailing BARE number is a split of one region; a PARENTHESISED one names a different region.
    // Get this backwards in either direction and it fails silently: too tight and 62 real CVs never
    // reach two districts, too loose and every Delta CV lands in all three at once — including
    // Delta (3), the anti-infective-only territory the owner moved five areas into.
    assert.equal(regionFamilyKey("Upper Egypt 1"), regionFamilyKey("Upper Egypt"), "Upper Egypt 1 is half of Upper Egypt, not a different region");
    assert.equal(regionFamilyKey("Upper Egypt 2"), regionFamilyKey("Upper Egypt"), "and so is Upper Egypt 2");
    assert.notEqual(regionFamilyKey("Delta (1)"), regionFamilyKey("Delta (2)"), "the Deltas are three regions an applicant picks between, never one");
    assert.notEqual(regionFamilyKey("Delta (1)"), regionFamilyKey("Delta (3)"), "Delta (3) especially — it is anti-infective territory only");
    assert.equal(regionFamilyKey(null), "", "no region keys to nothing rather than to everything");

    // ── Which region a CV routes to, strongest evidence first ──────────────────────────────────
    assert.equal(districtRoutingRegion(archived("r1", { governorate: "Qena" })), "Upper Egypt", "a governorate resolves through the company's own region map");
    assert.equal(districtRoutingRegion(archived("r2", { governorate: "Qena", preferredRegionCode: "D1" })), "Delta (1)", "an answer they gave beats a governorate read off their CV");
    assert.equal(districtRoutingRegion(archived("r3", { governorate: "Atlantis" })), null, "a governorate nobody recognises resolves to nothing, never to a guess");

    // ── The headline: one archived CV, every district covering its region ──────────────────────
    const { boards, placements, unplaced } = placeCandidatesInDistrictFolders({
      candidates: [archived("ue-elig", { faculty: "Faculty of Pharmacy", governorate: "Qena" })],
      rows: ROWS_UE,
    });

    const reached = boards
      .filter((board) => board.candidateCount > 0)
      .map((board) => board.seatId)
      .sort();
    assert.deepEqual(reached, ["ai-ue1", "cns-ue"], "an Upper Egypt CV reaches the anti-infective half AND the line that spells the region plainly — matching on the name alone would silently skip the first");
    assert.equal(placements, 2);
    assert.deepEqual(unplaced, [], "it was placed, so nobody has to be told about it");

    // And it lands in the CATCH-ALL, never in an area folder. Qena 1 and Qena 2 are real areas and
    // this applicant asked for neither; filing them into one would be a guess wearing an answer's
    // clothes, and the manager would ring them about the wrong half of the governorate.
    const ue1 = boards.find((board) => board.seatId === "ai-ue1");
    assert.ok(ue1);
    const catchAll = ue1.folders.at(-1);
    assert.equal(catchAll?.kind, "region", "the catch-all closes the district, after every named area");
    assert.equal(catchAll?.areaName, REGION_FOLDER_LABEL);
    assert.deepEqual(catchAll?.candidates.map((row) => row.id), ["ue-elig"]);
    assert.deepEqual(
      ue1.folders.filter((folder) => folder.kind === "area").flatMap((folder) => folder.candidates),
      [],
      "no area folder was touched",
    );

    // ── The address on the CV, which used to be thrown away ────────────────────────────────────
    //
    // The owner, 2026-09-03: *"do a fucking effort for the areas that you're putting in a folder
    // that you're calling a no area name."* Until that day this rule read `governorate` and stopped,
    // so a CV whose address says "Nasr City" carried exactly as much information as one saying only
    // "Cairo" — both landed in the catch-all. Measured against production the same day, 47 CVs move
    // out of "No area named" and into a real area folder because of this block.
    //
    // THE CONTROL IS THE HALF THAT PROVES IT. The same candidate with the address removed must still
    // reach the catch-all and nothing else; without that, this test would pass just as happily if the
    // area folder were being filled by the governorate.
    {
      const withAddress = placeCandidatesInDistrictFolders({
        candidates: [archived("addr", {
          address: "12 Ismail Elkabany st., Nasr City, Cairo",
          faculty: "Faculty of Pharmacy",
          governorate: "Cairo",
        })],
        rows: ROWS_UE,
      });

      // Nasr City is a rep seat on all THREE lines, so one CV reaches three managers — the same
      // fan-out a declared area gets, because it is the same folder.
      const named = withAddress.boards
        .flatMap((board) => board.folders.map((folder) => ({ board, folder })))
        .filter((entry) => entry.folder.candidates.some((row) => row.id === "addr"));
      assert.deepEqual(
        named.map((entry) => `${entry.board.seatId}/${entry.folder.areaName}`).sort(),
        ["ai-cairo/Nasr City", "cns-cairo/Nasr City", "pd-cairo/Nasr City"],
        "the address named an area, so the CV is in that area's folder on every line that holds it",
      );
      assert.ok(
        named.every((entry) => entry.folder.fromCvText.includes("addr")),
        "and each folder records that it got there from the CV's own text, not from the applicant asking",
      );
      assert.deepEqual(
        withAddress.boards
          .flatMap((board) => board.folders)
          .filter((folder) => folder.kind === "region")
          .flatMap((folder) => folder.candidates.map((row) => row.id)),
        [],
        "no catch-all still holds it — it was lifted out, not copied",
      );

      // ── AND THE ASYMMETRIC HALF, where filing by area silently COSTS a manager a CV ───────────
      //
      // Nasr City above is on all three lines, so lifting the CV out of the catch-alls took nothing
      // from anybody. Heliopolis is a rep seat on ANTI INFECTIVE ONLY — the other two Cairo
      // districts cover that ground under area names of their own. Area names are per line, and
      // that is the whole trap: reading this tier as a REPLACEMENT for the catch-all dropped the CV
      // off both other boards. A manager who could see the person yesterday could not see him
      // today, nothing on either screen said so, and the folder that gained him looked correct.
      //
      // So the anti-infective manager gets the better folder and the other two keep exactly what
      // they had. This is the assertion that was missing when the address tier first shipped.
      const lopsided = placeCandidatesInDistrictFolders({
        candidates: [archived("helio", {
          address: "7 Cleopatra st., Heliopolis, Cairo",
          faculty: "Faculty of Pharmacy",
          governorate: "Cairo",
        })],
        rows: ROWS_UE,
      });
      const helioLanded = lopsided.boards
        .flatMap((board) => board.folders.map((folder) => ({ board, folder })))
        .filter((entry) => entry.folder.candidates.some((row) => row.id === "helio"));
      assert.deepEqual(
        helioLanded.map((entry) => `${entry.board.seatId}/${entry.folder.areaName}`).sort(),
        ["ai-cairo/Heliopolis", "cns-cairo/No area named", "pd-cairo/No area named"],
        "an area only one line holds still reaches all three districts — the folder differs, the audience does not",
      );
      assert.deepEqual(
        helioLanded
          .filter((entry) => entry.folder.fromCvText.includes("helio"))
          .map((entry) => entry.board.seatId),
        ["ai-cairo"],
        "and only the district that gained an area folder claims the CV was read off the address",
      );

      // The control: strip the address, keep everything else. Cairo is a governorate covering twelve
      // areas, and that is a region answer, not an area one.
      const withoutAddress = placeCandidatesInDistrictFolders({
        candidates: [archived("addr", { faculty: "Faculty of Pharmacy", governorate: "Cairo" })],
        rows: ROWS_UE,
      });
      assert.deepEqual(
        withoutAddress.boards
          .flatMap((board) => board.folders)
          .filter((folder) => folder.candidates.some((row) => row.id === "addr"))
          .map((folder) => folder.kind),
        ["region", "region", "region"],
        "with no address, the same CV reaches only the catch-alls — the governorate never names an area",
      );
      assert.ok(
        withoutAddress.boards.flatMap((board) => board.folders).every((folder) => folder.fromCvText.length === 0),
        "and nothing is marked as read off a CV that said nothing",
      );

      // The eligibility gate still governs this path. The owner's instruction on the archive was
      // that anything not eligible waits for an admin to open the CV and confirm; a better-read
      // address is not a reason to skip that person.
      const notEligible = placeCandidatesInDistrictFolders({
        candidates: [archived("addr-unknown", {
          address: "12 Ismail Elkabany st., Nasr City, Cairo",
          faculty: "qwerty zzz",
          governorate: "Cairo",
        })],
        rows: ROWS_UE,
      });
      assert.equal(notEligible.placements, 0,
        "a readable address does not carry a CV past the background gate — the admin queue is still where it waits");
    }

    // ── The governorate, when the company splits it no further ─────────────────────────────────
    //
    // The owner, 2026-09-03, was asked whether a CV whose only location is the governorate should
    // reach that governorate's area when there is exactly one, and answered: "put them in that area
    // folder". Five governorates qualify in production today — Beni Suef, Fayoum, Kafr El-Sheikh,
    // Port Said and Suez — and ten real CVs move out of "No area named" because of this block.
    //
    // THE CONTROL IS THE OTHER HALF AGAIN. Qena is split into Qena 1 and Qena 2, so the identical
    // candidate shape must still reach only the catch-alls. Without it this test would pass just as
    // happily if every governorate were being resolved to whichever area came first.
    {
      const soleArea = placeCandidatesInDistrictFolders({
        candidates: [archived("sohag", { faculty: "Faculty of Pharmacy", governorate: "Sohag" })],
        rows: ROWS_UE,
      });
      const landed = soleArea.boards
        .flatMap((board) => board.folders.map((folder) => ({ board, folder })))
        .filter((entry) => entry.folder.candidates.some((row) => row.id === "sohag"));
      assert.deepEqual(
        landed.map((entry) => `${entry.board.seatId}/${entry.folder.areaName}`).sort(),
        ["ai-ue1/No area named", "cns-ue/Sohag"],
        "Sohag governorate holds one area, so the manager who covers it gets the CV in that folder — and the district that has no folder for that ground keeps it in its catch-all",
      );

      // THE UPGRADE MUST NOT COST A BOARD, and this is the half that failed silently. Filing into
      // an area folder narrows to the districts holding that NAME, and area names are per line:
      // reading the tier as a REPLACEMENT for the catch-all took the CV off every other manager's
      // board in the region. Nothing on the folder that gained it would have shown that, and the
      // manager who lost it sees only a folder that never mentions the person.
      assert.deepEqual(
        [...new Set(landed.map((entry) => entry.board.seatId))].sort(),
        ["ai-ue1", "cns-ue"],
        "every district that saw this CV before still sees it — the area folder is an upgrade over the catch-all, never a swap",
      );
      assert.equal(
        soleArea.placements,
        2,
        "…and exactly once per district — a district is never handed the same CV twice, in an area folder and in its own catch-all",
      );
      assert.deepEqual(
        landed
          .filter((entry) => entry.folder.fromGovernorate.includes("sohag"))
          .map((entry) => `${entry.board.seatId}/${entry.folder.areaName}`),
        ["cns-ue/Sohag"],
        "only the folder that gained something records it as a governorate placement — the catch-all is where the CV already was, and says nothing new",
      );
      assert.ok(
        soleArea.boards.flatMap((board) => board.folders).every((folder) => folder.fromCvText.length === 0),
        "never as an address read off the CV — this candidate wrote no address, and the screen must not claim otherwise",
      );

      const split = placeCandidatesInDistrictFolders({
        candidates: [archived("qena", { faculty: "Faculty of Pharmacy", governorate: "Qena" })],
        rows: ROWS_UE,
      });
      assert.deepEqual(
        split.boards
          .flatMap((board) => board.folders)
          .filter((folder) => folder.candidates.some((row) => row.id === "qena"))
          .map((folder) => folder.kind),
        ["region", "region"],
        "a governorate the company splits between two areas still names neither",
      );
      assert.ok(
        split.boards.flatMap((board) => board.folders).every((folder) => folder.fromGovernorate.length === 0),
        "and nothing is marked as a governorate placement",
      );
    }

    // Every district gets exactly one, empty or not — a manager has to be able to SEE that nothing
    // arrived without an area, rather than infer it from a folder that is not on screen.
    //
    // DISTRICT boards only. The manager boards added 2026-09-09 — where a national or regional sales
    // manager reads applications for the district manager post itself — hold one folder per district
    // and no catch-all at all: somebody applying to RUN a district has named the district, so there
    // is no "no area named" left over to close. See recruitment-manager-seat-rank.test.ts.
    for (const board of boards.filter((entry) => entry.intake === "reps")) {
      assert.equal(
        board.folders.filter((folder) => folder.kind === "region").length,
        1,
        `${board.seatId} must hold exactly one catch-all`,
      );
    }

    // ── Who is held back, and the asymmetry that is the whole point ────────────────────────────
    //
    // "Anyone non eligible, you will make the admin be able to check first their CV and confirm."
    const held = placeCandidatesInDistrictFolders({
      candidates: [
        archived("ue-unknown", { faculty: "qwerty zzz", governorate: "Qena" }),
        archived("ue-para", { declaredBackground: "Physical therapy", governorate: "Qena" }),
      ],
      rows: ROWS_UE,
    });
    assert.equal(held.placements, 0, "an unreadable degree and a paramedical one both wait for an admin — neither is routed on our own initiative");
    assert.deepEqual(held.unplaced, [], "and neither is reported as unreachable: the admin queue is their record, and repeating them here would bury the CVs nobody is looking at");

    // But an applicant who ASKED for a named area is still filed on an unreadable degree. Requiring
    // a positive verdict on that path too would silently empty folders that are full today — most
    // CVs in them carry no declared background at all and fall to "unknown" on a faculty string the
    // parser cannot read. The archive is the opposite case: nobody asked to be routed.
    const asked = placeCandidatesInDistrictFolders({
      candidates: [candidate("asked", { faculty: "qwerty zzz", preferredAreaName: "Nasr City" })],
      rows: ROWS_UE,
    });
    assert.equal(asked.placements, 3, "an unreadable degree does not un-ask a question the applicant answered");

    // AND HE IS IN ONE PLACE, NOT TWO. An applicant who named an area must never ALSO turn up in
    // the catch-all of the same district. The failure is quiet and expensive: the manager reads the
    // same person twice, once under Nasr City and once under "No area named", every count on the
    // screen doubles, and the second copy carries the wrong story about how he got there.
    const both = placeCandidatesInDistrictFolders({
      candidates: [
        candidate("elig-asked", {
          faculty: "Faculty of Pharmacy",
          governorate: "Cairo",
          preferredAreaName: "Nasr City",
        }),
      ],
      rows: ROWS_UE,
    });
    assert.equal(both.placements, 3, "the three districts that hold Nasr City, and nothing else");
    assert.deepEqual(
      both.boards
        .flatMap((board) => board.folders.filter((folder) => folder.kind === "region"))
        .flatMap((folder) => folder.candidates),
      [],
      "naming an area is an answer — it must never spill into the folder for people who gave none",
    );

    // A paramedical verdict IS refused on both paths — that is the owner's first instruction, and
    // the shelf exists precisely so these never reach a hiring manager.
    const paraAsked = placeCandidatesInDistrictFolders({
      candidates: [candidate("para-asked", { declaredBackground: "Physical therapy", preferredAreaName: "Nasr City" })],
      rows: ROWS_UE,
    });
    assert.equal(paraAsked.placements, 0, "a paramedical answer is refused even when they named an area");

    // ── Told, never dropped: the two ways an eligible CV still reaches nobody ───────────────────
    const stranded = placeCandidatesInDistrictFolders({
      candidates: [
        archived("aswan", { faculty: "Faculty of Pharmacy", governorate: "Aswan" }),
        archived("nowhere", { faculty: "Faculty of Pharmacy" }),
      ],
      rows: ROWS_UE,
    });
    assert.equal(stranded.placements, 0);
    assert.deepEqual(
      stranded.unplaced.map((row) => [row.candidateId, row.reason]),
      [
        // Aswan is "Others": a real sales bucket whose three seats are pseudo-DMs holding no areas.
        // Nobody is hired into one, so this applicant genuinely has no district manager.
        ["aswan", "no-district-for-region"],
        ["nowhere", "no-place-named"],
      ],
      "an eligible CV that reaches nobody is always reported — silence here is a person nobody will ever see",
    );

    // ── The region path did not shorten the recruiter's existing list ──────────────────────────
    // "Qena" names a governorate the organogram splits in two, so it is not an area — and an
    // ineligible applicant who typed it must still be reported exactly as before the backfill.
    const named = placeCandidatesInDistrictFolders({
      candidates: [candidate("typed-qena", { preferredAreaName: "Qena" })],
      rows: ROWS_UE,
    });
    assert.deepEqual(
      named.unplaced.map((row) => [row.candidateId, row.declaredArea, row.reason]),
      [["typed-qena", "Qena", "no-such-area"]],
    );
  }

  // ── The folders have to be USABLE, not merely visible ──────────────────────────────────────────
  //
  // THE FAILURE THIS CATCHES IS THE ONE THAT SHIPS GREEN. Every existing route into hiring-manager
  // scope keys on a CV having been PUSHED to somebody, and a CV in a district folder was pushed to
  // nobody by definition — so without a fourth route the cards would render a View CV button that
  // answers 403 and a comment box that refuses to load. Nothing else in this repository can see
  // that: it typechecks, it lints, and it looks finished on screen.
  //
  // Substring pins, deliberately not byte windows — a pin that slices a fixed range false-fails the
  // moment the file above it grows by a line, and a test that cries wolf gets deleted.
  {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    // The CALL, not the name. Both files also mention the function in a comment explaining why it is
    // there, and a pin that matches the comment would go on passing after somebody deleted the line
    // that does the work — which is the exact failure it exists to catch.
    // The TEAM-aware call. Scoping this to the caller's own seats shipped green and refused the one
    // person the folders were built for: a National Sales Manager holds none of the areas his
    // district managers hold, so he could open the picker, see his DM's folders, see the cards —
    // and get a 403 from every View CV button and every comment box on them.
    const call = "await isCandidateInViewerTeamDistrict(access, candidateId)";

    const cvScope = read("../src/lib/recruitment/hiring-manager-view.ts");
    assert.ok(
      cvScope.includes(call),
      "the CV-file scope must admit a candidate in a district folder the caller may open — his own areas OR a reporting manager's, or every card in the team view renders a dead View CV button",
    );

    const comments = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/comments/route.ts");
    assert.ok(
      comments.includes(call),
      "the comment route must admit the same candidate — the owner asked managers to be able to comment on what they read",
    );

    // And it must be the SAME gate the picker is built from. Answering "may I see this manager's
    // folders" one way in the picker and another way in the file route is how a screen ends up
    // offering cards it will not open — the failure above, in its general form.
    const team = read("../src/lib/recruitment/hiring-manager-team.ts");
    assert.ok(
      team.includes("export async function isCandidateInViewerTeamDistrict("),
      "the team-aware district gate lives in hiring-manager-team.ts — district-manager-folders-db.ts must not import the roster back, PR #2816 paid for that cycle with a build crash",
    );
    assert.ok(
      team.includes("canViewerSeeManagerCandidates({ managerHrId: board.managerHrId, roster, viewerHrId: access.hrId })"),
      "it must ask canViewerSeeManagerCandidates about the board's OWN manager — restating the rule is how the offered set and the permitted set drift apart",
    );

    // And the check itself must ASK the same fact that fills the folders rather than restate it. Since
    // 2026-10-16 that fact is a send row (a person pushed the CV to this manager), so the gate and the
    // folders cannot disagree about whose CV it is — both read `isCandidateSentToManager` /
    // `listSendsForManager`, never a placement rule.
    const loader = read("../src/lib/recruitment/district-manager-folders-db.ts");
    assert.ok(
      loader.includes("isCandidateSentToManager(candidateId, viewerHrId)"),
      "isCandidateInViewerDistrict must answer with the same send that fills the folders",
    );
  }

  // ── 12. A typed region that names no district must not cost the CV its district ──────────────
  //
  // THE BUG THIS PINS. `preferred_region_name` is free text, and `districtRoutingRegion` returns it
  // before it will look at anything else. When what was typed matched no district the old code
  // stopped there and reported "no district for region" — with a perfectly good governorate sitting
  // unread on the same row. Seven candidates were invisible to EVERY district manager that way,
  // measured in production on 2026-09-03, and every one of them had named Upper Egypt: "UE ( 1 )",
  // "Upper (1)", "Uper Egypt 1", '"Upper Egypt 1 "' with the quotes stored as data, and three who
  // typed a governorate into the region box. Upper Egypt has four boards.
  //
  // The fix is a FALLBACK, never a reordering: what they typed still wins whenever it names a real
  // district, which is the first assertion below and the one that must never be traded away.
  {
    const ROWS_UE: DistrictSeatRow[] = [
      ...ROWS,
      seat({ seat_id: "cns-ue", seat_tier: "DM", occupant_hr_id: "B-119", line_name: "CNS", region_name: "Upper Egypt", seat_display_label: "CNS Upper Egypt DM" }),
      seat({ seat_id: "cns-ue-1", parent_seat_id: "cns-ue", seat_tier: "REP", area_name: "Sohag" }),
    ];
    const archived = (id: string, fields: Partial<DistrictFolderCandidate> = {}) =>
      candidate(id, { preferencesDeclaredAt: null, preferredAreaName: null, ...fields });

    // THE ORDER. A typed region that names a real district still outranks the governorate — an
    // answer somebody gave beats one read off a CV, and that rule is older than this fallback.
    assert.deepEqual(
      districtRoutingRegionOptions(archived("keeps", { preferredRegionName: "Delta (1)", governorate: "Qena" })),
      ["Delta (1)", "Upper Egypt"],
      "what they typed comes first, and the governorate sits behind it as a fallback rather than replacing it",
    );

    // THE SEVEN. Each of these is a real production value, verbatim, quotes and spacing included.
    for (const typed of ["UE ( 1 )", "Upper (1)", "Uper Egypt 1", '"Upper Egypt 1 "', "Qena", "Minya"]) {
      const options = districtRoutingRegionOptions(archived("x", { preferredRegionName: typed, governorate: "Qena" }));
      assert.equal(
        options[options.length - 1],
        "Upper Egypt",
        `"${typed}" names no district, so the governorate behind it must still answer Upper Egypt`,
      );
    }

    // THE ADDRESS, which is the last leg and the one that carried a real candidate who had no
    // governorate column at all — his address said "El-Minia Governorate" and nothing else did.
    assert.deepEqual(
      districtRoutingRegionOptions(archived("addr", { preferredRegionName: '"Upper Egypt 1 "', governorate: null, address: "Egypt- El-Minia Governorate." })),
      ['"Upper Egypt 1 "', "Upper Egypt"],
      "with no governorate column, the governorate named in the address is what stands between him and nobody",
    );

    // AND THE PLACEMENT ITSELF, because the options list is only half the fix.
    const { boards, unplaced } = placeCandidatesInDistrictFolders({
      candidates: [archived("typed-nonsense", { faculty: "Faculty of Pharmacy", preferredRegionName: "UE ( 1 )", governorate: "Qena" })],
      rows: ROWS_UE,
    });
    const reached = boards
      .filter((board) => board.candidateCount > 0)
      .map((board) => board.seatId)
      .sort();
    assert.deepEqual(
      reached,
      ["ai-ue1", "cns-ue"],
      "a CV whose typed region names nothing still reaches every district that covers the governorate he gave",
    );
    assert.equal(unplaced.length, 0, "and it is not reported as unplaceable, which is what a manager never sees");

    // THE REFUSAL. Nothing here invents a region. When no leg finds a district the CV is still
    // reported unplaced, and the report still names what the PERSON said rather than something
    // inferred underneath it — a recruiter answering that row needs their words, not ours.
    const nowhere = placeCandidatesInDistrictFolders({
      candidates: [archived("atlantis", { faculty: "Faculty of Pharmacy", preferredRegionName: "Atlantis", governorate: "Atlantis" })],
      rows: ROWS_UE,
    });
    assert.equal(nowhere.unplaced.length, 1, "a region nobody recognises is still nobody's district");
    assert.equal(
      nowhere.unplaced[0].declaredArea,
      "Atlantis",
      "and the unplaced row quotes what they typed — the fallback must not rewrite the question a recruiter is being asked",
    );
  }
}
