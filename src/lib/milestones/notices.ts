// Milestones — the reminder that keeps pumping, and the three things that stop it.
//
// The owner asked for a reminder that "keeps pumping whenever there is a new event … when I open it
// and the system confirm I see it, this pumping stops" (2026-09-23). So a daily job re-derives who
// is coming up, and reminds the audience once a day about everything they have not yet acknowledged.
// Opening the milestones page is the acknowledgement — the seen route writes the latch this reads.
//
// ── THE ONE WINDOW ───────────────────────────────────────────────────────────
// `milestoneNoticeWindow()` is the SINGLE definition of the look-ahead, shared by this pump and the
// seen route. If the pump looked further ahead than the page marks seen, opening the page could
// never fully stop it. They must derive the same occasions from the same window, and they do,
// through `listMilestoneNoticeOccasions`.
//
// ── THREE STOPS, IN THE ORDER THEY BITE ──────────────────────────────────────
//   1. Nobody is due          — the re-derive returns zero occasions (the house's own stop-shape).
//   2. A card already exists   — GLOBAL, not per-viewer: once a card is printed for an occasion, the
//                                job stops reminding anyone about it. 🔴 THIS IS ONE EXTRA STOP THE
//                                OWNER DID NOT LITERALLY ASK FOR — he asked for opening the page to
//                                stop it. It is here because a printed card is the whole point of the
//                                reminder, and reminding after the card is made is noise. It is one
//                                clause to remove (drop `printed` from the filter) if he would rather
//                                keep being reminded until he looks.
//   3. This recipient has seen it — the per-viewer latch, his "when I open it".

import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { getEmployeeDirectory, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";

import {
  loadMilestonePrintMarks,
  loadSeenOccurrenceKeys,
  occurrenceKey,
  type MilestoneOccurrence,
} from "./ledger";
import {
  addDays,
  birthdaySpec,
  cardDisplayName,
  daysBetween,
  formatMilestoneSpec,
  formatPlainDateIso,
  formatPlainDateLong,
  milestoneStripLabel,
  milestonesBetween,
  monthDayOf,
  ordinalWord,
  parsePlainDate,
  satoBirthdaysBetween,
  todayInCairo,
  MILESTONE_SWEEP,
  type PlainDate,
} from "./periods";

/** The audience registered in role-recipients.ts and seeded in notification_role_policies. Super
 *  Admin alone today, because the owner narrowed the whole module to Super Admin on 2026-09-23. */
export const MILESTONE_NOTICE_AUDIENCE_KEY = "service_milestone_notice";

/** How far ahead the reminder — and the page's default window, and the seen route — all look. */
export const MILESTONE_NOTICE_WINDOW_DAYS = 30;

/** The look-ahead window: today in Cairo through thirty days on. THE ONE DEFINITION (see header). */
export function milestoneNoticeWindow(from: PlainDate = todayInCairo()): { from: PlainDate; to: PlainDate } {
  return { from, to: addDays(from, MILESTONE_NOTICE_WINDOW_DAYS) };
}

/** One occasion coming up: a service milestone or a birthday at Sato Pharma. */
export type MilestoneNoticeOccasion = {
  subjectHrId: string;
  displayName: string;
  kind: "service" | "birthday";
  /** The short spec form — `1m`, `1y`, `b4` — and half of the occurrence identity. */
  spec: string;
  /** The arithmetic's date: the identity, and what the reminder prints. */
  on: PlainDate;
  /** "First year at Sato Pharma", "fourth birthday at Sato Pharma". */
  label: string;
};

/** The occurrence identity of one occasion — the triple every reader and the pump key on. */
export function occasionOccurrence(occasion: MilestoneNoticeOccasion): MilestoneOccurrence {
  return { subjectHrId: occasion.subjectHrId, periodSpec: occasion.spec, derivedOn: formatPlainDateIso(occasion.on) };
}

/**
 * Every service milestone and every Sato-Pharma birthday due inside the window, earliest first.
 *
 * 🔴 THE SINGLE DERIVATION shared by the pump and the seen route. A leaver is never here — the same
 * `isActiveDirectoryEmployee` predicate the due list and the organogram use. Birthdays ride the same
 * window as service milestones so opening the page marks BOTH, and the reminder about either stops.
 */
export async function listMilestoneNoticeOccasions(
  from: PlainDate,
  to: PlainDate,
): Promise<MilestoneNoticeOccasion[]> {
  const { employees } = await getEmployeeDirectory();
  const occasions: MilestoneNoticeOccasion[] = [];

  for (const employee of employees) {
    if (!isActiveDirectoryEmployee(employee)) continue;
    const hire = parsePlainDate(employee.hireDate);
    if (!hire) continue;
    const displayName = cardDisplayName(employee.fullName, employee.nickname);

    for (const hit of milestonesBetween(hire, from, to, MILESTONE_SWEEP)) {
      occasions.push({
        subjectHrId: employee.hrId,
        displayName,
        kind: "service",
        spec: formatMilestoneSpec(hit.spec),
        on: hit.on,
        label: `${milestoneStripLabel(hit.spec).toLowerCase()} at Sato Pharma`,
      });
    }

    const birthday = monthDayOf(employee.birthDate);
    if (birthday) {
      for (const hit of satoBirthdaysBetween(hire, birthday, from, to)) {
        occasions.push({
          subjectHrId: employee.hrId,
          displayName,
          kind: "birthday",
          spec: birthdaySpec(hit.ordinal),
          on: hit.on,
          label: `${ordinalWord(hit.ordinal)} birthday at Sato Pharma`,
        });
      }
    }
  }

  return occasions.sort(
    (a, b) => formatPlainDateIso(a.on).localeCompare(formatPlainDateIso(b.on)) || a.displayName.localeCompare(b.displayName),
  );
}

/** At most this many occasions are named in one reminder; the rest are counted. A window thirty
 *  days wide over the whole company can surface dozens, and a reminder is a nudge, not a report. */
const MILESTONE_NOTICE_LIST_CAP = 12;

/**
 * The reminder's text. Pure — the part worth pinning. Names, never codes (AGENTS.md §4); the date is
 * printed in full, and for a birthday it is the birthday date, never an age.
 */
export function buildMilestoneNoticeMessage(occasions: readonly MilestoneNoticeOccasion[], today: PlainDate): string {
  const lines: string[] = [];
  const services = occasions.filter((occasion) => occasion.kind === "service").length;
  const birthdays = occasions.length - services;
  const parts: string[] = [];
  if (services > 0) parts.push(`${services} service milestone${services === 1 ? "" : "s"}`);
  if (birthdays > 0) parts.push(`${birthdays} birthday${birthdays === 1 ? "" : "s"}`);
  lines.push(`🎉 Coming up in the next ${MILESTONE_NOTICE_WINDOW_DAYS} days: ${parts.join(" and ")}.`);
  lines.push("");

  for (const occasion of occasions.slice(0, MILESTONE_NOTICE_LIST_CAP)) {
    const away = daysBetween(today, occasion.on);
    const when =
      away < 0 ? "already passed" : away === 0 ? "today" : away === 1 ? "tomorrow" : `in ${away} days`;
    lines.push(`• ${occasion.displayName} — ${occasion.label}, ${formatPlainDateLong(occasion.on)} (${when})`);
  }
  const overflow = occasions.length - MILESTONE_NOTICE_LIST_CAP;
  if (overflow > 0) lines.push(`…and ${overflow} more.`);

  lines.push("");
  lines.push("Print them all in one go → /milestones");
  return lines.join("\n");
}

export type MilestoneNoticeResult = { delivered: number; occasions: number; reason?: string; skipped: boolean };

/**
 * The daily pump. Best-effort — NEVER THROWS; it rides the daily notifications cron and must not
 * turn its own quiet day into that cron's failure.
 *
 * One reminder per recipient per Cairo day, listing everything they have not acknowledged. The
 * idempotency key carries the Cairo calendar day, so the reminder re-sends each day the set is still
 * unacknowledged — that is the "pumping" — and stops the day after the recipient opens the page.
 * Without a dated key, `eventKeyFor` hashes title+recipient+module with no date and the reminder
 * would send exactly once, ever.
 */
export async function runMilestoneDueNotices(options: { from?: PlainDate } = {}): Promise<MilestoneNoticeResult> {
  try {
    const today = options.from ?? todayInCairo();
    const { from, to } = milestoneNoticeWindow(today);
    const all = await listMilestoneNoticeOccasions(from, to);
    if (all.length === 0) return { delivered: 0, occasions: 0, reason: "nobody due", skipped: true };

    // Stop 2 — global. Drop any occasion a card has already been printed for.
    const printed = await loadMilestonePrintMarks(from, to);
    const outstanding = all.filter((occasion) => !printed.has(occurrenceKey(occasionOccurrence(occasion))));
    if (outstanding.length === 0) {
      return { delivered: 0, occasions: 0, reason: "all printed", skipped: true };
    }

    const { recipients } = await resolveNotificationPersonRecipients(
      MILESTONE_NOTICE_AUDIENCE_KEY,
      "Milestone notice recipients",
    );
    if (recipients.length === 0) return { delivered: 0, occasions: outstanding.length, reason: "no recipients", skipped: true };

    const dayKey = formatPlainDateIso(today);
    let delivered = 0;
    for (const recipient of recipients) {
      // Stop 3 — per viewer. What THIS recipient has not yet seen.
      const seen = await loadSeenOccurrenceKeys(recipient.hrId, from, to);
      const unacknowledged = outstanding.filter(
        (occasion) => !seen.has(occurrenceKey(occasionOccurrence(occasion))),
      );
      if (unacknowledged.length === 0) continue;

      await createSystemNotification({
        actionUrl: "/milestones",
        actorId: "milestones-due-cron",
        channels: ["in_app", "telegram", "push"],
        eventType: "milestone_due",
        message: buildMilestoneNoticeMessage(unacknowledged, today),
        metadata: {
          // The Cairo day makes the key repeatable daily; without it the reminder sends once, ever.
          idempotencyKey: `milestone-due:${dayKey}:${recipient.hrId}`,
          occasions: unacknowledged.length,
          window: { from: dayKey, to: formatPlainDateIso(to) },
        },
        // "system", never "milestones": telegram-governance.ts fails CLOSED for an unknown module,
        // and there is no milestones policy row. Same module every system alert in this repo passes.
        module: "system",
        priority: "normal",
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        title: "Milestones coming up",
      });
      delivered += 1;
    }

    return { delivered, occasions: outstanding.length, skipped: false };
  } catch (error) {
    return { delivered: 0, occasions: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
