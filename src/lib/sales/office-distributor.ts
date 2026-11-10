import { SalesWorkflowError } from "@/lib/sales/contracts";

/**
 * The Office channel's distributor code — the one marker that tells an allocated Office unit apart
 * from a real distributor sell-out unit.
 *
 * A leaf module on purpose. `office-allocation.ts` owns the allocation and imports
 * `monthly-distributor-import.ts`, so the closing loader cannot import the constant back from there
 * without a cycle. Everything that only needs to ASK "is this row Office?" imports it from here.
 * It stays a leaf: `contracts.ts`, its one import, imports nothing at all.
 */
export const OFFICE_DISTRIBUTOR_CODE = "Office";

/** True when a row's distributor code is the Office channel. Tolerant of case and stray spaces. */
export function isOfficeDistributorCode(value: unknown): boolean {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase() === OFFICE_DISTRIBUTOR_CODE.toUpperCase();
}

/**
 * The first closing whose Office units are respread on READ-TIME shares — owner, 2026-10-09:
 * "fix the Office allocation to read-time shares."
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG. The locked golden rule spreads Office units across the line's areas by each
 * area's share of the line's non-Office sales VALUE (office-allocation.ts). That rule is not in
 * question and is not touched. What was wrong is WHEN it is evaluated: the weights are computed
 * once, at UPLOAD, and stamped onto the stored rows — so every distributor batch that lands, is
 * re-mapped or is corrected AFTER the Office file silently leaves the Office units on last month's
 * geography.
 *
 * MEASURED ON THE LIVE AUGUST 2026 CNS ROWS, 9 October 2026, through the repo's own closing loader
 * and this rule: Office is 109,719 of 178,272 units (61.5% of the month), its last batch landed
 * 10 September 20:15 Cairo and the month was published 10 September 23:22 Cairo — and **6,834 of
 * those packs, 6.23%, worth 548,777 EGP, are today credited to a different area from the one the
 * current data gives them**, over 48 areas with 17 of them short — the sum of the positive legs of
 * today's net over the stored spread, measured through the closing LOADER, after the city-split
 * rails, which is where a reader actually meets the number. `check-office-allocation-drift.ts`
 * (#5679) reports 3,698 units / 3.37% for the same month because it compares the BATCH's own rows
 * with today's shares on the line's own stored total: two measuring points on one defect, both
 * true, neither to be "reconciled" away. Nothing anywhere reported it before those two landed, and
 * the only repair available was to re-upload the Office file by hand.
 *
 * SO THE SPREAD IS RECOMPUTED ON EVERY READ, as a net movement (closing-office-respread.ts) rather
 * than a rewrite of the stored rows — the same shape, and the same reason, as the city split and the
 * EPDA-BULK allocation. A net recomputed on every read cannot go stale.
 *
 * 🔴 SEPTEMBER, NOT AUGUST, AND THAT IS THE POINT. Every earlier month keeps the numbers it was
 * published with — the direction every dated sales rule in this repo takes, and the owner's own
 * standing rule that a published and announced month is never corrected. The 6.23% measured on
 * August is the EVIDENCE for the rule, never a backlog to go and fix.
 *
 * 🔴 SEPTEMBER WAS OCTOBER FOR ONE DAY, AND BOTH ANSWERS ARE HIS OWN. Asked on 9 October 2026 he
 * first ruled **"leave the Office respread at October"**, on two premises read live that afternoon:
 * September CNS held ZERO Office rows because its Office file had not been uploaded, and September
 * was FROZEN for every line because September Anti Infective was published (that freeze was
 * period-wide with no line predicate until 20261110103127; it is per line now) against a net stamped before this
 * rule existed, so a live Office slice over that frozen matrix would have been out by the WHOLE
 * respread rather than by a post-publish drift.
 *
 * BOTH PREMISES THEN INVERTED, the same evening, and neither of them by a session's reading:
 *   · Marcyrl's September Office book landed at 20:10:51 Cairo — 3,920 rows, 80,565 units,
 *     6,971,179.95 EGP — and a customer re-map applied at 21:00:22 left **10,987 of those 80,565
 *     packs (13.64%), across 48 areas,** on a geography the data no longer supports: four times the
 *     August figure that was the evidence for the rule in the first place.
 *   · September Anti Infective was UNPUBLISHED at 19:12:21.58 Cairo (read live from
 *     `monthly_closing_publications`), so no row for `2026-09` has `unpublished_at IS NULL` any
 *     more, `isFrozenStoreSplitPeriod` answers false, and the month recomputes live. There is no
 *     frozen net to rebuild and nothing published to restate.
 *
 * 🔴 PUT TO HIM AGAIN WITH THAT, AND HE RULED: **"make September's Office split recalculate like
 * October"** (2026-10-09). So this constant is `2026-09`, and it does not move again without his own
 * new word — in either direction, and never a session's reading that the data makes it look safe.
 *
 * 🔴 ASKED THE SAME NIGHT ABOUT THE OTHER DIRECTION, HE RULED: **"leave January-June outside the
 * respread window"** (2026-10-09), after 61 Sohag customer moves re-pointed rows in those six
 * months. So it does not widen BACKWARDS either. What stays behind is stored geography and not a
 * reported number: `monthly_closing_publications` holds no row at all before 2026-07, so
 * January-June were never published. Their committed Office spread is drifted — CNS 6,680 of
 * 22,757 units out of place in January (29.36%), 5,794 of 50,121 in February (11.56%) and
 * 190-1,114 units (1.47-2.99%) in each of March to June, measured against production on
 * 2026-10-09 with `scripts/check-office-allocation-drift.ts`. The needs-you drift channel cannot
 * show them because it reads two periods only, which is why the numbers are written down here.
 *
 * 🔴 IF HE RE-PUBLISHES SEPTEMBER, NOTHING HERE NEEDS DOING. The net stamped at that publish is
 * computed by the live path, which now carries the respread, so September freezes WITH it. The
 * hazard in the first ruling is reachable only for a month frozen BEFORE this rule — August and
 * earlier, which this constant excludes.
 */
// 🔴 HIS FOURTH RULING, 2026-10-13, REVERSES THE THIRD: asked whether January–August 2026 should
// recompute their Office split like September and October — after the address remap re-pointed
// 5,459 own-sales rows across every 2026 month — he chose **"Recompute from January 2026"**. Nothing
// was published or locked when he ruled (0 live publication rows, 0 locks), so no announced number
// moved; every month's net is rewritten once after the deploy. It moves again only by his own word.
export const OFFICE_RESPREAD_START_PERIOD = "2026-01";

/**
 * True for `2026-01` and every month after it.
 *
 * A STRING comparison on `YYYY-MM`, which sorts correctly, and a period that is not that shape
 * answers FALSE — the safe direction, because a month this cannot read is a month whose published
 * numbers must not move.
 */
export function isOfficeRespreadActive(period: string | null | undefined): boolean {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return false;
  return trimmed >= OFFICE_RESPREAD_START_PERIOD;
}

/**
 * True when this (line, period) pair takes the read-time respread at all — CNS, from January 2026.
 *
 * The line test is `isOfficeAllocationLine`, the SAME list the upload enforces and the closing
 * displays, deliberately: a second list would drift, and a drift here means respreading a line that
 * may not be allocated Office units in the first place.
 */
export function isOfficeRespreadPair(
  line: string | null | undefined,
  period: string | null | undefined,
): boolean {
  return isOfficeRespreadActive(period) && isOfficeAllocationLine(line);
}

/**
 * True when this ROW is one the respread moves: the Office channel, on an allocated line, in a month
 * the rule covers.
 *
 * 🔴 THE CITY SPLIT DOES NOT HAVE TO ASK THIS, and that is a property of the row rather than a
 * coincidence: Office rows carry no customer (`clientCode` null by construction), so
 * `isStoreCustomer` answers false and `isSplitEligible` refuses them before any period gate is
 * reached — see customersExemptFromCitySplit in store-sales-city-split.ts. So no Office unit can be
 * moved by the city rule and then moved again by this one.
 */
export function isOfficeRespreadRow(
  row: { distributorCode?: string | null; officialLine?: string | null },
  period: string | null | undefined,
): boolean {
  if (!isOfficeRespreadActive(period)) return false;
  if (!isOfficeDistributorCode(row.distributorCode)) return false;
  return isOfficeAllocationLine(row.officialLine);
}

/**
 * The lines that carry an Office channel at all — the owner's rule, 2026-08-25: **CNS only.**
 *
 * Office is not a distributor. It is the company's own stock, imported last and spread across
 * areas by the owner's value-share rule (see office-allocation.ts). Only CNS works that way, and
 * production agrees. Every Office import row ever validated, counted 2026-08-25:
 *
 *   CNS   2026-01 → 2026-07   15,564 rows   219,245 units
 *   Pedia 2026-01 only            84 rows       556 units   150,119.99 EGP
 *
 * Anti Infective and Head Office have never had one. That single Pedia slice is the whole of the
 * non-CNS history, and it is seven months old.
 *
 * So on Pedia, Anti Infective and Head Office the "of wh. Office" columns and the Office
 * Allocation sheet were a wall of zeroes beside every real figure — measured 2026-08-25, the
 * Office grid's grand total for Pedia and Anti Infective 2026-08 is 0.00.
 *
 * DISPLAY ONLY. The Office grid is a lens on the closing, never a source of it: no headline,
 * subtotal or grand total anywhere is computed from it, so hiding the columns cannot move a
 * number. The one visible consequence is that Pedia's 2026-01 Office slice above no longer shows
 * its breakdown — those 556 units and 150,119.99 EGP stay inside Pedia's January sales exactly as
 * before, they just are not broken out any more.
 */
export const OFFICE_CHANNEL_LINES = ["CNS"] as const;

/** True when this line's closing should carry the Office breakdown. See OFFICE_CHANNEL_LINES. */
export function lineHasOfficeChannel(line: string | null | undefined): boolean {
  return officeLineKeys().has(String(line ?? "").trim().toUpperCase());
}

/**
 * True when a line may be ALLOCATED Office units at all — the enforcement half of the same rule.
 *
 * The list above was, until 2026-09-05, a DISPLAY setting and nothing more: it decided whether the
 * closing showed an Office breakdown, while the upload happily accepted a product on any line and
 * the locked value-share rule allocated it. That is how Pedia's 2026-01 slice happened — Lacto
 * Advanced 1 and 2, 556 units, allocated into Pedia's January closing and then hidden by the very
 * setting that was supposed to mean "CNS only". Hiding a number is not the same as refusing it.
 *
 * So the upload now asks THIS question and refuses a workbook carrying a non-CNS product
 * (office-upload.ts). It reads the same list deliberately — two lists would drift, and a drift here
 * means one half allocating what the other half will not show.
 *
 * It changes nothing already stored. Pedia's January units stay exactly where they are; this only
 * stops the next one.
 */
export function isOfficeAllocationLine(line: string | null | undefined): boolean {
  return officeLineKeys().has(String(line ?? "").trim().toUpperCase());
}

/** The line list as a comparison-ready set. One place, so the two questions cannot disagree. */
function officeLineKeys(): Set<string> {
  return new Set(OFFICE_CHANNEL_LINES.map((candidate) => candidate.toUpperCase()));
}

/** One mapped Office product, as much of it as the line rule needs to judge and to report. */
export type OfficeLineCandidate = {
  line: string;
  productCode: string;
  productName: string;
  units: number;
};

/**
 * Refuse an Office workbook carrying a product from a line that may not be allocated Office units.
 *
 * A whole-file refusal, not a quiet drop of the offending rows. A silently shortened Office import
 * is the same class of wrong number as the one this rule exists to stop — the sheet is the thing
 * that needs fixing, and the message names every product so it can be. Fail-closed, matching the
 * unreadable-units and unmapped-name refusals that already sit beside it in office-upload.ts.
 *
 * Pure and DB-free on purpose: the upload path around it needs the product master, the Office name
 * map and the period's contribution base, so a rule left inline there could only ever be pinned by
 * reading the source. Here it can be executed.
 */
export function assertOfficeProductsOnAllowedLine(products: readonly OfficeLineCandidate[]): void {
  const offLine = products.filter((product) => !isOfficeAllocationLine(product.line));
  if (offLine.length === 0) return;
  const sample = offLine
    .slice(0, 5)
    .map((product) => `"${product.productName}" (${product.line.trim() || "no line"}, ${product.units} units)`)
    .join(", ");
  throw new SalesWorkflowError(
    "office_line_not_allowed",
    `The Office channel carries ${OFFICE_CHANNEL_LINES.join(" and ")} only, and this workbook holds `
      + `${offLine.length} product${offLine.length === 1 ? "" : "s"} from another line. Remove `
      + `${offLine.length === 1 ? "it" : "them"} from the sheet and upload again. Found: ${sample}.`,
    400,
    { offLineProducts: offLine },
  );
}
