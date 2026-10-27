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
// the RATE benchmarks (visits/active-day, campaign share) as the primary
// comparison; totals are context only and must be shown with a tenure note.

export const EMPLOYEE_360_BENCHMARKS = {
  // The window the figures below were measured over — NOT the period on screen; every tile that prints one names it.
  windowLabel: "Company avg · 1 Jan to mid-Jul 2026",
  productiveVisits: 685,
  regularVisits: 489,
  campaignVisits: 196,
  // Owner rule, 2026-09-21: 100% regular is the BEST case, and campaign falling while regular rises
  // is the best direction. There is no "healthy band" and no campaign floor — the old 71:29 band
  // called a 91%-regular rep "campaign-starved". Only a campaign MAJORITY is flagged, on the same
  // line the KPIs board's "campaign-heavy" flag uses (kpis-filters.ts).
  campaignHeavyShare: 0.5,
  // A month-to-month change in campaign share under this many points reads as steady.
  campaignTrendDeadband: 0.05,
  visitsPerActiveDay: 7.4,
  activeDays: 92,
  distinctCustomers: 89,
  doublesReceived: 76,
  checkinToVisitRatio: 0.88,
} as const;

// Company check-in time-of-day distribution (share %, Cairo hours 0–23), measured from production
// `ireports360_checkins.check_date` read AS-STORED (the vendor stores a zone-less Cairo wall-clock
// as +00, so the stored clock IS Cairo-local — never re-convert through Africa/Cairo). Used to
// overlay a reference curve on a rep's own histogram. Field work peaks early-afternoon (14:00–16:00).
// Refreshed 2026-07-17 over 2026 YTD (85,095 check-ins).
export const COMPANY_CHECKIN_HOUR_SHARE: readonly number[] = [
  0.2, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 2.6, 5.7, 7.5, 6.4, 8.3, 10.6,
  11.7, 11.2, 8.8, 7.3, 6.7, 5.6, 4.0, 2.1, 0.7,
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
