/**
 * Phoenix CRM — the read behind the rep's own open commitments (the rules are commitments.ts).
 *
 * ONE read: his seat's visits inside the last twenty-six weeks, with the customer's name embedded, and
 * nothing else. Everything the screen shows is derived from it — which promise is still open, which
 * group it falls in, and the name to print — so there is no second query and nothing new is stored.
 *
 * 🔴 IT IS THE RAW TABLE, NOT `phoenix_crm_countable_visits`, AND THAT IS THE POINT. A visit still
 * waiting on its off-plan approval counts in no KPI (the visit-type rule), and a promise he made on it
 * is still a promise he made. The visit form's own "what he said last time" reads the raw table for the
 * same reason; filtering here would silently hide exactly the commitments made on the days a rep's
 * week was not sent — which on a team that has just started is most of them.
 *
 * 🔴 THE GATE IS THE REP'S OWN SEAT (`territoryForRepWrite`), ON A READ. It is a write gate by name and
 * the right boundary by meaning: Golden rule #1's line is WHOSE WORK IT IS, and these are the sentences
 * HE wrote. His managers read the place-vs-actual report and the team boards, never his notebook — a
 * manager-readable "nine promises open, none kept" is precisely the judgement the rule keeps off this
 * module. So no predicate here is widened, and the Super Admin reaches it in test mode only, as he
 * reaches every other entry of a rep's.
 *
 * It is PAGED on the primary key (`fetchAllRowsKeyset`). A rep makes a few hundred visits in
 * twenty-six weeks, so it sits under PostgREST's 1,000-row cap today — and a read that grows with the
 * field is paged or it lies at 1,000 with no error and no marker (module memory).
 */

import { addDaysIso } from "@/lib/crm/dates";
import { openCommentFollowUps, type CommentFollowUp } from "@/lib/phoenix-crm/comment-reading";
import { buildRepCommitments, type CommitmentVisitRow, type RepCommitments } from "@/lib/phoenix-crm/commitments";
import { LAST_SEEN_WINDOW_DAYS } from "@/lib/phoenix-crm/plan-insight";
import { readTestFlag, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadSeatCommentFollowUps } from "@/lib/phoenix-crm/server/comment-reading";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type RepCommitmentsView = RepCommitments & {
  territory: TerritorySummary;
  isTest: boolean;
  /**
   * The VISIT day, not the calendar day: until 02:00 the day that just ended is still his (owner,
   * 2026-09-29). It is what "Overdue", "You set today" and "Later this week" are measured against, so
   * a rep writing up his evening at 01:00 is not told his own promise for that day has passed.
   */
  today: string;
  /**
   * What the rep wrote in a visit comment about doing next, in the rep's own words. Behind the same seat gate
   * as everything above, so nobody above the rep reads it. Null when the read failed: never shown as nothing.
   */
  fromComments: { followUps: CommentFollowUp[]; older: number } | null;
};

/** The customer's name as the embed answers it — PostgREST returns an object, or an array of one. */
function embeddedName(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return "";
  return textOrNull((row as Row).name) ?? "";
}

export async function loadRepCommitments(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown },
): Promise<RepCommitmentsView> {
  const { seat, isTest } = territoryForRepWrite(viewer, raw.seatId, readTestFlag(raw.test));
  const today = viewer.visitDay;

  const fromDay = addDaysIso(today, -LAST_SEEN_WINDOW_DAYS);
  const [rows, names, followUps] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_visits")
          .select("id, customer_id, visit_date, captured_at, next_step, next_step_on, customer:phoenix_crm_customers!customer_id(name)")
          .eq("seat_id", seat.seatId)
          .eq("is_test", isTest)
          .gte("visit_date", fromDay),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    loadPeopleNames(territoryPeople(viewer.org, [seat])),
    loadSeatCommentFollowUps(seat.seatId, fromDay),
  ]);

  const visits: CommitmentVisitRow[] = rows.map((row) => ({
    customerId: String(row.customer_id ?? ""),
    customerName: embeddedName(row.customer),
    visitDate: String(row.visit_date ?? ""),
    capturedAt: String(row.captured_at ?? ""),
    nextStep: textOrNull(row.next_step),
    nextStepOn: textOrNull(row.next_step_on),
  }));

  return {
    ...buildRepCommitments({ visits, today }),
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    today,
    fromComments:
      followUps === null
        ? null
        : openCommentFollowUps({
            followUps,
            today,
            visits: rows.map((row) => ({
              visitId: String(row.id),
              customerId: String(row.customer_id ?? ""),
              customerName: embeddedName(row.customer),
              visitDate: String(row.visit_date ?? ""),
              capturedAt: String(row.captured_at ?? ""),
            })),
          }),
  };
}
