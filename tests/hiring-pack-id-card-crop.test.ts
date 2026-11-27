import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readCornerAnswer, readOrientationAnswer } from "../src/lib/hiring-pack/id-card-corners.ts";
import {
  applyHomography,
  barcodeBand,
  cardCropSize,
  expandQuad,
  homography,
  ID_CARD_ASPECT,
  ID_CARD_BORDER_SHARE,
  isPlausibleCardQuad,
  landscapeQuad,
  orderQuadClockwise,
  outlineCardQuad,
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
//   2. the corners are ORDERED BY GEOMETRY (clockwise, a long side first), so a card standing on its
//      side comes out landscape, and a reading given in the mirror order can never mirror the card;
//      which way up it reads is asked of the flat card afterwards, and the back's barcode band answers
//      when the model cannot;
//   3. the whole card is inside the picture with desk showing on every side: nothing of it is cut;
//   4. a corner reading a few per cent off is snapped back onto the card's real edges;
//   5. a reading that cannot be a card (crossed, tiny, off the photo) is refused, and the photo is
//      then printed as it is.

const PHOTO_W = 900;
const PHOTO_H = 1200;
const DESK = 60;
const CARD = 215;
const STRIPE = 20;

/** A made-up photo: dark desk, a light card inside `quad`, a dark stripe just inside the card's TOP edge. */
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
      // The stripe stops short of the card's edges, as a real card's printing does.
      const value = !inside ? DESK + ((x * 7 + y * 3) % 9) : c.y >= 0.03 && c.y < 0.12 && c.x > 0.03 && c.x < 0.97 ? STRIPE : CARD;
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

  // ── 2 + 3. a card standing on its side (the usual phone shot) comes out landscape and uncut ────
  // The card stands on its long side in a portrait photo; the stripe marks one long edge. The corners
  // are given in no particular order, as the reader may answer them.
  const upright: CardQuad = [
    { x: 700, y: 200 },
    { x: 690, y: 1000 },
    { x: 200, y: 990 },
    { x: 210, y: 210 },
  ];
  const photo = drawPhoto(upright);
  assert.ok(isPlausibleCardQuad(upright, PHOTO_W, PHOTO_H), "an upright card is a plausible card");
  const ordered = landscapeQuad(orderQuadClockwise([upright[2], upright[0], upright[3], upright[1]])!);
  assert.deepEqual(ordered, upright, "ordered clockwise and started on a long side, whatever order the corners came in");
  // The mirror order (counter-clockwise) gives the SAME quad: the card can never come out mirrored.
  const mirrored = [upright[3], upright[2], upright[1], upright[0]];
  assert.deepEqual(landscapeQuad(orderQuadClockwise(mirrored)!), ordered, "a counter-clockwise reading is put back clockwise — never a mirror image");
  assert.equal(orderQuadClockwise([upright[0], upright[1], upright[2]]), null, "three corners are no card");
  const border = Math.round(ID_CARD_BORDER_SHARE * size.width);
  const card = warpCard(photo.rgb, ordered, size.width, size.height, border)!;
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
  assert.ok(rowMean(card, stripeRow, border + 20, card.width - border - 20) < 40, "the stripe's long edge is laid along the top");
  assert.ok(rowMean(card, card.height - border - 6, border + 20, card.width - border - 20) > 190, "card at the bottom edge, no stripe");
  assert.ok(columnMean(card, border + 6, border + size.height * 0.2, border + size.height * 0.9) > 190, "card along the left edge");
  assert.ok(columnMean(card, card.width - border - 7, border + size.height * 0.2, border + size.height * 0.9) > 190, "card along the right edge");

  // An UPSIDE-DOWN landscape card: geometry alone lays it flat, unmirrored, its stripe along the
  // BOTTOM; turning it the right way up is the next step's.
  const flipped: CardQuad = [
    { x: 760, y: 820 },
    { x: 140, y: 830 },
    { x: 150, y: 440 },
    { x: 750, y: 430 },
  ];
  const flippedCard = warpCard(drawPhoto(flipped).rgb, landscapeQuad(orderQuadClockwise(flipped)!), size.width, size.height, border)!;
  assert.ok(flippedCard.width > flippedCard.height, "an upside-down landscape card stays landscape");
  assert.ok(rowMean(flippedCard, flippedCard.height - 1 - stripeRow, border + 20, flippedCard.width - border - 20) < 40, "its stripe lies along the bottom, ready to be turned");

  // The corner reading is pushed out a little before the edge search, and never far off the photo.
  const pushed = expandQuad(upright, 0.05, PHOTO_W, PHOTO_H);
  assert.ok(pushed[0].x > upright[0].x && pushed[0].y < upright[0].y, "each corner moves away from the centre");
  assert.ok(Math.abs(pushed[0].x - upright[0].x) < 20, "by a few per cent, no more");
  const whole: CardQuad = [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 1200 }, { x: 0, y: 1200 }];
  assert.deepEqual(expandQuad(whole, 0.5, PHOTO_W, PHOTO_H)[0], { x: -18, y: -24 }, "and never more than 2% past the photo's edge");

  // Which way up: the back's barcode band runs along the BOTTOM when the card reads upright.
  const bandW = 600;
  const bandH = 380;
  const barcodeCard = (bandAtTop: boolean): GreyImage => {
    const data = new Uint8Array(bandW * bandH).fill(210);
    for (let y = 0; y < bandH; y += 1) {
      if (bandAtTop ? y >= bandH * 0.25 : y <= bandH * 0.75) continue;
      for (let x = 0; x < bandW; x += 1) data[y * bandW + x] = ((x * 7 + y * 3) >> 2) % 2 === 0 ? 30 : 220;
    }
    return { data, height: bandH, width: bandW };
  };
  assert.equal(barcodeBand(barcodeCard(false)), "bottom", "a back with its barcode along the bottom reads upright");
  assert.equal(barcodeBand(barcodeCard(true)), "top", "a barcode along the top means the card is upside down");
  assert.equal(barcodeBand({ data: new Uint8Array(bandW * bandH).fill(210), height: bandH, width: bandW }), null, "no barcode (a front) decides nothing");
  assert.equal(readOrientationAnswer({ orientation: "upside_down" }), "upside_down", "the model's answer is read strictly");
  assert.equal(readOrientationAnswer({ orientation: "unsure" }), null, "unsure decides nothing");
  assert.equal(readOrientationAnswer({ orientation: "sideways" }), null, "anything else decides nothing");

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
  // A reading FAR off — one side 160 px out past the card, another 90 px inside it — is beyond the
  // edge search's band; the card's own light outline finds it, and the snap then lands on its edges.
  const farOff: CardQuad = [
    { x: 700, y: 200 },
    { x: 700, y: 1160 },
    { x: 290, y: 1150 },
    { x: 300, y: 210 },
  ];
  const outline = outlineCardQuad(photo.grey, farOff);
  assert.ok(outline, "the card's outline is found from a reading far off");
  const snappedFar = refineCardQuad(photo.grey, outline!);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(near(snappedFar[i], upright[i], 5), `corner ${i} lands on the card from a far-off reading (got ${JSON.stringify(snappedFar[i])})`);
  }
  // A desk as light as the card has no outline to find: the reading is used as it came.
  assert.equal(outlineCardQuad({ data: new Uint8Array(PHOTO_W * PHOTO_H).fill(230), height: PHOTO_H, width: PHOTO_W }, farOff), null, "no outline on a light desk");

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
  const answer = { corner_1: { x: 5, y: 6 }, corner_2: { x: 7, y: 8 }, corner_3: { x: 3, y: 4 }, corner_4: { x: 1, y: 2 }, found: true };
  assert.deepEqual(readCornerAnswer(answer), [{ x: 5, y: 6 }, { x: 7, y: 8 }, { x: 3, y: 4 }, { x: 1, y: 2 }], "the four corners come back as answered");
  assert.equal(readCornerAnswer({ ...answer, found: false }), null, "no card found → no crop");
  assert.equal(readCornerAnswer({ ...answer, corner_1: { x: "5", y: 6 } }), null, "a corner that is not two numbers → no crop");
  assert.deepEqual(quadFromThousandths([{ x: 500, y: 250 }, { x: 1000, y: 250 }, { x: 1000, y: 750 }, { x: 500, y: 750 }], 900, 1200)?.[0], { x: 450, y: 300 }, "thousandths become pixels");
  assert.equal(quadFromThousandths([{ x: 1, y: 1 }], 900, 1200), null, "three or five corners are no card");

  // ── wiring: the page prints the crop, keeps the border, and falls back to the photo ─────────
  const store = readFileSync(join(process.cwd(), "src/lib/hiring-pack/bank-account-letter-store.ts"), "utf8");
  assert.ok(store.includes("const card = (await cropToCard(bytes).catch(() => null)) ?? (await cropToCard(bytes).catch(() => null));"), "every side is cut to the card first, asked twice, and a failed crop never loses the picture");
  assert.ok(store.includes("if (upright.info.height > upright.info.width)") && store.includes(".rotate(turn)"), "an uncut portrait photo is still printed landscape, turned the right way up");
  assert.ok(store.includes("ID_CARD_BORDER_SHARE * size.width"), "the crop keeps the border round the card");
  assert.ok(store.includes("isPlausibleCardQuad(quad, info.width, info.height)"), "a reading that cannot be a card is never warped");
  assert.ok(store.includes("refineCardQuad(greyImage, outlineCardQuad(greyImage, quad) ?? quad)"), "the card's own outline is used before the snap, the reading only when there is none");
  assert.ok(store.includes("orderQuadClockwise(read)") && store.includes("landscapeQuad(ordered)"), "the corners are ordered by geometry before the warp: never mirrored, always landscape");
  assert.ok(store.includes("findIdCardOrientation(preview)") && store.includes('=== "top"') && store.includes(".rotate(upsideDown ? 180 : 0)"), "an upside-down card is turned, by the model's answer or else the barcode band");
  const corners = readFileSync(join(process.cwd(), "src/lib/hiring-pack/id-card-corners.ts"), "utf8");
  assert.ok(corners.includes("createOpenAiResponseText") && corners.includes("hasAiApiKey()"), "the corners are asked through the one AI door");
  assert.ok(corners.includes("OUTSIDE"), "the reader is told to err outside the card, never inside it");
}
