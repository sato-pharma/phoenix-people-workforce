// ─────────────────────────────────────────────────────────────────────────────
// WHERE A PERSON SITS IN THE ORGANOGRAM — every tier, not just reps.
//
// PURE. No database import, so the whole resolution below is testable without
// one; `org-placement-data.ts` next door does the single read.
//
// WHY THIS EXISTS AT ALL, stated plainly because it was got wrong once and the
// wrong version reached a PR: the first build of the Reps Plans geography filter
// resolved a person's line and region from `au_v_line_area_map.rep_seat_id`.
// That column holds REP seats and nothing else. So every District Manager,
// Acting DM, RSM and NSM on the board fell through it and got rendered as
// holding NO SEAT — 22 real managers, each of them seated, told they were not.
// The owner caught it immediately, because he knows who his managers are.
//
// The organogram is `au_v_org_tree`: one row per seat, every tier, carrying the
// occupant and — for the tiers that have one — a line and a region. That view is
// the source of truth here, and this module is the only place that reads it.
//
// ── The one rule that is not obvious ────────────────────────────────────────
// A seat ABOVE the area layer carries no line/region of its own. An NSM's node
// is blank, an RSM's node is blank, and the CEO's node is blank. They are not
// unplaced — their territory is simply everything BENEATH them. So a seat with
// no line/region of its own resolves to the union of its descendants' cells:
//
//   REP / DM / ACTING_DM   its own cell                  -> exactly 1
//   RSM                    one line, its regions         -> 3 in production
//   NSM                    one line, all its regions     -> 7-8 in production
//   CEO                    everything                    -> 22 in production
//
// Measured against production 2026-08-28: 133 seats, 91 of them occupied by 90
// people, and all 91 resolve — none left over. That last number is the point: a
// resolution that leaves a tier behind is the bug this module exists to end.
//
// ── And 91 seats to 90 people is not a typo ─────────────────────────────────
// One person holds TWO seats — an ACTING_DM seat and the REP seat beneath it,
// both on the same line and region. That is deliberate and the owner has ruled
// on it: an acting DM's authority is her app role, not her job title, and she
// STAYS a medical rep. So when a person occupies several seats the REP one wins
// for scoring — her call rate is still her own job. See {@link isScoredTier}.
// ─────────────────────────────────────────────────────────────────────────────

/** One (line, region) a person covers. The pair is kept TOGETHER, never as two loose fields. */
export type OrgCell = {
  lineCode: string;
  lineName: string;
  regionCode: string;
  regionName: string;
};

/** One row of `au_v_org_tree`, already trimmed of nulls the caller cannot use. */
export type OrgTreeNode = {
  seatId: string;
  /**
   * Ancestor seat ids, root first, from `au_v_org_tree.path`.
   *
   * INCLUDES the seat itself as its last element — verified against production, where
   * `SEAT-AIF-ADM-UE-1` carries `[SEAT-ROOT-CEO, SEAT-AIF-NSM, SEAT-AIF-ADM-UE-1]`. Harmless for
   * the descendant walk below (a seat with its own cell never consults it, and a seat without one
   * contributes nothing to itself), but worth stating: reading it as ancestors-only is how someone
   * later "fixes" a bug that is not there.
   */
  path: string[];
  seatTier: string;
  occupantHrId: string | null;
  lineCode: string | null;
  lineName: string | null;
  regionCode: string | null;
  regionName: string | null;
};

export type OrgPlacement = {
  /** Raw tier from the view — "REP", "DM", "ACTING_DM", "RSM", "NSM", "CEO". */
  tier: string;
  /** Human-readable, never the raw code (owner's standing rule). */
  tierLabel: string;
  /** Whether the 2 AM / 10 PM call-rate target applies to this person. See {@link isScoredTier}. */
  scored: boolean;
  cells: OrgCell[];
};

/** Lowercased, trimmed HR id -> where that person sits. Absent means no seat in the organogram. */
export type OrgPlacementIndex = Map<string, OrgPlacement>;

/**
 * The HR-id form everything here matches on.
 *
 * Lowercased on BOTH sides deliberately: `activity_events.hr_id` and the direct-order tables carry
 * mixed case in production, and an `.eq` against one casing has silently hidden a quarter of a
 * board's rows before. Bare — this is not a `hr:`-prefixed board key.
 */
export const orgHrKey = (hrId: string | null | undefined): string | null => {
  const trimmed = (hrId ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * THE OWNER'S RULE, 2026-08-28: "the KPI is two AM, ten PM, for medical reps. Don't restrict the
 * managers on AM and PM coverage. Make their account appear, but not restrict them on any of this."
 *
 * So a manager is LISTED with his line and region and his real activity, and is scored on nothing.
 * Only a REP seat carries the target.
 *
 * Written as a check against one value rather than a `Record` over the tier union on purpose: an
 * exhaustive `Record` does not gate the build here (`ignoreBuildErrors`), so a seventh tier added
 * to the view would compile, deploy, and silently return `undefined` — which is how a whole board
 * once sorted on NaN. A miss here just means "not scored", which is the safe direction.
 */
export function isScoredTier(tier: string | null | undefined): boolean {
  return (tier ?? "").trim().toUpperCase() === "REP";
}

const TIER_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["REP", "Medical Rep"],
  ["DM", "District Manager"],
  ["ACTING_DM", "Acting District Manager"],
  ["RSM", "Regional Sales Manager"],
  ["NSM", "National Sales Manager"],
  ["CEO", "CEO"],
];

/**
 * A readable name for a tier.
 *
 * Falls back to the raw code rather than throwing or printing "undefined": an unrecognised tier is
 * a view that grew, not a reason to break the page. `titleCase` is not attempted — "Cns" is exactly
 * the class of mangling the owner's human-readable-names rule exists to prevent.
 */
export function orgTierLabel(tier: string | null | undefined): string {
  const raw = (tier ?? "").trim();
  if (!raw) return "";
  const found = TIER_LABELS.find(([code]) => code === raw.toUpperCase());
  return found ? found[1] : raw;
}

/** Every tier the label table knows, for the test that pins it against the live view. */
export const KNOWN_ORG_TIERS: readonly string[] = TIER_LABELS.map(([code]) => code);

const sortCells = (cells: OrgCell[]): OrgCell[] =>
  cells.sort((a, b) => a.lineName.localeCompare(b.lineName) || a.regionName.localeCompare(b.regionName));

export type OrgPlacementTree = {
  index: OrgPlacementIndex;
  /** Every line that exists on a seat, for the top of the cascade. */
  lines: Array<{ code: string; name: string }>;
  /** Every region that exists on a seat. */
  regions: Array<{ code: string; name: string }>;
  /** Real (line, region) COMBINATIONS — never a cross product. See the note in `coverage-filters`. */
  cells: Array<{ lineCode: string; regionCode: string }>;
};

/**
 * Resolve every occupied seat to the cells it covers.
 *
 * Descendants are found through `path`, which `au_v_org_tree` already materialises as the array of
 * ancestor seat ids — so this is one pass to bucket cells by ancestor, not a recursive walk.
 */
export function buildOrgPlacementTree(nodes: readonly OrgTreeNode[]): OrgPlacementTree {
  const lineNames = new Map<string, string>();
  const regionNames = new Map<string, string>();

  /** Cells a seat carries in its OWN right. */
  const ownCell = new Map<string, { lineCode: string; regionCode: string }>();
  for (const node of nodes) {
    const lineCode = (node.lineCode ?? "").trim();
    const regionCode = (node.regionCode ?? "").trim();
    if (!lineCode || !regionCode) continue;
    if (!lineNames.has(lineCode)) lineNames.set(lineCode, (node.lineName ?? "").trim() || lineCode);
    if (!regionNames.has(regionCode)) regionNames.set(regionCode, (node.regionName ?? "").trim() || regionCode);
    ownCell.set(node.seatId, { lineCode, regionCode });
  }

  // Every cell that sits anywhere BENEATH a given seat, keyed by that ancestor.
  const beneath = new Map<string, Array<{ lineCode: string; regionCode: string }>>();
  for (const node of nodes) {
    const cell = ownCell.get(node.seatId);
    if (!cell) continue;
    for (const ancestorId of node.path) {
      const list = beneath.get(ancestorId);
      if (list) list.push(cell);
      else beneath.set(ancestorId, [cell]);
    }
  }

  const index: OrgPlacementIndex = new Map();
  for (const node of nodes) {
    const key = orgHrKey(node.occupantHrId);
    if (!key) continue;

    // Own cell first; a seat above the area layer has none and takes what is under it instead.
    const own = ownCell.get(node.seatId);
    const raw = own ? [own] : (beneath.get(node.seatId) ?? []);

    const placement: OrgPlacement =
      index.get(key) ??
      {
        tier: node.seatTier,
        tierLabel: orgTierLabel(node.seatTier),
        scored: isScoredTier(node.seatTier),
        cells: [],
      };

    // A person on a SECOND seat: the REP seat wins the tier, whichever order the rows arrive in.
    // Production has exactly one — an acting DM who also holds the rep seat under her — and the
    // owner's rule is that she stays a medical rep, so her call rate is still measured. Taking
    // whichever row came first would decide that by view ordering, which is no decision at all.
    if (!placement.scored && isScoredTier(node.seatTier)) {
      placement.tier = node.seatTier;
      placement.tierLabel = orgTierLabel(node.seatTier);
      placement.scored = true;
    }

    for (const cell of raw) {
      // Deduped FIELD BY FIELD rather than through a joined key: any separator could in principle
      // occur inside a code, and a collision would attribute the wrong territory to a person.
      if (placement.cells.some((c) => c.lineCode === cell.lineCode && c.regionCode === cell.regionCode)) continue;
      placement.cells.push({
        lineCode: cell.lineCode,
        lineName: lineNames.get(cell.lineCode) ?? cell.lineCode,
        regionCode: cell.regionCode,
        regionName: regionNames.get(cell.regionCode) ?? cell.regionCode,
      });
    }

    sortCells(placement.cells);
    index.set(key, placement);
  }

  // What the two pickers may OFFER — and only from seats with somebody in them.
  //
  // A vacant territory resolves to nobody, so offering it builds a filter whose only possible result
  // is an empty board: every tile "—", and the reader left to work out whether the region is empty
  // or the page is broken. The NAMES above are still learned from every seat, vacant included, so a
  // manager whose coverage includes a vacant area still gets that area's real name, never its code.
  const occupiedSeats = new Set(nodes.filter((node) => orgHrKey(node.occupantHrId)).map((node) => node.seatId));
  const cellSet = new Map<string, { lineCode: string; regionCode: string }>();
  for (const [seatId, cell] of ownCell) {
    if (!occupiedSeats.has(seatId)) continue;
    cellSet.set(`${cell.lineCode}|${cell.regionCode}`, cell);
  }

  const options = (names: Map<string, string>) =>
    [...names.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

  return {
    index,
    lines: options(lineNames),
    regions: options(regionNames),
    cells: [...cellSet.values()],
  };
}

/**
 * Does this person cover the picked line and region?
 *
 * Matched against the person's CELLS, not against a line field and a region field separately: Beni
 * Suef sits in a different region depending on the line, so "his line is CNS" AND "his region is
 * Giza" can both be true of a person who holds no CNS-in-Giza territory at all.
 */
export function placementMatches(
  placement: OrgPlacement | undefined,
  filter: { line?: string | null; region?: string | null },
): boolean {
  if (!placement) return false;
  const line = (filter.line ?? "").trim();
  const region = (filter.region ?? "").trim();
  if (!line && !region) return true;
  return placement.cells.some(
    (cell) => (!line || cell.lineCode === line) && (!region || cell.regionCode === region),
  );
}
