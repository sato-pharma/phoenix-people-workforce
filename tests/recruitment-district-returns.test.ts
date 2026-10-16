import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  districtReturnSuppressionKey,
  placeCandidatesInDistrictFolders,
  REGION_FOLDER_LABEL,
  type DistrictFolderCandidate,
  type DistrictSeatRow,
} from "../src/lib/recruitment/district-manager-folders.ts";

/**
 * "Make an option to tell them return this CV to the administrator because area not match — or any
 *  other situation ... and this returned CV is not any more in the district manager folder." — the
 *  owner, 2026-09-01.
 *
 * A return is a SUPPRESSION, not a move: the folders are derived from the organogram at read time, so
 * nothing is stored to "remove". The whole risk lives in ONE property — a return by one manager must
 * leave the same CV in every OTHER line's folder. Nasr City is a rep seat on Anti Infective, CNS and
 * Pedia at once, so a CV there sits in three managers' folders; a return keyed on the candidate alone
 * would strip it from all three, and the two managers who never touched it would silently lose an
 * applicant they were meant to screen. The failure is invisible — an empty folder reads as "nobody
 * applied", not as "somebody else returned him" — which is exactly why it is pinned here.
 *
 * The fixture is the sibling suite's production shape, trimmed to the Cairo districts that share Nasr
 * City plus the split-region Upper Egypt case the catch-all path runs through.
 */

function seat(fields: Partial<DistrictSeatRow>): DistrictSeatRow {
  return { is_vacant: false, ...fields };
}

const ROWS: DistrictSeatRow[] = [
  seat({ seat_id: "nsm-pd", seat_tier: "NSM", occupant_hr_id: "a-12", line_name: "Pedia", seat_display_label: "PEDIA NSM" }),

  // Anti Infective · Cairo — occupied by AI-0001, holds Nasr City.
  seat({ seat_id: "ai-cairo", seat_tier: "DM", occupant_hr_id: "AI-0001", line_name: "Anti Infective", region_name: "Cairo", seat_display_label: "ANTI_INFECTIVE Cairo DM" }),
  seat({ seat_id: "ai-cairo-1", parent_seat_id: "ai-cairo", seat_tier: "REP", area_name: "Nasr City" }),

  // CNS · Cairo — occupied by B-116, holds Nasr City too.
  seat({ seat_id: "cns-cairo", seat_tier: "DM", occupant_hr_id: "B-116", line_name: "CNS", region_name: "Cairo", seat_display_label: "CNS Cairo DM" }),
  seat({ seat_id: "cns-cairo-1", parent_seat_id: "cns-cairo", seat_tier: "REP", area_name: "Nasr City" }),

  // Pedia · Cairo — DM post VACANT, holds Nasr City; opened by the NSM above (a-12).
  seat({ seat_id: "pd-cairo", parent_seat_id: "nsm-pd", seat_tier: "DM", occupant_hr_id: null, is_vacant: true, line_name: "Pedia", region_name: "Cairo", seat_display_label: "PEDIA Cairo DM (VACANT)" }),
  seat({ seat_id: "pd-cairo-1", parent_seat_id: "pd-cairo", seat_tier: "REP", area_name: "Nasr City" }),
];

// The split-region case: Anti Infective splits Upper Egypt into 1 and 2, CNS holds it whole. An
// archived CV with a Qena governorate reaches BOTH catch-alls, which is where the region path proves
// the suppression choke point covers it as well as the area path.
const ROWS_UE: DistrictSeatRow[] = [
  seat({ seat_id: "ai-ue1", seat_tier: "ACTING_DM", occupant_hr_id: "B-1", line_name: "Anti Infective", region_name: "Upper Egypt 1", seat_display_label: "ANTI_INFECTIVE Upper Egypt 1 acting DM" }),
  seat({ seat_id: "ai-ue1-1", parent_seat_id: "ai-ue1", seat_tier: "REP", area_name: "Qena 1" }),
  seat({ seat_id: "cns-ue", seat_tier: "DM", occupant_hr_id: "B-119", line_name: "CNS", region_name: "Upper Egypt", seat_display_label: "CNS Upper Egypt DM" }),
  seat({ seat_id: "cns-ue-1", parent_seat_id: "cns-ue", seat_tier: "REP", area_name: "Sohag" }),
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

function boardBySeat(boards: ReturnType<typeof placeCandidatesInDistrictFolders>["boards"], seatId: string) {
  const board = boards.find((entry) => entry.seatId === seatId);
  assert.ok(board, `expected a board for ${seatId}`);
  return board;
}

function holdsCandidate(
  board: ReturnType<typeof placeCandidatesInDistrictFolders>["boards"][number],
  candidateId: string,
): boolean {
  return board.folders.some((folder) => folder.candidates.some((row) => row.id === candidateId));
}

export function runRecruitmentDistrictReturnsTests(): void {
  // ── The key: per MANAGER, tolerant of hr-id case, distinct per candidate ───────────────────────
  {
    assert.equal(
      districtReturnSuppressionKey("AI-0001", "nasr"),
      districtReturnSuppressionKey("ai-0001", "nasr"),
      "the org tree holds AI-0001 and the returns table stores whatever case the session carried — the key must fold both so a stored return still suppresses the right board",
    );
    assert.notEqual(
      districtReturnSuppressionKey("AI-0001", "nasr"),
      districtReturnSuppressionKey("B-116", "nasr"),
      "a return is per manager — the same CV returned by the Anti Infective DM must not read as returned by the CNS DM",
    );
    assert.notEqual(
      districtReturnSuppressionKey("AI-0001", "nasr"),
      districtReturnSuppressionKey("AI-0001", "other"),
      "and per candidate — returning one CV must not suppress a different one",
    );
    assert.equal(districtReturnSuppressionKey(null, "nasr"), "::nasr", "a missing manager keys to an empty half, never to a wildcard");
  }

  // ── THE HEADLINE: a return drops the CV from the returning manager ONLY ─────────────────────────
  {
    const base = placeCandidatesInDistrictFolders({
      candidates: [candidate("nasr", { preferredAreaName: "Nasr City" })],
      rows: ROWS,
    });
    assert.equal(base.placements, 3, "baseline — Nasr City sits in all three managers' folders");

    const returned = placeCandidatesInDistrictFolders({
      candidates: [candidate("nasr", { preferredAreaName: "Nasr City" })],
      rows: ROWS,
      // The Anti Infective Cairo DM (AI-0001) hands it back.
      suppressedReturns: new Set([districtReturnSuppressionKey("AI-0001", "nasr")]),
    });

    assert.equal(
      returned.placements,
      2,
      "one manager returned it, so it is placed in two folders instead of three — not zero, not still three",
    );
    assert.equal(
      boardBySeat(returned.boards, "ai-cairo").candidateCount,
      0,
      "it left the folder of the manager who returned it",
    );
    assert.ok(
      holdsCandidate(boardBySeat(returned.boards, "cns-cairo"), "nasr"),
      "…and stayed in the CNS manager's folder, who never touched it — the half that would fail silently",
    );
    assert.ok(
      holdsCandidate(boardBySeat(returned.boards, "pd-cairo"), "nasr"),
      "…and in the Pedia district the NSM covers, likewise untouched",
    );
  }

  // ── A return stored in a DIFFERENT case than the org tree still suppresses ──────────────────────
  {
    const returned = placeCandidatesInDistrictFolders({
      candidates: [candidate("nasr", { preferredAreaName: "Nasr City" })],
      rows: ROWS,
      // The board's manager is "AI-0001"; the stored return carries the lowercase the session had.
      suppressedReturns: new Set([districtReturnSuppressionKey("ai-0001", "nasr")]),
    });
    assert.equal(
      boardBySeat(returned.boards, "ai-cairo").candidateCount,
      0,
      "the suppression folds hr-id case on BOTH sides — a return written as ai-0001 still clears the AI-0001 board",
    );
    assert.equal(returned.placements, 2, "and the other two lines keep it");
  }

  // ── The CATCH-ALL path honours a return too — one choke point, both routes ──────────────────────
  //
  // A return could have been wired into the area path and quietly skipped the region backfill. The
  // suppression lives at the single `fileInto`, so an archived CV routed by governorate is dropped
  // from the returning manager's catch-all exactly like an area CV.
  {
    const archived = candidate("ue", {
      faculty: "Faculty of Pharmacy",
      governorate: "Qena",
      preferencesDeclaredAt: null,
      preferredAreaName: null,
    });

    const base = placeCandidatesInDistrictFolders({ candidates: [archived], rows: ROWS_UE });
    assert.equal(base.placements, 2, "baseline — an Upper Egypt CV reaches both the anti-infective half and the line that spells the region plainly");

    const returned = placeCandidatesInDistrictFolders({
      candidates: [archived],
      rows: ROWS_UE,
      // The acting DM on Anti Infective Upper Egypt 1 (B-1) returns it.
      suppressedReturns: new Set([districtReturnSuppressionKey("B-1", "ue")]),
    });
    assert.equal(returned.placements, 1, "returned by one, kept by the other");

    const ue1 = boardBySeat(returned.boards, "ai-ue1");
    const catchAll = ue1.folders.find((folder) => folder.areaName === REGION_FOLDER_LABEL);
    assert.deepEqual(catchAll?.candidates ?? [], [], "the returned CV left the returning manager's catch-all");
    assert.ok(
      holdsCandidate(boardBySeat(returned.boards, "cns-ue"), "ue"),
      "…and stayed in the CNS Upper Egypt catch-all",
    );
  }

  // ── A returned CV does not drag an UNRELATED candidate out with it ──────────────────────────────
  {
    const returned = placeCandidatesInDistrictFolders({
      candidates: [
        candidate("nasr", { preferredAreaName: "Nasr City" }),
        candidate("nasr2", { preferredAreaName: "Nasr City" }),
      ],
      rows: ROWS,
      suppressedReturns: new Set([districtReturnSuppressionKey("AI-0001", "nasr")]),
    });
    const aiCairo = boardBySeat(returned.boards, "ai-cairo");
    assert.equal(aiCairo.candidateCount, 1, "only the returned CV left the folder");
    assert.ok(holdsCandidate(aiCairo, "nasr2") && !holdsCandidate(aiCairo, "nasr"), "the other Nasr City applicant is untouched");
  }

  // ── The wiring: the two paths, the two gates, the reason rule ───────────────────────────────────
  //
  // The behaviour above is the pure rule. These pin the callers that decide WHEN suppression applies
  // and WHO may write or clear a return — the parts a node test cannot execute without a database.
  {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    // ── The report path stays blind to returns; the manager path applies them ────────────────────
    const loader = read("../src/lib/recruitment/district-manager-folders-db.ts");
    // 2026-10-16: a return no longer needs remembering as a suppression. The return route deletes the
    // manager's own send row (`deleteManagerSend`), so the folder, the access gate and the reminders
    // all read one fact; the report path still reads every send ever made, the returned one included
    // only while it exists, which is why the route records the return in the returns table FIRST.
    assert.ok(
      loader.includes("listAllManagerSends()"),
      "the whole-company report path reads every send, with no 45-day window",
    );
    assert.ok(
      loader.includes("await listSendsForManager(managerHrId)"),
      "the manager-scoped path reads only the CVs sent to him — a returned one has no send row left",
    );
    assert.ok(
      loader.includes("(await isCandidateSentToManager(candidateId, viewerHrId)) === true"),
      "isCandidateInViewerDistrict must revoke access to a CV the manager returned — the same fact that drops it from his folder",
    );
    assert.ok(
      !loader.includes("isReturnSuppressed") && !loader.includes("loadManagerReturnSuppressions"),
      "the folder loader keeps no second copy of a return",
    );

    // ── The return route: the grant every DM holds, gated to a CV actually in his district ───────
    const returnRoute = read("../app/api/recruitment/candidates/[id]/district-return/route.ts");
    assert.ok(
      returnRoute.includes('requireRecruitmentAccess(request, "hiring_interviews", "update")'),
      "returning is the folder grant a district manager already holds",
    );
    assert.ok(
      returnRoute.includes("isCandidateInViewerDistrictScope(access.hrId, id)"),
      "…but only on a CV that is genuinely in one of his areas — the suppression-BLIND scope check, so a second press is an honest 'already returned', not a 403",
    );
    assert.ok(
      returnRoute.includes('reasonCode === "other" && !reasonNote'),
      "a free-form reason must carry a note — 'other' with nothing said is refused",
    );

    // ── The resolve route and the page: the recruiting-admin grant, never the DM's ───────────────
    const resolveRoute = read("../app/api/recruitment/district-returns/[id]/resolve/route.ts");
    assert.ok(
      resolveRoute.includes('requireRecruitmentAccess(request, "recruitment", "update")'),
      "clearing the queue is the recruiting-admin grant a district manager does not hold — the person clearing it is never the person who filled it",
    );

    const page = read("../app/(admin)/recruitment/returned-cvs/page.tsx");
    assert.ok(
      page.includes("isHrAuthorityRole(access.role)") && page.includes('canAccess(access, "recruitment", "read")'),
      "the queue page is gated exactly as the Recruitment & Hiring hub is — the recruiting admins, never the CEO whose recruitment grants are stripped at runtime",
    );

    // ── The nav row that offers the page reads the SAME grant its page gate reads ─────────────────
    // every-offered-link-opens.test.ts turns this into a hard check across all roles; asserted here
    // too so a change to one without the other is caught beside the feature it belongs to.
    const nav = read("../src/config/system-navigation.ts");
    assert.ok(
      nav.includes('href: "/recruitment/returned-cvs"') &&
        nav.includes('{ href: "/recruitment/returned-cvs", icon: Undo2, label: "Returned CVs", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles }'),
      "the Returned CVs sidebar row must gate on recruitment:read — the same grant its page reads — so the offered set and the reachable set cannot drift",
    );

    // ── The reason vocabulary and the queue's reason ordering ─────────────────────────────────────
    const returns = read("../src/lib/recruitment/district-returns.ts");
    assert.ok(
      returns.includes('return value === "area_not_match" || value === "other";'),
      "exactly two reason codes are accepted — the owner's named case, and a free-form other",
    );
    assert.ok(
      returns.includes('const reasonOrder: DistrictReturnReasonCode[] = ["area_not_match", "other"];'),
      "the queue reads the specific reason before the catch-all, so 'area not match' groups first under each manager",
    );
  }
}
