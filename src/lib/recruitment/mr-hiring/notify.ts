// Recruitment / Medical Rep hiring — the two notices the workflow sends.
//
// §4: "the DSM will receive a system notification". Today a booking made straight on the calendar
// tells nobody — only an interview REQUEST notifies — so a Medical Rep booking now notifies everyone
// on the interview: the lead interviewer and each panel member.
// §8–§9: the NSM's recommendation is the HR Manager's cue for the final decision, so it reaches the
// HR Manager the moment it is written.
//
// NEVER EMAIL, NEVER THE CANDIDATE. Both pass their channels explicitly and each has its own
// `recruitment.<event>` row in src/lib/notifications/policy.ts, so the `recruitment.*` default (which
// carries email) can never apply. A notice is best-effort: an interview still books, and a result
// still saves, when a notice cannot be delivered.

import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { recruitmentManageRoles } from "@/lib/recruitment/access";
import { hrIdsForRoles } from "@/lib/recruitment/inbound/recruitment-notify";
import { cairoWhen } from "@/lib/recruitment/mr-hiring/display";
import { MR_ROUND_LABELS, type MrInterviewRound, type MrPlatform } from "@/lib/recruitment/mr-hiring/vocabulary";

/** The event types — `recruitment.<event>` in the notification policy. */
export const MR_INTERVIEW_BOOKED_EVENT = "mr_interview_booked";
export const MR_RECOMMENDATION_READY_EVENT = "mr_recommendation_ready";

/** The channels both notices use. Email is never one of them. */
export const MR_NOTICE_CHANNELS = ["in_app", "push", "telegram"] as const;

export const MR_PORTAL_INTERVIEWS_HREF = "/employee-portals/recruitment-candidates#mr-interviews";
export const MR_HIRING_PAGE_HREF = "/recruitment/mr-hiring";
/** Talent Acquisition's own address for the same page (the `/hr` namespace serves it). */
export const MR_HIRING_PAGE_HR_HREF = "/hr/recruitment/mr-hiring";

/**
 * Where an interview-booked notice takes each person: the HR Manager and Talent Acquisition to the
 * Medical Rep Hiring page on that candidate (they interview the 1st and 3rd rounds and work the page),
 * every manager to "My Medical Rep interviews" in the portal, where the feedback form is.
 */
export function mrInterviewNoticeHref(seat: "hr_manager" | "talent_acquisition" | "manager", candidateId: string): string {
  const query = `?candidate=${encodeURIComponent(candidateId)}`;
  if (seat === "hr_manager") return `${MR_HIRING_PAGE_HREF}${query}`;
  if (seat === "talent_acquisition") return `${MR_HIRING_PAGE_HR_HREF}${query}`;
  return MR_PORTAL_INTERVIEWS_HREF;
}

/** The interview-booked notice's sentence — pure, so its wording is pinned by a test. */
export function mrInterviewBookedMessage(input: {
  candidateName: string;
  round: MrInterviewRound;
  startsAt: string;
  platform: MrPlatform;
  location: string | null;
}): string {
  const where =
    input.platform === "zoom"
      ? "on Zoom (the link is on the interview)"
      : input.platform === "phone"
        ? "by phone call"
        : `in person at ${input.location?.trim() || "the office"}`;
  return `${MR_ROUND_LABELS[input.round]} with ${input.candidateName}, Medical Representative — ${cairoWhen(input.startsAt)} Cairo time, ${where}. Open the CV before the interview.`;
}

export async function notifyMrInterviewBooked(input: {
  bookingId: string;
  candidateId: string;
  candidateName: string;
  round: MrInterviewRound;
  startsAt: string;
  platform: MrPlatform;
  location: string | null;
  recipientHrIds: Array<string | null | undefined>;
}): Promise<void> {
  const recipients = Array.from(
    new Set(input.recipientHrIds.map((hrId) => String(hrId ?? "").trim().toUpperCase()).filter(Boolean)),
  );
  if (recipients.length === 0) return;
  const [hrManagers, talentAcquisition] = await Promise.all([
    hrIdsForRoles(recruitmentManageRoles).catch(() => [] as string[]),
    hrIdsForRoles(["HR Resourcing"]).catch(() => [] as string[]),
  ]);
  const seatOf = (hrId: string) =>
    hrManagers.includes(hrId) ? "hr_manager" : talentAcquisition.includes(hrId) ? "talent_acquisition" : "manager";
  const groups = new Map<ReturnType<typeof seatOf>, string[]>();
  for (const hrId of recipients) groups.set(seatOf(hrId), [...(groups.get(seatOf(hrId)) ?? []), hrId]);
  await Promise.all(
    [...groups].map(([seat, hrIds]) =>
      createSystemNotificationForRecipients(
        {
          actionUrl: mrInterviewNoticeHref(seat, input.candidateId),
          channels: [...MR_NOTICE_CHANNELS],
          eventType: MR_INTERVIEW_BOOKED_EVENT,
          message: mrInterviewBookedMessage(input),
          // The seat is in the key: a group of ONE recipient keeps the key unsuffixed, so two groups
          // of one (the HR Manager and the NSM on a joint final) would otherwise land on one row.
          metadata: { bookingId: input.bookingId, candidateId: input.candidateId, idempotencyKey: `mr-interview-booked:${input.bookingId}:${seat}` },
          module: "recruitment",
          priority: "high",
          title: `Interview booked: ${input.candidateName}`,
        },
        hrIds,
      ).catch(() => {}),
    ),
  );
}

export async function notifyMrRecommendationReady(input: {
  candidateId: string;
  candidateName: string;
  recommendationId: string;
  byName: string | null;
  recommendation: "make_offer" | "keep_backup";
}): Promise<void> {
  const recipients = await hrIdsForRoles(recruitmentManageRoles).catch(() => [] as string[]);
  if (recipients.length === 0) return;
  const said = input.recommendation === "make_offer" ? "recommends making an offer" : "recommends keeping as backup";
  await createSystemNotificationForRecipients(
    {
      actionUrl: `${MR_HIRING_PAGE_HREF}?candidate=${encodeURIComponent(input.candidateId)}`,
      channels: [...MR_NOTICE_CHANNELS],
      eventType: MR_RECOMMENDATION_READY_EVENT,
      // The salary never travels in a notice: the notice is read on a lock screen and in Telegram.
      message: `${input.byName ?? "The NSM"} ${said} for ${input.candidateName}, Medical Representative. The final decision is yours.`,
      metadata: { candidateId: input.candidateId, idempotencyKey: `mr-recommendation:${input.recommendationId}` },
      module: "recruitment",
      priority: "high",
      title: `Final decision needed: ${input.candidateName}`,
    },
    recipients,
  ).catch(() => {});
}
