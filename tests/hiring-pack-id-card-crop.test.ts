import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readCornerAnswer } from "../src/lib/hiring-pack/id-card-corners.ts";
import {
  applyHomography,
  cardCropSize,
  homography,
  ID_CARD_ASPECT,
  ID_CARD_BORDER_SHARE,
  isPlausibleCardQuad,
  quadFromThousandths,
  refineCardQuad,
  warpCard,
  type CardQuad,
  type GreyImage,
  type Point,
  type RawImage,
} from "../src/lib/hiring-pack/id-card-crop.ts";

// The bank letter's ID pages print each card CUT TO THE CARD AND LAID FLAT, LANDSCAPE (owner,
// 2026-11-27), WITH A THIN BORDER KEPT ROUND IT ("never eat a piece of the card — always leave a
// small bit around it"). Every picture here is a drawn, made-up card — never a real ID. What this pins:
//   1. the warp lands every card corner where it belongs and the picture is landscape, in the card's
//      proportion, plus the border;
//   2. a card photographed upright and upside down still comes out the right way up — the corner
//      ORDER, not the photo, says which way the card reads;
//   3. the whole card is inside the picture with desk showing on every side: nothing of it is cut;
//   4. a corner reading a few per cent off is snapped back onto the card's real edges;
//   5. a reading that cannot be a card (crossed, tiny, off the photo) is refused, and the photo is
//      then printed as it is.

const PHOTO_W = 900;
const PHOTO_H = 1200;
const DESK = 60;
const CARD = 215;
const STRIPE = 20;

/** A made-up photo: dark desk, a light card inside `quad`, a dark stripe along the card's TOP edge. */
function drawPhoto(quad: CardQuad): { rgb: RawImage; grey: GreyImage } {
  // Photo pixel → card coordinates in 0..1, through the map from the photo onto the unit square.
  const toCard = homography(quad, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ])!;
  const rgb = new Uint8Array(PHOTO_W * PHOTO_H * 3);
  const grey = new Uint8Array(PHOTO_W * PHOTO_H);
  for (let y = 0; y < PHOTO_H; y += 1) {
    for (let x = 0; x < PHOTO_W; x += 1) {
      const c = applyHomography(toCard, { x, y });
      const inside = c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1;
      const value = !inside ? DESK + ((x * 7 + y * 3) % 9) : c.y < 0.12 ? STRIPE : CARD;
      grey[y * PHOTO_W + x] = value;
      rgb.fill(value, (y * PHOTO_W + x) * 3, (y * PHOTO_W + x) * 3 + 3);
    }
  }
  return { grey: { data: grey, height: PHOTO_H, width: PHOTO_W }, rgb: { channels: 3, data: rgb, height: PHOTO_H, width: PHOTO_W } };
}

function at(image: RawImage, x: number, y: number): number {
  return image.data[(Math.round(y) * image.width + Math.round(x)) * image.channels];
}

function rowMean(image: RawImage, y: number, from: number, to: number): number {
  let sum = 0;
  for (let x = from; x < to; x += 1) sum += at(image, x, y);
  return sum / (to - from);
}

function columnMean(image: RawImage, x: number, from: number, to: number): number {
  let sum = 0;
  for (let y = from; y < to; y += 1) sum += at(image, x, y);
  return sum / (to - from);
}

const near = (a: Point, b: Point, tolerance: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

export async function runHiringPackIdCardCropTests() {
  // ── 1. the map itself ─────────────────────────────────────────────────────────────────────────
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const slanted: Point[] = [
    { x: 100, y: 120 },
    { x: 520, y: 90 },
    { x: 560, y: 400 },
    { x: 80, y: 380 },
  ];
  const h = homography(square, slanted)!;
  for (let i = 0; i < 4; i += 1) assert.ok(near(applyHomography(h, square[i]), slanted[i], 1e-6), `corner ${i} maps exactly`);
  assert.equal(homography(square, [slanted[0], slanted[0], slanted[0], slanted[0]]), null, "four identical points are no map");

  const size = cardCropSize();
  assert.ok(size.width > size.height, "the card is always printed landscape");
  assert.ok(Math.abs(size.width / size.height - ID_CARD_ASPECT) < 0.005, "in the ID-1 card's own proportion");

  // ── 2 + 3. an UPRIGHT card (the usual phone shot) comes out landscape, right way up, uncut ────
  // The card stands on its long side in a portrait photo; its printing reads top-to-bottom, so its
  // own top-left corner is the photo's top-RIGHT. The stripe marks the card's top edge.
  const upright: CardQuad = [
    { x: 700, y: 200 },
    { x: 690, y: 1000 },
    { x: 200, y: 990 },
    { x: 210, y: 210 },
  ];
  const photo = drawPhoto(upright);
  assert.ok(isPlausibleCardQuad(upright, PHOTO_W, PHOTO_H), "an upright card is a plausible card");
  const border = Math.round(ID_CARD_BORDER_SHARE * size.width);
  const card = warpCard(photo.rgb, upright, size.width, size.height, border)!;
  assert.equal(card.width, size.width + 2 * border, "the picture is the card plus the border, side to side");
  assert.equal(card.height, size.height + 2 * border, "and top to bottom");
  assert.ok(card.width > card.height, "landscape");
  // The border is desk on all four sides — nothing of the card reaches the edge of the picture.
  const mid = border / 2;
  assert.ok(rowMean(card, mid, border, card.width - border) < 90, "desk above the card: the top edge is not cut");
  assert.ok(rowMean(card, card.height - 1 - mid, border, card.width - border) < 90, "desk below the card: the bottom edge is not cut");
  assert.ok(columnMean(card, mid, border, card.height - border) < 90, "desk left of the card: the left edge is not cut");
  assert.ok(columnMean(card, card.width - 1 - mid, border, card.height - border) < 90, "desk right of the card: the right edge is not cut");
  // Just inside each edge is card — the whole card, edge to edge, is in the picture.
  const stripeRow = border + Math.round(size.height * 0.05);
  assert.ok(rowMean(card, stripeRow, border + 20, card.width - border - 20) < 40, "the card's top stripe is at the TOP: the card reads the right way up");
  assert.ok(rowMean(card, card.height - border - 6, border + 20, card.width - border - 20) > 190, "card at the bottom edge, no stripe");
  assert.ok(columnMean(card, border + 6, border + size.height * 0.2, border + size.height * 0.9) > 190, "card along the left edge");
  assert.ok(columnMean(card, card.width - border - 7, border + size.height * 0.2, border + size.height * 0.9) > 190, "card along the right edge");

  // An UPSIDE-DOWN landscape card: the corner order turns it the right way up.
  const flipped: CardQuad = [
    { x: 760, y: 820 },
    { x: 140, y: 830 },
    { x: 150, y: 440 },
    { x: 750, y: 430 },
  ];
  const flippedCard = warpCard(drawPhoto(flipped).rgb, flipped, size.width, size.height, border)!;
  assert.ok(rowMean(flippedCard, stripeRow, border + 20, flippedCard.width - border - 20) < 40, "an upside-down card is turned the right way up");

  // ── 4. a corner reading a few per cent off is snapped onto the real edges ─────────────────────
  const misread: CardQuad = [
    { x: 724, y: 186 },
    { x: 676, y: 1022 },
    { x: 182, y: 972 },
    { x: 228, y: 228 },
  ];
  const refined = refineCardQuad(photo.grey, misread);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(near(refined[i], upright[i], 4), `corner ${i} snapped to within 4 px of the card (read ${JSON.stringify(misread[i])}, got ${JSON.stringify(refined[i])})`);
  }
  // A white card on a white desk has no edge to snap to: the reading is kept as it came.
  const blank: GreyImage = { data: new Uint8Array(PHOTO_W * PHOTO_H).fill(230), height: PHOTO_H, width: PHOTO_W };
  assert.deepEqual(refineCardQuad(blank, misread), misread, "no edge found → the reading is kept, never invented");

  // ── 5. a reading that cannot be a card is refused ────────────────────────────────────────────
  const crossed: CardQuad = [upright[0], upright[2], upright[1], upright[3]];
  assert.equal(isPlausibleCardQuad(crossed, PHOTO_W, PHOTO_H), false, "crossed corners are not a card");
  const tiny: CardQuad = [
    { x: 10, y: 10 },
    { x: 60, y: 10 },
    { x: 60, y: 40 },
    { x: 10, y: 40 },
  ];
  assert.equal(isPlausibleCardQuad(tiny, PHOTO_W, PHOTO_H), false, "a sliver of the photo is not the card");
  const offPhoto: CardQuad = [
    { x: 100, y: 100 },
    { x: 1400, y: 100 },
    { x: 1400, y: 900 },
    { x: 100, y: 900 },
  ];
  assert.equal(isPlausibleCardQuad(offPhoto, PHOTO_W, PHOTO_H), false, "a corner far off the photo is a misread");

  // The corner reader's answer is read strictly.
  const answer = { bottom_left: { x: 1, y: 2 }, bottom_right: { x: 3, y: 4 }, found: true, top_left: { x: 5, y: 6 }, top_right: { x: 7, y: 8 } };
  assert.deepEqual(readCornerAnswer(answer), [{ x: 5, y: 6 }, { x: 7, y: 8 }, { x: 3, y: 4 }, { x: 1, y: 2 }], "corners come back in reading order");
  assert.equal(readCornerAnswer({ ...answer, found: false }), null, "no card found → no crop");
  assert.equal(readCornerAnswer({ ...answer, top_left: { x: "5", y: 6 } }), null, "a corner that is not two numbers → no crop");
  assert.deepEqual(quadFromThousandths([{ x: 500, y: 250 }, { x: 1000, y: 250 }, { x: 1000, y: 750 }, { x: 500, y: 750 }], 900, 1200)?.[0], { x: 450, y: 300 }, "thousandths become pixels");
  assert.equal(quadFromThousandths([{ x: 1, y: 1 }], 900, 1200), null, "three or five corners are no card");

  // ── wiring: the page prints the crop, keeps the border, and falls back to the photo ─────────
  const store = readFileSync(join(process.cwd(), "src/lib/hiring-pack/bank-account-letter-store.ts"), "utf8");
  assert.ok(store.includes("const card = await cropToCard(bytes).catch(() => null);"), "every side is cut to the card first, and a failed crop never loses the picture");
  assert.ok(store.includes("ID_CARD_BORDER_SHARE * size.width"), "the crop keeps the border round the card");
  assert.ok(store.includes("isPlausibleCardQuad(quad, info.width, info.height)"), "a reading that cannot be a card is never warped");
  const corners = readFileSync(join(process.cwd(), "src/lib/hiring-pack/id-card-corners.ts"), "utf8");
  assert.ok(corners.includes("createOpenAiResponseText") && corners.includes("hasAiApiKey()"), "the corners are asked through the one AI door");
  assert.ok(corners.includes("OUTSIDE"), "the reader is told to err outside the card, never inside it");
}
