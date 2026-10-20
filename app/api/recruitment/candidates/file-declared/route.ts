import { NextResponse } from "next/server";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

import { fileCandidateToFolder, listCandidates } from "@/lib/recruitment/candidates";
import { collectSuggestedFilings } from "@/lib/recruitment/candidate-folder-suggestion";
import { listCanonicalMedicalRepAreaNames } from "@/lib/recruitment/candidate-folder-options";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * File every CV whose own WhatsApp answers name its folder.
 *
 * THE SUGGESTIONS ARE RECOMPUTED HERE, from live rows, and the request body can only ever NARROW
 * that set. It cannot name a folder, and it cannot add a candidate the rules did not already place.
 * That is the point: this is a bulk write that removes CVs from the pool everybody works from, so
 * the one thing it must not do is take a browser's word for where somebody belongs. A screen left
 * open while a colleague re-opens a candidate, or a request replayed by hand, then files exactly
 * what the current data supports and nothing else.
 *
 * `candidates: update`, matching the single-candidate folder route — same change, more rows.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");

    // An empty body means "file everything currently suggested". A `candidateIds` array narrows it
    // to those the caller can actually see on their screen.
    const body = await readJsonObject(request).catch(() => ({}) as Record<string, unknown>);
    const rawIds = Array.isArray(body.candidateIds) ? body.candidateIds : null;
    const wanted = rawIds
      ? new Set(rawIds.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0))
      : null;

    // The slim read: the folder suggestions come from WhatsApp answers, never the repeating CV blocks.
    const [everyone, canonicalAreas] = await Promise.all([
      listCandidates({ withRepeatingCvBlocks: false }),
      listCanonicalMedicalRepAreaNames(),
    ]);
    // The Talent Acquisition fence (owner, 2026-10-20): she neither files nor hears about an HR applicant.
    const candidates = await fenceRowsByCandidate(access, everyone, (candidate) => candidate.id);
    const { filings, skipped } = collectSuggestedFilings(candidates, canonicalAreas);
    const targets = wanted ? filings.filter((filing) => wanted.has(filing.candidateId)) : filings;

    const filed: Array<{ candidateId: string; folder: string }> = [];
    const failed: Array<{ candidateId: string; reason: string }> = [];

    // Sequential on purpose. This is a small set by construction — it is bounded by how many people
    // finished a WhatsApp conversation — and a burst of parallel writes against the same table buys
    // nothing here while making a partial failure much harder to describe afterwards.
    for (const filing of targets) {
      try {
        await fileCandidateToFolder(
          access,
          filing.candidateId,
          filing.suggestion.kind,
          filing.suggestion.key,
        );
        filed.push({ candidateId: filing.candidateId, folder: filing.suggestion.label });
      } catch (error) {
        // One bad row must not abandon the rest half-done and unreported. Every failure is named.
        failed.push({
          candidateId: filing.candidateId,
          reason: error instanceof Error ? error.message : "Failed to file this CV.",
        });
      }
    }

    return NextResponse.json({
      failed,
      filedCount: filed.length,
      filed,
      // Returned even on success: the owner needs to see who answered and still could NOT be placed,
      // or filing quietly looks like it covered everyone who used the WhatsApp flow.
      skipped,
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to file the declared CVs.");
  }
}
