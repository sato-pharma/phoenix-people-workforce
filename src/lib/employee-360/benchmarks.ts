// Company field benchmarks for the Employee 360 module.
//
// These are the live company averages measured directly from production
// `ireports360_visits` / `ireports360_checkins` for the 2026 year-to-date
// window (Jan 1 – mid Jul 2026, per productive agent). They are intentionally
// kept as plain constants for v1 so a profile can compare a person to the field
// without a second heavy query. Refresh them when the reference window changes.
//
// IMPORTANT (fairness): totals (685 visits, 92 active days, 89 customers) are
// full-window absolutes and are unfair to part-period / new-hire reps. Prefer
// the RATE benchmarks (visits/active-day, regular:campaign share) as the primary
// comparison; totals are context only and must be shown with a tenure note.

export const EMPLOYEE_360_BENCHMARKS = {
  windowLabel: "Company avg · 2026 YTD",
  productiveVisits: 685,
  regularVisits: 489,
  campaignVisits: 196,
  // Healthy campaign share band, anchored on the 71:29 annual blend.
  regularShare: 0.71,
  campaignShare: 0.29,
  campaignShareLow: 0.15, // below → "campaign-starved"
  campaignShareHigh: 0.45, // above → "regular-neglect"
  visitsPerActiveDay: 7.4,
  activeDays: 92,
  distinctCustomers: 89,
  doublesReceived: 76,
  checkinToVisitRatio: 0.88,
} as const;

// Company check-in time-of-day distribution (share %, Cairo hours 0–23),
// measured from production `ireports360_checkins.check_date`. Used to overlay a
// reference curve on a rep's own histogram. Field work is afternoon/evening.
export const COMPANY_CHECKIN_HOUR_SHARE: readonly number[] = [
  2.9, 1.2, 0.3, 0.2, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.3, 4.5, 7.3, 7.0,
  7.1, 9.4, 11.3, 11.4, 9.9, 8.2, 6.9, 6.7, 5.2,
];

// Company campaign share by month (%), for the campaign-vs-regular trend
// overlay. Campaign is seasonal — high in Feb/Mar, ~25% Apr onward — so a rep is
// compared to the SAME month, never a flat annual line.
export const COMPANY_CAMPAIGN_SHARE_BY_MONTH: Readonly<Record<string, number>> = {
  "2026-01": 28.0,
  "2026-02": 39.6,
  "2026-03": 38.9,
  "2026-04": 25.7,
  "2026-05": 25.0,
  "2026-06": 25.1,
  "2026-07": 19.5,
};

// Late-night check-in window (Cairo hours) used for the authenticity tail signal.
export const LATE_NIGHT_HOURS: readonly number[] = [22, 23, 0, 1];
