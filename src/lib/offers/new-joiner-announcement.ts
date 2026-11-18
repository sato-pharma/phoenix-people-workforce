/**
 * New joiner announcement — the email the Head Office team receives when a new hire accepts the
 * job offer (owner, 18 Nov 2026: "when a new hire accepts the job offer send email to all the head
 * office employees with his details, hiring date, area, line").
 *
 * WHEN. Submitting the joining form IS the acceptance (recruitment-offers rule), and it is also the
 * moment the employee record exists with its line, area and hiring date — so it fires from the end
 * of `submitJoiningForm`, after the hand-off, past the response (`afterResponse`). Once per offer
 * (the idempotency key is the offer id). An offer HR marks "Accepted" by hand does NOT fire it: that
 * door is used for someone already on the Employee Master answering by reply, who is not a new hire.
 *
 * WHO. Every ACTIVE Head Office employee with a work email — the employee master's Head Office line
 * (`isHeadOfficeRow`, the one definition, CEO included) plus the marketers whose manager chain
 * reaches it (the Product Managers filed on a product line who report to the Marketing Manager —
 * the same rule the organogram's Head Office branch uses). The new hire is never sent their own
 * announcement. Measured on production 18 Nov 2026: 15 on the line + 2 marketers = 17 people.
 * Above NEW_JOINER_MAX_RECIPIENTS the send is REFUSED and logged — a definition that suddenly
 * reaches the field force must never email the company.
 *
 * HOW. One email in the Sato house template (`renderSatoEmail`), the addresses in BCC behind the
 * neutral To (`fanoutToBcc`) so a "welcome!" never turns into a reply-all storm, through
 * `sendPhoenixEmail` — the Confidence Gate (its ceiling for this pair is in CEILING_OVERRIDES) and the
 * admin Telegram mirror still apply. No test send is ever fired by code.
 *
 * NOTHING HERE THROWS INTO ITS CALLER: the record is already made and the candidate already answered.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { escapeHtml, formatLongDateEn } from "@/lib/hiring-pack/render-shared";
import { renderSatoEmail } from "@/lib/sato-email/render";
import type { OfferRecord } from "@/lib/offers/types";

export const NEW_JOINER_MODULE = "offers" as const;
export const NEW_JOINER_EVENT_TYPE = "new_joiner_announcement" as const;
/** The refusal line: ~17 people today; anything near the whole company is a broken definition. */
export const NEW_JOINER_MAX_RECIPIENTS = 40;

/** The directory fields this module reads — a narrow slice of EmployeeDirectoryRow. */
export type NewJoinerDirectoryRow = {
  areaName: string | null;
  displayName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  workEmail: string | null;
};

/**
 * A title on the sales force. Every Head Office marketer's chain stops at the Marketing Manager, but
 * should a manager pointer ever run from Head Office down into the field, these are never pulled in.
 */
const FIELD_TITLE = /medical rep|district manager|regional (sales )?manager|national sales manager|area manager|\bdsm\b|\brsm\b|\bnsm\b/i;
const CEO_TITLE = /^\s*(ceo|chief executive)/i;

/**
 * Head Office as the organogram draws it, from ACTIVE rows only: the Head Office line, then anyone
 * not on it whose manager chain reaches a Head Office member other than the CEO (the CEO is the root
 * of the whole company, so reporting to him alone would pull the National Sales Managers in).
 * Returns the people, the new hire excluded. PURE.
 */
export function pickHeadOfficeAudience(
  activeRows: readonly NewJoinerDirectoryRow[],
  options: { isHeadOffice: (row: NewJoinerDirectoryRow) => boolean; newHireHrId: string },
): NewJoinerDirectoryRow[] {
  const keyOf = (hrId: string | null | undefined) => canonicalHrIdKey(hrId) ?? "";
  const members = new Map<string, NewJoinerDirectoryRow>();
  const chainSeeds = new Set<string>();
  for (const row of activeRows) {
    const key = keyOf(row.hrId);
    if (!key || !options.isHeadOffice(row)) continue;
    members.set(key, row);
    if (!CEO_TITLE.test(row.jobTitle ?? "")) chainSeeds.add(key);
  }
  // Repeated passes, because a chain can be several deep (Product Manager → Group Product Manager →
  // Marketing Manager). Each pass only adds, so it ends within activeRows.length passes even when
  // manager_hr_id holds a cycle.
  for (let pass = 0; pass < activeRows.length; pass += 1) {
    let added = false;
    for (const row of activeRows) {
      const key = keyOf(row.hrId);
      if (!key || members.has(key) || FIELD_TITLE.test(row.jobTitle ?? "")) continue;
      if (chainSeeds.has(keyOf(row.managerHrId))) {
        members.set(key, row);
        chainSeeds.add(key);
        added = true;
      }
    }
    if (!added) break;
  }
  const newHire = keyOf(options.newHireHrId);
  return Array.from(members.entries())
    .filter(([key]) => key !== newHire)
    .map(([, row]) => row);
}

function stated(value: string | null | undefined, fallback: string): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : fallback;
}

export type NewJoinerDetails = {
  area: string;
  hiringDate: string;
  jobTitle: string;
  line: string;
  name: string;
  reportsTo: string;
};

/**
 * What the email says about the new joiner: the employee record first (it is what was written), the
 * offer where the record is silent. A Head Office joiner has no area, so the area reads Head Office.
 */
export function newJoinerDetails(
  hire: NewJoinerDirectoryRow,
  offer: Pick<OfferRecord, "candidateName" | "startDate" | "territory" | "title">,
  isHeadOffice: boolean,
): NewJoinerDetails {
  const hireIso = stated(hire.hireDate, "") || stated(offer.startDate, "");
  return {
    area: stated(hire.areaName, "") || stated(offer.territory, "") || (isHeadOffice ? "Head Office" : "To be confirmed"),
    hiringDate: formatLongDateEn(hireIso) || stated(hireIso, "To be confirmed"),
    jobTitle: stated(hire.jobTitle, "") || stated(offer.title, "To be confirmed"),
    line: stated(hire.lineName, isHeadOffice ? "Head Office" : "To be confirmed"),
    name: stated(hire.displayName, "") || stated(offer.candidateName, "Our new colleague"),
    reportsTo: stated(hire.managerName, "To be confirmed"),
  };
}

/** The announcement as a Sato house letter. PURE. */
export function renderNewJoinerAnnouncement(details: NewJoinerDetails): { html: string; subject: string; text: string } {
  const subject = `Welcome to Sato Pharma — ${details.name}, ${details.jobTitle}`;
  const rows: Array<[string, string]> = [
    ["Name", details.name],
    ["Position", details.jobTitle],
    ["Line", details.line],
    ["Area", details.area],
    ["Hiring date", details.hiringDate],
    ["Reports to", details.reportsTo],
  ];
  const table =
    "<table><tbody>" +
    rows.map(([label, value]) => `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value)}</td></tr>`).join("") +
    "</tbody></table>";
  const rendered = renderSatoEmail({
    bodyHtml:
      "<p>Dear colleagues,</p>" +
      `<p>Please join us in welcoming <strong>${escapeHtml(details.name)}</strong>, who has accepted our offer ` +
      `and joins Sato Pharma as <strong>${escapeHtml(details.jobTitle)}</strong>.</p>` +
      table +
      "<p>Please make our new colleague feel welcome. We wish them every success in the new role.</p>",
    footnote: "Sent automatically to the Head Office team when a new joiner accepts their job offer.",
    kicker: "New joiner",
    signOff: "Human Resources",
    subject,
  });
  return { html: rendered.html, subject, text: rendered.text };
}

export type NewJoinerAnnounceResult = {
  reason?: string;
  recipients: number;
  sent: boolean;
};

/**
 * Read the new record and the Head Office team, and send the announcement once per offer. Swallows
 * every failure and logs it; never throws. The heavy modules load lazily so the pure half above can
 * be unit-tested without a database.
 */
export async function announceNewJoinerToHeadOffice(input: {
  hrId: string;
  offer: OfferRecord;
}): Promise<NewJoinerAnnounceResult> {
  const { logError, logInfo } = await import("@/lib/observability/log");
  const offerId = String(input.offer?.id ?? "").trim();
  const skip = (reason: string): NewJoinerAnnounceResult => {
    logInfo("New joiner announcement not sent", {
      context: { hrId: input.hrId, offerId, reason },
      labels: { event: "new_joiner_announcement_skipped" },
    });
    return { reason, recipients: 0, sent: false };
  };
  try {
    if (!offerId) return skip("the offer carried no id");
    const [{ emailNotificationsEnabled }, directory, { isHeadOfficeRow }, { pickDeliverableEmail }, { sendPhoenixEmail }, { systemEmail }, { satoEmailFrom }] =
      await Promise.all([
        import("@/lib/notifications/email"),
        import("@/lib/employees/employee-directory"),
        import("@/lib/reports/organogram"),
        import("@/lib/email/email-safety"),
        import("@/lib/email/send-phoenix-email"),
        import("@/config/system-settings"),
        import("@/lib/sato-email/service"),
      ]);
    if (!emailNotificationsEnabled()) return skip("email notifications are switched off on this runtime");

    const everyone = await directory.getEmployeeDirectoryRows({ includeInactive: true });
    const newHireKey = canonicalHrIdKey(input.hrId);
    const hire = everyone.find((row) => canonicalHrIdKey(row.hrId) === newHireKey);
    if (!hire) return skip("the new employee record could not be read back");

    const isHeadOffice = (row: NewJoinerDirectoryRow) => isHeadOfficeRow({ lineId: row.lineId, lineName: row.lineName });
    const active = everyone.filter((row) => directory.isActiveLifecycleStatus(row.employmentStatus));
    const audience = pickHeadOfficeAudience(active, { isHeadOffice, newHireHrId: input.hrId });
    const to = Array.from(
      new Set(
        audience
          .map((row) => pickDeliverableEmail(row.workEmail)?.toLowerCase() ?? "")
          .filter((address) => address.length > 0),
      ),
    );
    if (to.length === 0) return skip("no Head Office employee has a deliverable work email");
    if (to.length > NEW_JOINER_MAX_RECIPIENTS) {
      logError("New joiner announcement refused: the Head Office audience is far larger than Head Office", {
        error: new Error(`${to.length} recipients resolved, limit ${NEW_JOINER_MAX_RECIPIENTS}`),
        labels: { event: "new_joiner_announcement_audience_too_large" },
      });
      return { reason: "audience too large", recipients: to.length, sent: false };
    }

    const { html, subject, text } = renderNewJoinerAnnouncement(newJoinerDetails(hire, input.offer, isHeadOffice(hire)));
    const result = await sendPhoenixEmail({
      // BCC behind the neutral visible To, so nobody's "welcome" goes to seventeen people.
      fanoutToBcc: true,
      from: satoEmailFrom(systemEmail.satoComposerFromEmail),
      html,
      idempotencyKey: `${NEW_JOINER_EVENT_TYPE}:${offerId}`,
      notificationType: NEW_JOINER_EVENT_TYPE,
      origin: {
        employeeHrId: hire.hrId,
        eventType: NEW_JOINER_EVENT_TYPE,
        module: NEW_JOINER_MODULE,
      },
      replyTo: systemEmail.satoComposerReplyToEmail,
      subject,
      text,
      to,
    });
    if (result.skipped) return skip(result.reason);
    logInfo("New joiner announced to Head Office", {
      context: { hrId: hire.hrId, offerId, recipients: to.length },
      labels: { event: "new_joiner_announcement_sent" },
    });
    return { recipients: to.length, sent: true };
  } catch (error) {
    logError("New joiner announcement failed", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "new_joiner_announcement_failed" },
    });
    return { reason: error instanceof Error ? error.message : String(error), recipients: 0, sent: false };
  }
}
