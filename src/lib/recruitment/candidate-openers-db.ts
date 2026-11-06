// Recruitment / ATS — the database half of "who has already opened this CV?".
//
// What the banner says, who is left out of it and why all live in candidate-openers.ts, which is
// pure. This file only reads `ats_candidate_views` and `employees`.
//
// DEGRADES, NEVER THROWS. A banner that could not be read is a card with no banner, which is exactly
// the screen managers had yesterday — so a missing table, a missing column or a failed read answers
// "nobody has opened anything" and the page renders. Code ships on a merge to `main` and serves
// traffic within minutes, while a migration is a separate announced step; PostgREST names a missing
// table PGRST205 out of its own schema cache and Postgres says 42P01 once it is warm, and both are
// one condition (the same pair candidate-call-claims-db.ts guards).

import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import {
  buildCandidateOpeners,
  openerDirectoryKey,
  type CandidateOpeners,
  type CandidateViewRow,
  type OpenerDirectoryEntry,
} from "@/lib/recruitment/candidate-openers";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { fetchAllRows } from "@/lib/supabase/paginated";

const EMPTY_OPENERS: CandidateOpeners = Object.freeze({});

function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 42P01 undefined_table, 42703 undefined_column, PGRST205 table missing from the schema cache.
  return code === "42P01" || code === "42703" || code === "PGRST205";
}

type ViewRow = {
  candidate_id?: unknown;
  first_seen_at?: unknown;
  last_seen_at?: unknown;
  view_count?: unknown;
  viewer_hr_id?: unknown;
};

async function readViewRows(candidateIds: readonly string[]): Promise<CandidateViewRow[]> {
  const rows: CandidateViewRow[] = [];
  for (const batch of chunkIds(candidateIds)) {
    // Every row of the batch, paged until a short page. The pager appends `viewer_hr_id` after the
    // `candidate_id` order below, which together are unique, so a page boundary cannot repeat or drop
    // a row. There is no page ceiling: a silent one would drop the rest of the batch without a sound.
    const pageRows = await fetchAllRows<ViewRow>(
      () =>
        recruitmentDb()
          .from("ats_candidate_views")
          .select("candidate_id,viewer_hr_id,first_seen_at,last_seen_at,view_count")
          .in("candidate_id", batch)
          .order("candidate_id", { ascending: true }),
      "viewer_hr_id",
    );
    for (const row of pageRows) {
      rows.push({
        candidateId: String(row.candidate_id ?? ""),
        firstSeenAt: String(row.first_seen_at ?? ""),
        lastSeenAt: String(row.last_seen_at ?? ""),
        viewCount: Number(row.view_count ?? 1),
        viewerHrId: String(row.viewer_hr_id ?? ""),
      });
    }
  }
  return rows;
}

/**
 * Name and job title for each opener. `hrIdLookupKeys` on the way in, NOT a plain `.eq`: the views
 * table holds canonical upper case and `employees.hr_id` is whatever was typed.
 *
 * Read from `employees` at render time rather than snapshotted, because a title changes when
 * somebody is promoted and the banner should say what the person is NOW. A leaver keeps their row,
 * so a colleague who has since left is still named.
 */
async function readDirectory(viewerHrIds: readonly string[]): Promise<Map<string, OpenerDirectoryEntry>> {
  const directory = new Map<string, OpenerDirectoryEntry>();
  const ids = Array.from(
    new Set(viewerHrIds.map((id) => openerDirectoryKey(id)).filter((id): id is string => Boolean(id))),
  );
  if (ids.length === 0) return directory;

  for (const batch of chunkIds(ids)) {
    const keys = Array.from(new Set(batch.flatMap((id) => hrIdLookupKeys(id))));
    const { data, error } = await recruitmentDb()
      .from("employees")
      .select("hr_id,full_name,nickname,job_title")
      .in("hr_id", keys);
    if (error) throw error;

    for (const row of (data ?? []) as Array<{
      full_name?: string | null;
      hr_id?: string | null;
      job_title?: string | null;
      nickname?: string | null;
    }>) {
      const key = openerDirectoryKey(String(row.hr_id ?? ""));
      if (!key) continue;
      directory.set(key, {
        name: resolveEmployeeDisplayName(String(row.full_name ?? ""), row.nickname, row.hr_id) || null,
        title: row.job_title?.trim() || null,
      });
    }
  }
  return directory;
}

/**
 * Everybody except `viewerHrId` who has opened each of these CVs, keyed by candidate id.
 *
 * Batched through chunkIds: a manager's page carries several hundred CVs once his district folders
 * are counted, and one `.in()` that long overflows the request-header cap with an error naming
 * neither the query nor the size.
 */
export async function loadCandidateOpeners(
  candidateIds: readonly string[],
  viewerHrId: string | null | undefined,
): Promise<CandidateOpeners> {
  const ids = Array.from(new Set(candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return EMPTY_OPENERS;

  try {
    const rows = await readViewRows(ids);
    if (rows.length === 0) return EMPTY_OPENERS;
    const directory = await readDirectory(rows.map((row) => row.viewerHrId));
    return buildCandidateOpeners(rows, directory, viewerHrId);
  } catch (error) {
    // The expected deploy-before-migration state stays silent; anything else earns a line. Neither
    // may take a manager's whole candidate list down over a banner.
    if (!isMissingRelation(error)) {
      logError("Candidate openers could not be read", {
        error,
        labels: { event: "candidate_openers_read_failed" },
      });
    }
    return EMPTY_OPENERS;
  }
}
