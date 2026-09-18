import { customerAddressTokens } from "@/lib/sales/normalizer/customer-normalize";

// The first free step of the customer pipeline (customer-suggest.ts), run before any AI is paid:
// find the pharmacies ALREADY mapped whose address shares the unknown pharmacy's rarest address
// words, and let the closest ten vote for an area. Pure — no I/O.
//
// Measured on 2026-09-18 against 2,000 held-out Pharma Overseas pharmacies whose brick the owner's
// own sources settled (each one's own mapping removed first): at the thresholds below it answered
// 764 of them and put 97.5% in the right area. On the 300 of those also sent to the AI, it was
// right on more of its own answers than the AI was. Loosen the thresholds only after re-measuring.
//
// How a match is scored. Every address word carries an IDF weight (a word few mapped pharmacies
// share weighs more). A mapped pharmacy scores the weight of the unknown's words it also holds,
// divided by the weight of all the unknown's scorable words — 1.0 means it holds every one. Words
// held by more than 2% of the map ("شارع", a governorate name) are not scorable: they would pull in
// thousands of neighbours and prove nothing. The ten best score, grouped by area; the answer is the
// heaviest area's heaviest brick, and it is kept only when the best neighbour is close enough AND
// the area vote is clear enough.

export const ADDRESS_MATCH_MIN_TOP_SCORE = 0.7;
export const ADDRESS_MATCH_MIN_AREA_SHARE = 0.7;
const COMMON_WORD_SHARE = 0.02;
const NEIGHBOURS = 10;

export type AddressMatchRow = { address: string; brickId: string };

export type AddressMatchIndex = {
  bricks: string[];
  areaByBrick: ReadonlyMap<string, string>;
  documentCount: number;
  documentFrequency: Map<string, number>;
  postings: Map<string, number[]>;
};

export type AddressMatch = { areaCode: string; brickId: string; topScore: number; areaShare: number };

/**
 * `rows` is every mapping with a live brick, empty addresses included (they count towards the IDF
 * total exactly as they did when the thresholds were measured). `areaByBrick` is the brick master.
 */
export function buildAddressMatchIndex(rows: readonly AddressMatchRow[], areaByBrick: ReadonlyMap<string, string>): AddressMatchIndex {
  const tokens = rows.map((row) => [...customerAddressTokens(row.address)]);
  const documentFrequency = new Map<string, number>();
  for (const list of tokens) for (const token of list) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const postings = new Map<string, number[]>();
  const commonAbove = rows.length * COMMON_WORD_SHARE;
  tokens.forEach((list, index) => {
    for (const token of list) {
      if ((documentFrequency.get(token) ?? 0) > commonAbove) continue;
      const posting = postings.get(token);
      if (posting) posting.push(index);
      else postings.set(token, [index]);
    }
  });
  return {
    areaByBrick,
    bricks: rows.map((row) => String(row.brickId).trim()),
    documentCount: rows.length,
    documentFrequency,
    postings,
  };
}

function inverseFrequency(index: AddressMatchIndex, token: string): number {
  return Math.log((index.documentCount + 1) / ((index.documentFrequency.get(token) ?? 0) + 1));
}

/** The best area and brick for an address, with its scores — before any threshold is applied. */
export function scoreAddressMatch(index: AddressMatchIndex, address: string): AddressMatch | null {
  const query = [...customerAddressTokens(address)].filter((token) => index.postings.has(token));
  const queryWeight = query.reduce((sum, token) => sum + inverseFrequency(index, token), 0);
  if (queryWeight === 0) return null;
  const score = new Map<number, number>();
  for (const token of query) {
    const weight = inverseFrequency(index, token);
    for (const doc of index.postings.get(token) ?? []) score.set(doc, (score.get(doc) ?? 0) + weight);
  }
  // Array.prototype.sort is stable, so equal scores keep the map's id order and the answer is repeatable.
  const top = [...score.entries()].map(([doc, s]) => [doc, s / queryWeight] as const).sort((a, b) => b[1] - a[1]).slice(0, NEIGHBOURS);
  if (top.length === 0) return null;
  const areaWeight = new Map<string | undefined, number>();
  for (const [doc, s] of top) {
    const area = index.areaByBrick.get(index.bricks[doc]);
    areaWeight.set(area, (areaWeight.get(area) ?? 0) + s);
  }
  const total = [...areaWeight.values()].reduce((a, b) => a + b, 0);
  const [bestArea, bestWeight] = [...areaWeight.entries()].sort((a, b) => b[1] - a[1])[0];
  if (bestArea === undefined) return null;
  const brickWeight = new Map<string, number>();
  for (const [doc, s] of top) {
    if (index.areaByBrick.get(index.bricks[doc]) !== bestArea) continue;
    brickWeight.set(index.bricks[doc], (brickWeight.get(index.bricks[doc]) ?? 0) + s);
  }
  const [bestBrick] = [...brickWeight.entries()].sort((a, b) => b[1] - a[1])[0];
  return { areaCode: bestArea, areaShare: bestWeight / total, brickId: bestBrick, topScore: top[0][1] };
}

/** The address match the pipeline accepts, or null when it is not close or not clear enough. */
export function matchByAddress(index: AddressMatchIndex, address: string): AddressMatch | null {
  const match = scoreAddressMatch(index, address);
  if (!match) return null;
  return match.topScore >= ADDRESS_MATCH_MIN_TOP_SCORE && match.areaShare >= ADDRESS_MATCH_MIN_AREA_SHARE ? match : null;
}
