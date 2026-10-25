// ─────────────────────────────────────────────────────────────────────────────
// The Medical Rep's PERFORMANCE CARD — the keepsake he exports and shares.
//
// Owner, 2026-10-03: "make the rep able to export a snapshot as pic or PDF, very premium
// polished, and make him able to share on LinkedIn or Facebook or WhatsApp — the snapshot
// showing his identity banner, his rank, a chart of his achievements, looks like a mini
// dashboard."
//
// This module answers ONE question — what goes on that card — and nothing about how it is
// drawn. The render lives beside it in `performance-card-render.ts`, the route that serves it
// in `app/api/employee-portals/performance-card/`.
//
// Four things are load-bearing.
//
//   1. IT IS THE SAME NUMBERS THE PORTAL ALREADY SHOWS HIM. The rank comes from
//      `loadRepRankStanding` (the badges on his landing page), the months from
//      `loadEmployeeMonthlyAchievement` (the Achievement-by-month chart), the window from the
//      published closings. A card that recomputed any of it would be a second opinion on a
//      rep's own performance, published to LinkedIn under his name — the worst place in the
//      system for two answers (Rule #1).
//
//   2. 🔒 NO MONEY ON THE CARD. Not the sales value, not the target, not a payslip figure —
//      only PERCENTAGES, the rank, and the counts. The landing keycard shows him "EGP 653,678
//      of EGP 467,633" because that screen is his alone behind a login; this card is built to
//      be posted publicly, and a rep's territory revenue is the company's confidential figure,
//      not his to publish. The percentage IS his achievement and says everything the card is
//      for. (It is also the standing no-payslip-on-a-landing-surface rule carried to its
//      obvious conclusion — see `.claude/rules/portal.md`.)
//
//   3. SELF ONLY. The HR id is the caller's own, resolved from the session by the route or
//      from the SIGNED subject of a share token. Nothing here reads an id off the wire.
//
//   4. NO CARD WITHOUT A PUBLISHED WINDOW. A rep with no published closing has nothing to put
//      on a keepsake, and `null` is the honest answer — the button is then disabled and the
//      route refuses with the reason rather than rendering an empty certificate.
//
//   5. 🔒 HIS PHOTOGRAPH IS ON THE CARD, AND IT IS THE PICTURE THE PORTAL SHOWS (owner, 2026-10-03:
//      "the export picture must show the photo, the name, the title, the identity banner and the
//      rank"). It is resolved by `loadMilestonePhotoBytes` — the ONE place photo resolution lives:
//      uploaded → bundled static → none, exactly the portal's order — and polished by the milestone
//      keepsake's own portrait treatment, so a rep's two keepsakes never show two different faces.
//      Best-effort at every step: no readable photo is the monogram plate, never a failed card.
//      The NAME is the banner's too — `signatureName`, the portal banner's three-part rule.
// ─────────────────────────────────────────────────────────────────────────────

import { windowLabel } from "@/lib/business-review/period-format";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { loadRepRankStanding, type RepRankStanding } from "@/lib/employee-portal/rep-rank";
import { signatureNameFor } from "@/lib/employee-portal/signature-name";
import { polishPortraitDataUri, portraitInitials } from "@/lib/milestones/portrait";
import { loadMilestonePhotoBytes } from "@/lib/milestones/service";
import {
  loadEmployeeMonthlyAchievement,
  publishedPointsOnly,
  summarizeAchievement,
} from "@/lib/sales/employee-achievement";
import { SALES_VS_TARGET_FLOOR, salesVsTargetPeriods } from "@/lib/sales/vs-target";

/** One month on the card's chart. Percent only — see note 2. */
export type PerformanceCardMonth = {
  period: string;
  /** "Jul", "Aug" — the window names its own year once, in the label beneath. */
  label: string;
  achievementPercent: number;
};

export type PerformanceCardData = {
  hrId: string;
  /** Nickname-aware, the name he is known by — the same one the portal greets him with. */
  displayName: string;
  fullName: string;
  /**
   * The name his identity banner signs with: the full name, with a middle name cut to its initial
   * once there are three parts or more — "Hager N. Abdelmaged". The portal banner's own rule —
   * `signatureNameFor`, which pins itself to the design-locked banner's copy.
   */
  signatureName: string;
  /** His portrait, polished, as a data URI — null draws the monogram plate. */
  photoDataUri: string | null;
  /** Two letters for the monogram plate. Never a code (AGENTS.md §4). */
  initials: string;
  jobTitle: string;
  lineName: string | null;
  areaName: string | null;
  /** The window the whole card covers — every published month so far. */
  fromPeriod: string;
  toPeriod: string;
  windowLabel: string;
  /** Cumulative achievement over the window: ALL sales ÷ target (the closing's rule), summed then divided ONCE. */
  achievementPercent: number;
  /** Null when he is outside both bands — the card then carries the figure and the chart alone. */
  standing: RepRankStanding | null;
  months: PerformanceCardMonth[];
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Hyphen- and case-insensitive HR-id key — canonical "B100" and stored "B-100" both match. */
function hrKey(value: string | null | undefined): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The portrait's width in pixels. The card draws it 204px wide at twice the pixels, so 640 is the
 * 408 it needs with room to spare after a platform re-encodes the upload — and a small fraction of
 * the milestone card's 1,750, which is printed on paper.
 */
const PORTRAIT_WIDTH = 640;

/** His photograph, polished, as a data URI — or null for the monogram plate. Never throws. */
async function cardPortrait(hrId: string): Promise<string | null> {
  try {
    const bytes = await loadMilestonePhotoBytes(hrId);
    return bytes ? await polishPortraitDataUri(bytes, { width: PORTRAIT_WIDTH }) : null;
  } catch {
    return null;
  }
}

/**
 * Everything on one rep's card, or null when there is nothing published to put on one.
 *
 * The directory read is the identity half and is NOT caught here: a card that printed the right
 * numbers under a missing name would be worse than no card, and the route turns a throw into the
 * same honest refusal it gives for an empty window.
 */
export async function loadPerformanceCard(hrId: string): Promise<PerformanceCardData | null> {
  const key = hrKey(hrId);
  if (!key) return null;

  const { current } = salesVsTargetPeriods();
  const [window, standing, directoryRows] = await Promise.all([
    loadEmployeeMonthlyAchievement([hrId], SALES_VS_TARGET_FLOOR, current),
    loadRepRankStanding(hrId),
    getEmployeeDirectoryRows(),
  ]);

  // PUBLISHED months only, and only those that can actually be scored — a published month with no
  // target is 0% by arithmetic, not by performance, and drawing it on a keepsake would read as a
  // collapse. Exactly the test the landing chart applies to its own bars.
  const points = publishedPointsOnly(window.byHrId.get(hrId) ?? [])
    .filter((point) => point.targetValue > 0)
    .sort((left, right) => left.period.localeCompare(right.period));
  if (points.length === 0) return null;

  // Summed, then divided ONCE — never an average of the monthly ratios. summarizeAchievement is the
  // one implementation of that rule in the repo and this uses it rather than repeating it.
  const summary = summarizeAchievement(points);
  if (summary.achievementValue == null) return null;

  const person = directoryRows.find((row) => hrKey(row.hrId) === key) ?? null;
  // 🔴 NO NAME, NO CARD. Without his directory row the only thing left to print as his name is the
  // HR id — and a card built to be posted shows a name or nothing (names, never codes). The route
  // answers the throw with its own sentence rather than drawing a code in the banner's script.
  if (!person) throw new Error("This card's employee record could not be read.");
  const fromPeriod = points[0].period;
  const toPeriod = points[points.length - 1].period;
  const fullName = person?.fullName ?? person?.displayName ?? hrId;
  const photoDataUri = await cardPortrait(person?.hrId ?? hrId);

  return {
    hrId: person?.hrId ?? hrId,
    displayName: person?.displayName ?? person?.fullName ?? hrId,
    fullName,
    signatureName: signatureNameFor(fullName),
    photoDataUri,
    initials: portraitInitials(fullName),
    jobTitle: person?.jobTitle ?? "Medical Representative",
    lineName: standing?.line?.lineName ?? person?.lineName ?? null,
    areaName: person?.areaName ?? null,
    fromPeriod,
    toPeriod,
    windowLabel: windowLabel(fromPeriod, toPeriod),
    // ALL sales ÷ target, as the closing and the rank badge printed on this card divide — never
    // the summary's covered ratio, which reads lower for a rep selling an untargeted product.
    achievementPercent: (summary.actualValue / summary.targetValue) * 100,
    standing,
    months: points.map((point) => ({
      period: point.period,
      label: MONTH_NAMES[Number(point.period.slice(5, 7)) - 1] ?? point.period,
      achievementPercent: (point.actualValue / point.targetValue) * 100,
    })),
  };
}
