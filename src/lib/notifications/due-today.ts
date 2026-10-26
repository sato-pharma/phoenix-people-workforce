import { todayInCairo } from "@/lib/date-only";

/**
 * A notice is due on its `scheduled_for` day (Cairo), never before. The probation sweep writes every
 * reminder of a probation ahead of time — Day 30 on the hire day, Day 60 and the decision weeks later —
 * so with no date fence a manager's bell said "feedback is due" on the day a rep was hired, two months
 * early (Rasha's bell, 2026-10-24: a Dec 01 reminder for a rep hired Nov 01). `scheduled_for` is a
 * NOT NULL `date`, so the SQL fence is a plain `lte`; this is the same test, after the query.
 */
export function noticeIsDue(row: { scheduled_for?: string | null }, today: string = todayInCairo()): boolean {
  const day = typeof row.scheduled_for === "string" ? row.scheduled_for.slice(0, 10) : "";
  return day === "" || day <= today;
}
