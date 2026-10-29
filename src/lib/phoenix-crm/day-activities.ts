/**
 * Phoenix CRM — a DAY ACTIVITY: a working day that was not a call.
 *
 * Owner, 2026-09-26, asked for this and ruled two things about it in the same breath:
 *
 *   - it is a **RECORD ONLY**. It changes no call rate, no coverage and no plan-against-actual. A
 *     rep at a training day currently looks like a rep who did nothing, and this is what lets a
 *     manager see the difference — not what excuses the day. Taking a day out of a denominator moves
 *     every rate on every manager's board, including for months already reported, and that is its own
 *     decision to make on its own day.
 *   - **LEAVE IS NOT HERE.** Vacation, excuses and attendance are HR's, with their own approval and
 *     their own evidence. A rep marking "leave" in the CRM would create a second truth that nothing
 *     reconciles, and the one that pays him is the other one.
 *
 * ## Why Phoenix's own vocabulary, and not iReports360's
 *
 * `src/lib/crm/visit-types.ts` decodes the vendor's numeric codes, and the whole reason
 * `isFieldWorkVisit` has to exist over there is that the vendor jammed CALLS and DAY ACTIVITIES into
 * one table: a meeting and a doctor arrive down the same feed and have to be pulled apart again
 * afterwards. Here a visit is always a call and a day activity is its own row, so nothing ever needs
 * pulling apart. These keys are ours; do not map them onto the vendor's numbers.
 *
 * `visit-type-meaning.ts` is the ONE place that says whether a vendor code means a day was worked,
 * for attendance and for pay. Nothing here may grow into a second one.
 */

/**
 * In the order the rep sees them (owner, 2026-09-29): his four first — "meeting, conference, health
 * day, sales day" — then the three that were already here, which he chose to keep. RTD and Group meeting come last (owner,
 * 2026-10-21), for the weekly plan and the recorded day alike. Interviews sits right after Admin work (owner,
 * 2026-10-29) and is a worked day exactly as Admin work is.
 */
export const PHOENIX_CRM_DAY_ACTIVITIES = [
  { key: "meeting", label: "Meeting" },
  { key: "conference", label: "Conference" },
  { key: "health_day", label: "Health day" },
  { key: "sales_day", label: "Sales day" },
  { key: "training", label: "Training" },
  { key: "admin_work", label: "Admin work" },
  { key: "interviews", label: "Interviews" },
  { key: "travel", label: "Travelling" },
  { key: "rtd", label: "RTD" },
  { key: "group_meeting", label: "Group meeting" },
] as const;

export type PhoenixCrmDayActivity = (typeof PHOENIX_CRM_DAY_ACTIVITIES)[number]["key"];

export const DAY_ACTIVITY_NOTE_MAX = 500;

const KEYS = new Set<string>(PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => entry.key));

export function isDayActivity(value: unknown): value is PhoenixCrmDayActivity {
  return typeof value === "string" && KEYS.has(value);
}

export function dayActivityLabel(value: PhoenixCrmDayActivity): string {
  return PHOENIX_CRM_DAY_ACTIVITIES.find((entry) => entry.key === value)?.label ?? value;
}

/** Where a kind sits in the list above — so a day holding several reads them in the order he ticks them from. */
export function dayActivityRank(value: PhoenixCrmDayActivity): number {
  const index = PHOENIX_CRM_DAY_ACTIVITIES.findIndex((entry) => entry.key === value);
  return index < 0 ? PHOENIX_CRM_DAY_ACTIVITIES.length : index;
}

export type DayActivityDraft = {
  activityType: PhoenixCrmDayActivity;
  halfDay: boolean;
  note: string | null;
};

export type DayActivityParse = { ok: true; value: DayActivityDraft } | { ok: false; error: string };

/**
 * One day activity from the wire.
 *
 * Refused rather than coerced when the KIND is unknown: unlike a visit's optional extras, the kind is
 * the whole record, and filing a training day as something else would be worse than refusing it.
 */
export function parseDayActivityDraft(raw: unknown): DayActivityParse {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isDayActivity(body.activityType)) return { ok: false, error: "Choose what the day was." };

  const rawNote = typeof body.note === "string" ? body.note.trim() : "";
  if (rawNote.length > DAY_ACTIVITY_NOTE_MAX) {
    return { ok: false, error: `Keep the note under ${DAY_ACTIVITY_NOTE_MAX} characters.` };
  }

  return { ok: true, value: { activityType: body.activityType, halfDay: body.halfDay === true, note: rawNote || null } };
}
