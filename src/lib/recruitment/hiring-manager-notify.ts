// Recruitment / ATS — pushing a candidate to the hiring manager, as a deliberate, recorded act.
//
// This is the one step the whole module exists to serve: a CV arrives, the AI reads it, and a
// recruiter sends the person to the District Manager (or whoever owns that seat) to look at.
// Until 2026-08-15 it was neither deliberate nor recorded:
//
//   • It fired only as a SIDE EFFECT of picking a value in a dropdown labelled "Pick a position…",
//     so nobody chose to send anything and nobody could re-send.
//   • createApplication wrapped the send in `catch {}` — an empty block that discarded the error.
//     In production 5 candidates were assigned and only 2 notifications ever fired; the 3 failures
//     left no log, no row and no error message anywhere, including both of the owner's own attempts
//     on 2026-08-15. "It silently did nothing" was indistinguishable from "it worked".
//
// So this module does three things the old inline block did not: it returns a RESULT the caller can
// show on screen, it writes an ats_application_events row so the send is visible in history and
// survives a page reload, and it lets a failed send be retried instead of being lost.
//
// Kept out of applications.ts (which imports it) so the notification concern stays testable on its
// own and applications.ts keeps its single job of moving stages.

import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { writeApplicationEvent } from "@/lib/recruitment/db";

/** The audit action written to ats_application_events when a manager is told about a candidate. */
export const MANAGER_NOTIFIED_ACTION = "manager_notified";

export type HiringManagerNotifyResult =
  | { sent: true; managerHrId: string; managerName: string; sentAt: string }
  /**
   * Not every application HAS a manager to notify, and that is not a failure — a requisition
   * created against a seat with no manager on the organogram carries no hiringManagerHrId, and a
   * manager assigning a candidate to their own seat does not need telling. Distinguished from a
   * genuine failure so the UI can say which happened instead of showing a red error for both.
   */
  | { sent: false; reason: "no_hiring_manager" | "actor_is_the_manager" };

/** A manager a candidate can be pushed to, named the way a person reads it — never a raw HR_ID. */
export type HiringManagerOption = {
  hrId: string;
  name: string;
  jobTitle: string;
  /**
   * Where this manager's seat is. Carried since 2026-08-27 because a name alone is not enough to
   * pick correctly: the live dropdown holds 31 people across 11 distinct job titles, 17 of them
   * District Sales Managers, so telling one from another meant recognising a person rather than
   * reading a seat. Measured the same day, 28 of the 31 carry an area and all 31 carry a region.
   *
   * Null where the employee row has none — shown as nothing rather than as a guess.
   */
  areaName: string | null;
  regionName: string | null;
};

/** The manager's seat as it was AT THE MOMENT OF A SEND, frozen onto the candidate row. */
export type NotifiedManagerContext = {
  name: string;
  jobTitle: string | null;
  areaName: string | null;
  regionName: string | null;
};

/**
 * Everyone a candidate can be sent to.
 *
 * Deliberately title-driven rather than a curated list or an app-role check: the org's managers are
 * exactly the people whose job title says so, and a curated list is one more thing that goes stale
 * the day someone is promoted. Measured in production 2026-08-15 this yields 30 people, 17 of them
 * District Sales Managers — small enough to be one dropdown, which is the whole point of the
 * feature. Sorted by title then name so the District Sales Managers, who receive nearly every push,
 * do not have to be hunted for among the Finance and R&D managers.
 *
 * The employment filter goes through ACTIVE_EMPLOYMENT_STATUSES_IN_LIST rather than a hand-written
 * literal, and that is not tidiness. `employment_status` in production is lower-case `active` on all
 * 112 live employees; an `.eq("employment_status", "Active")` here matched ZERO rows, which made the
 * dropdown empty and every send fail with "That person is not a manager who can be sent candidates."
 * PostgREST `eq` is case-sensitive and a filter that matches nothing looks exactly like an org with
 * no managers. The shared constant also covers `on_leave` — a manager on leave is still the person
 * who owns that seat when they return, and their CVs should not silently route to nobody.
 */
export async function listHiringManagerOptions(): Promise<HiringManagerOption[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,nickname,job_title,area_name,region_name")
    .filter("employment_status", "in", ACTIVE_EMPLOYMENT_STATUSES_IN_LIST)
    .or("job_title.ilike.*manager*,job_title.ilike.*director*,job_title.ilike.*head*,job_title.ilike.*chief*");
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    hr_id?: string | null;
    full_name?: string | null;
    nickname?: string | null;
    job_title?: string | null;
    area_name?: string | null;
    region_name?: string | null;
  }>;

  return rows
    .filter((row) => Boolean(row.hr_id) && Boolean(row.full_name))
    .map((row) => ({
      areaName: String(row.area_name ?? "").trim() || null,
      hrId: String(row.hr_id),
      jobTitle: String(row.job_title ?? "").trim() || "Manager",
      name: resolveEmployeeDisplayName(String(row.full_name), row.nickname ?? null),
      regionName: String(row.region_name ?? "").trim() || null,
    }))
    .sort(
      (left, right) =>
        left.jobTitle.localeCompare(right.jobTitle) ||
        // Area before name, so the seventeen District Sales Managers arrive grouped by territory
        // rather than alphabetically scattered across the country.
        (left.areaName ?? "").localeCompare(right.areaName ?? "") ||
        left.name.localeCompare(right.name),
    );
}

/**
 * The manager's name and seat, for stamping onto a candidate at send time.
 *
 * Looked up through hrIdLookupKeys rather than a bare `.eq("hr_id", …)`. The ids in this module
 * cross two tables that disagree about case — `ats_candidates` holds lower-case ids while
 * `employees` holds upper-case — and PostgREST `eq` is case-sensitive, so an exact match on the
 * wrong casing returns no row and the send is silently attributed to a raw HR_ID with no title and
 * no area. That is the same class of bug that once made a dropdown empty and every send fail.
 *
 * Falls back to the HR_ID as the name, and nulls elsewhere, exactly as the old name-only lookup
 * did: an unresolvable manager must degrade to "we do not know their seat", never to a thrown
 * request that loses the send.
 */
export async function notifiedManagerContext(hrId: string): Promise<NotifiedManagerContext> {
  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("full_name,nickname,job_title,area_name,region_name")
      .in("hr_id", hrIdLookupKeys(hrId))
      .limit(1)
      .maybeSingle();
    const row = data as {
      full_name?: string;
      nickname?: string | null;
      job_title?: string | null;
      area_name?: string | null;
      region_name?: string | null;
    } | null;
    if (!row?.full_name) return { areaName: null, jobTitle: null, name: hrId, regionName: null };
    return {
      areaName: String(row.area_name ?? "").trim() || null,
      jobTitle: String(row.job_title ?? "").trim() || null,
      name: resolveEmployeeDisplayName(row.full_name, row.nickname),
      regionName: String(row.region_name ?? "").trim() || null,
    };
  } catch {
    return { areaName: null, jobTitle: null, name: hrId, regionName: null };
  }
}

/** Human-readable name for an HR_ID, per the standing rule that no raw code reaches a person. */
export async function hiringManagerName(hrId: string): Promise<string> {
  return (await notifiedManagerContext(hrId)).name;
}

/**
 * Push a candidate to a manager with NO requisition in between, and stamp the candidate row.
 *
 * This is the shortest path the module has, and the owner's actual ask: a CV arrives, the AI reads
 * it, and the recruiter sends the person to a District Manager. Measured in production 2026-08-15,
 * 214 of the 221 people in the pool had never left it, because the only route to a manager ran
 * through createApplication -> a requisition -> a job title, line, area, seat and owner. None of
 * that is needed to ask someone "look at this CV".
 *
 * Same contract as the application-level push above: it THROWS on a real delivery failure, and the
 * record is written only once the manager has actually been told.
 */
export async function pushCandidateToManager(input: {
  actorHrId: string | null;
  candidateId: string;
  candidateName: string;
  managerHrId: string;
}): Promise<{ managerHrId: string; managerName: string; sentAt: string }> {
  const { count: _count, ...sent } = await pushCandidatesToManager({
    actorHrId: input.actorHrId,
    candidates: [{ id: input.candidateId, name: input.candidateName }],
    managerHrId: input.managerHrId,
  });
  return sent;
}

/** "Ahmed, Sara and Mona" — never an ellipsis, never a count standing in for the names. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * True when the database has not learned the three seat columns yet.
 *
 * Two codes, because the two layers disagree about which one this is. PostgREST answers a write
 * naming an unknown column with PGRST204 out of its own schema cache, while PostgreSQL itself
 * raises 42703 (undefined_column) — which is what arrives when the cache is warm but the column
 * genuinely is not there. Matching only one of them leaves the other as a thrown send.
 *
 * Deliberately narrow: it is checked ONLY around the seat-stamp update, so a real write failure on
 * any other column still throws and is still visible.
 */
function isMissingSeatColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "PGRST204" || code === "42703";
}

/**
 * Push one OR MANY candidates to a manager in a single notification.
 *
 * The one-notification-per-candidate shape is what makes this worth having. Measured in production
 * on 2026-08-15 the pool receives 152 CVs a week and the District Sales Managers take nearly all of
 * them; sending five people to the same manager as five separate alerts is how a useful signal
 * becomes something they mute. One alert names everybody in it — no ellipsis, no "and 3 others",
 * because a manager deciding whether to open it needs to see who is in it.
 *
 * Every candidate is stamped, and the stamp is written only AFTER delivery, for the same reason the
 * single-candidate path always has: history must never claim a send that did not happen.
 */
export async function pushCandidatesToManager(input: {
  actorHrId: string | null;
  candidates: Array<{ id: string; name: string }>;
  managerHrId: string;
}): Promise<{ count: number; managerHrId: string; managerName: string; sentAt: string }> {
  if (input.candidates.length === 0) {
    throw new Error("Choose at least one candidate to send.");
  }
  const manager = await notifiedManagerContext(input.managerHrId);
  const managerName = manager.name;
  const names = input.candidates.map((candidate) => candidate.name);
  const many = input.candidates.length > 1;

  await createSystemNotification({
    // The manager's own screen, NOT the CV database. This link pointed at
    // /employee-portals/cv-database until 2026-08-15, which answers anyone who is not Talent
    // Acquisition or Super Admin with "The CV database is available to Talent Acquisition and Super
    // Admin only" — so the entire flow this module exists for ended on a locked door for exactly the
    // District Managers it was built to reach. My Candidates lists the pushes by HR_ID, newest
    // first, so the person named in this alert is at the top whether one or five were sent.
    actionUrl: "/employee-portals/recruitment-candidates",
    // Owner rule 2026-08-24: never email a candidate push. Stated here so the intent is readable
    // where the notification is written; the guarantee is enforceCandidateAssignedEmailBlock, which
    // strips email from the RESOLVED list whatever this line, the policy row, or the
    // Telegram-failure fallback asks for.
    //
    // Telegram added the same day, on the owner's follow-up. It is the channel that actually
    // reaches a District or National Sales Manager in the field, where the portal bell only works
    // once they open it. The recruitment module is governed `enabled: true, genericOnly: false`, so
    // the message goes out in full rather than as an unactionable "you have a notification" ping.
    channels: ["in_app", "telegram", "push"],
    eventType: "candidate_assigned",
    message: `${joinNames(names)} ${many ? "have" : "has"} been sent to you to review.`,
    module: "recruitment",
    priority: "normal",
    recipientHrId: input.managerHrId,
    title: many ? `${input.candidates.length} new candidates to review` : "New candidate to review",
  });

  const sentAt = new Date().toISOString();

  // One update per batch, all the stamp columns together — so a stamp is never half-written and
  // mapCandidate never has to render a send attributed to nobody. Batched through chunkIds because
  // the id list comes from a multi-select and is therefore unbounded (see db-batch.ts).
  //
  // The seat travels WITH the send rather than being joined on render. A manager who moves from
  // Giza to Cairo next month did not retroactively change where last week's CVs went, and an
  // archived leaver must not turn eight recorded sends into blanks — the same reasoning that put
  // manager_notified_name here in the first place, now applied to the title and the area the
  // recruiter's grouping is built on.
  // The three seat columns are NEWER THAN THIS CODE PATH. Code reaches production on a merge to
  // `main` and ships immediately; the migration that adds them is a separate, announced step that
  // happens around it. In the window between the two, PostgREST answers an update naming a column
  // it has never heard of with PGRST204 / 42703 — and this update is the one that records the send,
  // so a bare throw there would mean "Send to manager" is simply broken until somebody runs a
  // migration. It degrades instead: stamp the seat when the columns exist, and record the send
  // WITHOUT the seat when they do not. A send with no seat is what every send looked like
  // yesterday; a send that fails is a regression.
  const identity = {
    manager_notified_at: sentAt,
    manager_notified_hr_id: input.managerHrId,
    manager_notified_name: managerName,
  };
  const seat = {
    manager_notified_area: manager.areaName,
    manager_notified_job_title: manager.jobTitle,
    manager_notified_region: manager.regionName,
  };

  const supabase = getSupabaseAdmin();
  let seatColumnsExist = true;
  for (const batch of chunkIds(input.candidates.map((candidate) => candidate.id))) {
    // One update per batch, identity and seat together — so a stamp is never half-written and
    // mapCandidate never has to render a send attributed to nobody.
    const attempt = await supabase
      .from("ats_candidates")
      .update(seatColumnsExist ? { ...identity, ...seat } : identity)
      .in("id", batch);
    if (attempt.error && seatColumnsExist && isMissingSeatColumn(attempt.error)) {
      // Once, then never again for this send: the answer is a property of the schema, not of the
      // batch, so re-asking per batch would double every write on an un-migrated database.
      seatColumnsExist = false;
      const retry = await supabase.from("ats_candidates").update(identity).in("id", batch);
      // Unlike the audit row elsewhere in this module, this is NOT best-effort: it is the only
      // place the send is recorded, so swallowing it would recreate exactly the invisibility this
      // work exists to end.
      if (retry.error) throw retry.error;
      continue;
    }
    if (attempt.error) throw attempt.error;
  }

  return { count: input.candidates.length, managerHrId: input.managerHrId, managerName, sentAt };
}

/**
 * Tell the requisition's hiring manager that a candidate is waiting on their seat, and record it.
 *
 * THROWS on a real delivery failure. That is the deliberate reversal of the old behaviour: the
 * caller decides what a failure means (createApplication logs it and still keeps the assignment;
 * the explicit "Send to manager" button surfaces it to the person who pressed it), but nothing
 * discards it silently any more.
 */
export async function notifyHiringManagerOfCandidate(input: {
  applicationId: string;
  actorHrId: string | null;
  candidateName: string;
  hiringManagerHrId: string | null;
  jobTitle: string;
  /** True when the actor IS the hiring manager — sending them their own alert is noise. */
  actorIsTheManager: boolean;
}): Promise<HiringManagerNotifyResult> {
  if (!input.hiringManagerHrId) return { sent: false, reason: "no_hiring_manager" };
  if (input.actorIsTheManager) return { sent: false, reason: "actor_is_the_manager" };

  const managerName = await hiringManagerName(input.hiringManagerHrId);

  await createSystemNotification({
    actionUrl: "/employee-portals/recruitment-candidates",
    // Same owner rule as the push above — the requisition-level assignment is the same event type
    // reaching the same person, so it is silenced by the same guard and carried on the same three
    // channels. The two lists are kept identical deliberately: a manager should not learn about a
    // candidate differently depending on which screen the recruiter happened to start from.
    channels: ["in_app", "telegram", "push"],
    eventType: "candidate_assigned",
    message: `${input.candidateName} has been assigned to your ${input.jobTitle} position.`,
    module: "recruitment",
    priority: "normal",
    recipientHrId: input.hiringManagerHrId,
    title: "New candidate assigned",
  });

  const sentAt = new Date().toISOString();

  // Written only AFTER the send succeeds, so the history never claims a delivery that did not
  // happen — the exact failure mode this whole module exists to end. Best-effort on its own: a
  // notification that reached the manager must not be reported as failed because the audit row
  // could not be written.
  try {
    await writeApplicationEvent({
      action: MANAGER_NOTIFIED_ACTION,
      actorHrId: input.actorHrId,
      applicationId: input.applicationId,
      details: { managerHrId: input.hiringManagerHrId, managerName, sentAt },
      fromStage: null,
      toStage: null,
    });
  } catch {
    /* the manager has been told; the audit row is a convenience, not the delivery */
  }

  return { sent: true, managerHrId: input.hiringManagerHrId, managerName, sentAt };
}
