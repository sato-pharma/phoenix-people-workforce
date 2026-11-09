// ─────────────────────────────────────────────────────────────────────────────
// The Regional Sales Manager's home, told in words — the premium pass of 9 November 2026.
//
// Pure: no database, no clock, no React. `rm-command-center.tsx` and the shared parts it mounts
// (the ranking boards, the sales pacing panel, the pending actions) print what this file decides.
// Account: docs/rsm-home.md. Pinned by tests/rsm-home-premium.test.ts.
//
// What it fixes, each one a defect read off the page before this pass:
//  - A percentage is never rounded UP across a line. 89.6% printed "90%" in My Districts while the
//    same district sat under Districts Needing Attention and the Gap to 90% tile asked for more sales.
//  - "Needs your decision" listed the viewer's OWN vacation and excuse requests, which wait on
//    somebody else. Only the plans awaiting the viewer's approval are a decision; the viewer's own
//    requests are listed apart and open the viewer's own request pages.
//  - The sales pacing panel printed a percent change as "pts", never named its month, counted the
//    published months as a figure, and drew bars with no month and no number under them.
// ─────────────────────────────────────────────────────────────────────────────

/** The incentive line every manager board measures against (the Gap to 90% tile, Districts Needing Attention). */
export const INCENTIVE_LINE_PERCENT = 90;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * A whole percentage that never rounds UP across a line: 89.6 reads 89, 99.7 reads 99. A board that
 * printed 90% beside a gap to 90% contradicted itself. Negative and missing values read 0.
 */
export function wholePercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  // The small nudge keeps 0.29 * 100 (28.999…) from reading 28.
  return Math.floor(value + 1e-9);
}

/** Achievement of a sales figure against a target, or null when no target is loaded. */
export function achievementOf(sales: number, target: number | null | undefined): number | null {
  if (target == null || !(target > 0)) return null;
  return wholePercent((sales / target) * 100);
}

/** The house compact money form, e.g. "1.23 M EGP" or "950 EGP". */
export function compactEgp(value: number): string {
  const abs = Math.abs(value);
  const unit =
    abs >= 1_000_000_000
      ? { div: 1_000_000_000, suffix: "B" }
      : abs >= 1_000_000
        ? { div: 1_000_000, suffix: "M" }
        : abs >= 1_000
          ? { div: 1_000, suffix: "K" }
          : null;
  if (!unit) return `${Math.round(value).toLocaleString("en-US")} EGP`;
  const scaled = (value / unit.div).toFixed(2).replace(/\.?0+$/, "");
  return `${scaled} ${unit.suffix} EGP`;
}

/** "2026-09" → "Sep 2026"; anything else is returned as it came, never guessed. */
export function monthLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(period);
  if (!match) return period;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return period;
  return `${MONTHS[month - 1]} ${match[1]}`;
}

/** The colour band of an achievement, the one the ranking boards and the keycards share. */
export type AchievementBand = "met" | "near" | "behind" | "far";

export function achievementBand(percent: number): AchievementBand {
  if (percent >= 100) return "met";
  if (percent >= INCENTIVE_LINE_PERCENT) return "near";
  if (percent >= 70) return "behind";
  return "far";
}

/* ── Region Performance: the Gap to 90% tile ───────────────────────────── */

export type IncentiveGap =
  | { state: "no-target"; sub: string }
  | { state: "cleared"; sub: string }
  | { state: "short"; gap: number; sub: string };

/**
 * Where a region stands against the 90% incentive line. Measured on the money itself (sales against
 * 90% of the target), never on a rounded percentage, so the tile and the districts list agree.
 */
export function incentiveGap(sales: number, target: number): IncentiveGap {
  if (!(target > 0)) return { state: "no-target", sub: "no region target loaded" };
  const line = (target * INCENTIVE_LINE_PERCENT) / 100;
  if (sales >= line) return { state: "cleared", sub: "90% incentive line cleared" };
  return { state: "short", gap: line - sales, sub: "sales still needed to reach 90%" };
}

/** Under the Region Performance tiles: the 90% line is shown, and it is not HR's confirmed figure yet. */
export const INCENTIVE_NOT_CONFIRMED_NOTE = "The 90% incentive line above is not yet confirmed by HR.";

/** When the region's figures could not be read at all. Never "synced", never a zero. */
export const REGION_FIGURES_UNAVAILABLE =
  "Your region's figures are not available right now. Reload the page in a minute; if this stays, your seat may have no region set.";

/* ── Districts Needing Attention ──────────────────────────────────────── */

export type DistrictRow = {
  hrId: string;
  name: string;
  achievementPercent: number;
  totalSales: number;
  totalTarget: number;
};

export type DistrictAttentionRow = {
  key: string;
  name: string;
  percent: number;
  band: AchievementBand;
  /** "412.5 K EGP of 520 K EGP" */
  salesText: string;
  /** "55.5 K EGP to 90%" */
  gapText: string;
  gap: number;
};

export type DistrictsAttention =
  | { state: "hidden" }
  | { state: "all-clear"; text: string }
  | { state: "list"; behind: DistrictAttentionRow[]; unmeasuredText: string | null };

/**
 * The districts below the 90% line, the largest gap in percentage first. A district with no target
 * is not behind, it is unmeasurable, and is named apart so a data gap never reads as a performance
 * problem nor hides under the all-clear. Nothing is listed while no closing is published.
 */
export function districtsNeedingAttention(
  districts: readonly DistrictRow[],
  windowLabel: string | null | undefined,
): DistrictsAttention {
  if (!windowLabel || !windowLabel.trim() || districts.length === 0) return { state: "hidden" };
  const behind: DistrictAttentionRow[] = [];
  const unmeasured: string[] = [];
  for (const district of districts) {
    if (!(district.totalTarget > 0)) {
      unmeasured.push(district.name);
      continue;
    }
    const gap = incentiveGap(district.totalSales, district.totalTarget);
    if (gap.state !== "short") continue;
    const percent = achievementOf(district.totalSales, district.totalTarget) ?? 0;
    behind.push({
      key: district.hrId || district.name,
      name: district.name,
      percent,
      band: achievementBand(percent),
      salesText: `${compactEgp(district.totalSales)} of ${compactEgp(district.totalTarget)}`,
      gapText: `${compactEgp(gap.gap)} to 90%`,
      gap: gap.gap,
    });
  }
  behind.sort((a, b) => a.percent - b.percent || b.gap - a.gap || a.name.localeCompare(b.name));
  if (behind.length === 0 && unmeasured.length === 0) {
    return { state: "all-clear", text: "Every district in your region is at or above 90%." };
  }
  const unmeasuredText =
    unmeasured.length === 0
      ? null
      : unmeasured.length === 1
        ? `1 district has no target loaded for ${windowLabel}, so its achievement cannot be measured:`
        : `${unmeasured.length} districts have no target loaded for ${windowLabel}, so their achievement cannot be measured:`;
  return { state: "list", behind, unmeasuredText: unmeasuredText ? `${unmeasuredText} ${unmeasured.join(", ")}.` : null };
}

/* ── The ranking boards' empty state ──────────────────────────────────── */

/** What an empty ranking board says: the closing it read, or that none is published. Never "synced". */
export function rankingBoardEmptyText(windowLabel: string | null | undefined): string {
  return windowLabel && windowLabel.trim()
    ? `Nobody on this board has a row in the ${windowLabel} closing.`
    : "No Monthly Closing is published for this board yet.";
}

/* ── Sales pacing (the published closing, month by month) ─────────────── */

export type PacingPoint = { period: string; salesValue: number; targetValue: number | null };

export type PacingMonth = {
  period: string;
  /** "Sep 2026" */
  label: string;
  /** "Sep" */
  shortLabel: string;
  sales: number;
  salesText: string;
  target: number | null;
  achievement: number | null;
  band: AchievementBand | null;
  /** "84% of target" or "No target loaded" */
  achievementText: string;
  /** The bar's height, 6 to 100, against the highest month shown. */
  barHeight: number;
  latest: boolean;
};

export type SalesPacing =
  | { state: "empty" }
  | {
      state: "ready";
      months: PacingMonth[];
      latest: PacingMonth;
      /** "Sep 2026 sales" */
      headline: string;
      /** "of 5.2 M EGP target · 84%" or "No target loaded for Sep 2026" */
      targetText: string;
      change: { direction: "up" | "down" | "level"; percent: number; text: string } | null;
      /** Why there is no change line, when there is none. */
      changeNote: string | null;
    };

/**
 * The published months, oldest first, told as a pacing panel. The change is a PERCENT of the month
 * before, named — "Up 12% on Aug 2026" — never "pts", which is the unit of a difference between two
 * percentages and is not what this is.
 */
export function salesPacing(points: readonly PacingPoint[]): SalesPacing {
  const ordered = points
    .filter((point) => /^\d{4}-\d{2}/.test(point.period))
    .slice()
    .sort((a, b) => a.period.localeCompare(b.period));
  if (ordered.length === 0) return { state: "empty" };
  const highest = Math.max(...ordered.map((point) => point.salesValue), 0);
  const months: PacingMonth[] = ordered.map((point, index) => {
    const achievement = achievementOf(point.salesValue, point.targetValue);
    const label = monthLabel(point.period);
    return {
      period: point.period,
      label,
      shortLabel: label.slice(0, 3),
      sales: point.salesValue,
      salesText: compactEgp(point.salesValue),
      target: point.targetValue != null && point.targetValue > 0 ? point.targetValue : null,
      achievement,
      band: achievement == null ? null : achievementBand(achievement),
      achievementText: achievement == null ? "No target loaded" : `${achievement}% of target`,
      barHeight: highest > 0 ? Math.max(6, Math.round((Math.max(0, point.salesValue) / highest) * 100)) : 6,
      latest: index === ordered.length - 1,
    };
  });
  const latest = months[months.length - 1];
  const previous = months.length >= 2 ? months[months.length - 2] : null;
  let change: { direction: "up" | "down" | "level"; percent: number; text: string } | null = null;
  let changeNote: string | null = null;
  if (!previous) {
    changeNote = "The first published month, so there is nothing before it to compare.";
  } else if (!(previous.sales > 0)) {
    changeNote = `No sales in ${previous.label} to compare against.`;
  } else {
    const percent = Math.round(((latest.sales - previous.sales) / previous.sales) * 100);
    const direction = percent > 0 ? "up" : percent < 0 ? "down" : "level";
    const text =
      direction === "level"
        ? `Level with ${previous.label}`
        : `${direction === "up" ? "Up" : "Down"} ${Math.abs(percent)}% on ${previous.label}`;
    change = { direction, percent, text };
  }
  return {
    state: "ready",
    months,
    latest,
    headline: `${latest.label} sales`,
    targetText:
      latest.target == null
        ? `No target loaded for ${latest.label}`
        : `of ${compactEgp(latest.target)} target · ${latest.achievement ?? 0}%`,
    change,
    changeNote,
  };
}

/* ── Pending items: what waits on the viewer, and what the viewer waits on ── */

export type PendingLink = { key: string; text: string; href: string };

export const OWN_VACATION_HREF = "/employee-portals/vacation-request";
export const OWN_EXCUSE_HREF = "/employee-portals/excuses";

/**
 * Splits the landing page's pending counts into the two things they are. `plansAwaitingApproval`
 * waits on the VIEWER. The vacation and excuse counts are the viewer's OWN requests
 * (`employee_hr_id` is the viewer, see home-snapshot.ts) and wait on the viewer's manager or HR,
 * so they are never "your decision".
 */
export function pendingItems(input: {
  plansAwaitingApproval: number;
  ownVacationRequests: number;
  ownExcuseRequests: number;
}): { decisions: PendingLink[]; own: PendingLink[] } {
  const decisions: PendingLink[] = [];
  const own: PendingLink[] = [];
  const plans = Math.max(0, Math.trunc(input.plansAwaitingApproval));
  const vacations = Math.max(0, Math.trunc(input.ownVacationRequests));
  const excuses = Math.max(0, Math.trunc(input.ownExcuseRequests));
  if (plans > 0) {
    decisions.push({
      key: "plans",
      text: plans === 1 ? "1 plan is awaiting your approval" : `${plans} plans are awaiting your approval`,
      href: "/employee-portals/approvals-hub?module=weekly_plan",
    });
  }
  if (vacations > 0) {
    own.push({
      key: "vacation",
      text:
        vacations === 1
          ? "Your vacation request is awaiting approval"
          : `${vacations} of your vacation requests are awaiting approval`,
      href: OWN_VACATION_HREF,
    });
  }
  if (excuses > 0) {
    own.push({
      key: "excuse",
      text:
        excuses === 1 ? "Your excuse request is awaiting approval" : `${excuses} of your excuse requests are awaiting approval`,
      href: OWN_EXCUSE_HREF,
    });
  }
  return { decisions, own };
}

/** Where the "my requests awaiting approval" glance tile opens: the page that holds them. */
export function ownRequestsHref(ownVacationRequests: number, ownExcuseRequests: number): string {
  return ownVacationRequests <= 0 && ownExcuseRequests > 0 ? OWN_EXCUSE_HREF : OWN_VACATION_HREF;
}

/** The glance tile's label beside the count of the viewer's own requests. */
export function ownRequestsLabel(count: number | null): string {
  return count === 1 ? "my request awaiting approval" : "my requests awaiting approval";
}
