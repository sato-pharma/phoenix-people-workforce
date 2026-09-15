/**
 * QR codes, encoded here and drawn as rectangles.
 *
 * The certificate and the journey each carry one, pointing at the page on
 * satopharma.com that says the document is genuine (owner, 13 Sep 2026). This
 * is hand-written for the reason pdf.ts, csv.ts and xlsx.ts are: the project
 * has four runtime dependencies and a QR library would be the fifth, for one
 * URL per document.
 *
 * What it covers is what a verification URL needs and nothing more: BYTE mode
 * only, versions 1 to 10 (up to 57 x 57 modules, 213 bytes at level M), all
 * four error-correction levels. No numeric or alphanumeric segments, no Kanji,
 * no structured append — an address with lower-case letters in its path is
 * byte mode whatever an optimiser would say, and splitting one URL into
 * segments saves a handful of modules nobody sees.
 *
 * The algorithm follows ISO/IEC 18004 as Project Nayuki's reference encoder
 * lays it out, and tests/qr.test.mts holds the output to the matrices the
 * Python `qrcode` library produces for the same text, level, version and mask
 * — module for module, across all eight masks. A QR code that is wrong in one
 * codeword still looks exactly like a QR code, so nothing short of that
 * comparison, and a real decoder reading the printed page, says it works.
 */

import type { Pdf, RgbColor } from "./pdf.ts";

export type QrEcc = "L" | "M" | "Q" | "H";

export type QrCode = {
  version: number;
  ecc: QrEcc;
  mask: number;
  /** Modules per side, not counting the quiet zone. */
  size: number;
  /** modules[row][column], true for a dark module. */
  modules: boolean[][];
};

/** The light margin a reader needs around the symbol, in modules. */
export const QR_QUIET = 4;

const MAX_VERSION = 10;

/* Indexed by version - 1. From the standard's tables 9 and 13. */
const ECC_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS: Record<QrEcc, number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
/* The two format bits for each level are not in alphabetical order. */
const FORMAT_ECC: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Modules left for data and error correction once the patterns are placed. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_PER_BLOCK[ecc][version - 1] * BLOCKS[ecc][version - 1]
  );
}

/* ------------------------------------------------------ Reed-Solomon, GF(256) */

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/* ------------------------------------------------------------- the encoder */

/**
 * Encode `text` as UTF-8 in byte mode.
 *
 * `version` pins the version (and throws if the text does not fit it);
 * otherwise the smallest that holds the text is used. `mask` pins the mask;
 * otherwise the one with the lowest penalty under the standard's four rules
 * is chosen. Both pins exist for the test that compares against a reference
 * encoder, since two correct encoders may still choose different masks.
 */
export function encodeQr(
  text: string,
  options: { ecc?: QrEcc; version?: number; mask?: number } = {},
): QrCode {
  const ecc = options.ecc ?? "M";
  const bytes = [...new TextEncoder().encode(text)];

  const needBits = (version: number) =>
    4 + (version < 10 ? 8 : 16) + bytes.length * 8;
  let version = options.version ?? 1;
  if (options.version !== undefined) {
    if (needBits(version) > dataCodewords(version, ecc) * 8) {
      throw new Error(`"${text}" does not fit a version ${version}-${ecc} QR code`);
    }
  } else {
    while (version <= MAX_VERSION && needBits(version) > dataCodewords(version, ecc) * 8) {
      version++;
    }
    if (version > MAX_VERSION) {
      throw new Error(`"${text}" is too long for a version ${MAX_VERSION}-${ecc} QR code`);
    }
  }

  /* The bit stream: mode, count, the bytes, a terminator, then padding. */
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  }

  const codewords = interleave(data, version, ecc);

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  drawFunctionPatterns(version, size, set);
  drawFormatBits(ecc, 0, size, set); // reserved now, rewritten once the mask is known
  drawCodewords(codewords, size, modules, isFunction);

  let mask = options.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(candidate, modules, isFunction);
      drawFormatBits(ecc, candidate, size, set);
      const score = penalty(modules);
      if (score < best) {
        best = score;
        mask = candidate;
      }
      applyMask(candidate, modules, isFunction); // XOR again undoes it
    }
  }
  applyMask(mask, modules, isFunction);
  drawFormatBits(ecc, mask, size, set);

  return { version, ecc, mask, size, modules };
}

/** Split into blocks, add each block's error correction, interleave. */
function interleave(data: number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = BLOCKS[ecc][version - 1];
  const blockEcc = ECC_PER_BLOCK[ecc][version - 1];
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(blockEcc);

  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const length = shortLen - blockEcc + (i < numShort ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    const ecc = rsRemainder(block, divisor);
    /* A placeholder where a long block has one more data byte, so every block
       is the same length and its error correction starts at the same index.
       It is never written out. */
    if (i < numShort) block.push(0);
    blocks.push([...block, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - blockEcc || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < count; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

type Setter = (x: number, y: number, dark: boolean) => void;

function drawFunctionPatterns(version: number, size: number, set: Setter) {
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, ring !== 2 && ring !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((ay, i) => {
    positions.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

function drawFormatBits(ecc: QrEcc, mask: number, size: number, set: Setter) {
  const data = (FORMAT_ECC[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the dark module, always dark
}

function drawCodewords(
  codewords: number[],
  size: number,
  modules: boolean[][],
  isFunction: boolean[][],
) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern is skipped whole
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function applyMask(mask: number, modules: boolean[][], isFunction: boolean[][]) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: throw new Error(`there is no QR mask ${mask}`);
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

/**
 * The standard's four penalty rules: long runs, 2 x 2 blocks, anything that
 * looks like a finder, and imbalance between dark and light. Any mask decodes;
 * this only picks the one a camera finds easiest.
 */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]);
    lines.push(modules.map((row) => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const text = line.map((dark) => (dark ? "1" : "0")).join("");
    for (let at = text.indexOf("1011101"); at !== -1; at = text.indexOf("1011101", at + 1)) {
      const before = text.slice(Math.max(0, at - 4), at);
      const after = text.slice(at + 7, at + 11);
      if (before === "0000" || after === "0000") score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (
        y + 1 < size &&
        x + 1 < size &&
        modules[y][x] === modules[y][x + 1] &&
        modules[y][x] === modules[y + 1][x] &&
        modules[y][x] === modules[y + 1][x + 1]
      ) {
        score += 3;
      }
    }
  }
  const total = size * size;
  score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/* ------------------------------------------------------ the branded drawing */

export type QrStyle = {
  /** Ink at the top-left module and at the bottom-right; the data modules
      between are mixed along the diagonal. */
  from: RgbColor;
  to: RgbColor;
  /** The three finders' rings and the alignment rings. */
  eye: RgbColor;
  /** The centre of each finder and alignment pattern. */
  pupil: RgbColor;
  /** The shape of a data module and of a finder's centre. A liquid module
      fills its cell and rounds only the corners with no dark neighbour on
      either side, so runs join into strokes and a lone module is a dot. */
  module: "square" | "diamond" | "liquid";
  pupilShape: "square" | "diamond" | "dot";
  /** Side of a data module as a share of its cell. A diamond at 1 touches its
      neighbours at the points; above 1 the points overlap into a lattice. */
  scale: number;
  /** A clear field in the middle, in modules, for a mark. Odd numbers keep it
      centred on a module. */
  field?: { w: number; h: number };
};

/**
 * Draw a code in the company's colours, `side` points square at x, y, and hand
 * back the clear field in the middle (in points) for the caller to put a mark
 * in, or null when the style asks for none.
 *
 * Everything that makes this a picture costs the reader something, and each
 * cost is paid out of the error correction rather than out of luck: the field
 * erases the modules under it outright, a diamond covers half its cell, and a
 * blue is lighter than black. So a styled code is only ever drawn at level H,
 * which rebuilds 30% of the symbol, and only ever trusted once a real decoder
 * has read it off the emitted page — the finders stay exact squares, because
 * the 1:1:3:1:1 ratio across them is how a camera finds the code at all.
 */
export function drawStyledQr(
  doc: Pdf,
  code: QrCode,
  x: number,
  y: number,
  side: number,
  style: QrStyle,
): { x: number; y: number; w: number; h: number } | null {
  if (code.ecc !== "H") throw new Error("a styled QR code must be encoded at level H");
  const unit = side / code.size;
  const n = code.size;

  /* Which modules belong to a finder (with its separator) or an alignment
     pattern, so they are drawn as eyes and never as data. */
  const reserved = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const reserve = (x0: number, y0: number, w: number, h: number) => {
    for (let r = Math.max(0, y0); r < Math.min(n, y0 + h); r++) {
      for (let c = Math.max(0, x0); c < Math.min(n, x0 + w); c++) reserved[r][c] = true;
    }
  };
  const finders: [number, number][] = [[0, 0], [n - 7, 0], [0, n - 7]];
  for (const [fx, fy] of finders) reserve(fx - 1, fy - 1, 9, 9);
  const positions = alignmentPositions(code.version);
  const last = positions.length - 1;
  const alignments: [number, number][] = [];
  positions.forEach((ay, i) => {
    positions.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      alignments.push([ax, ay]);
      reserve(ax - 2, ay - 2, 5, 5);
    });
  });

  let field: { x: number; y: number; w: number; h: number } | null = null;
  const clear = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  if (style.field) {
    const fx = Math.floor((n - style.field.w) / 2);
    const fy = Math.floor((n - style.field.h) / 2);
    for (let r = fy; r < fy + style.field.h; r++) {
      for (let c = fx; c < fx + style.field.w; c++) {
        if (reserved[r][c]) throw new Error("the clear field reaches a finder or alignment pattern");
        clear[r][c] = true;
      }
    }
    field = { x: x + fx * unit, y: y + fy * unit, w: style.field.w * unit, h: style.field.h * unit };
  }

  const ink = (c: number, r: number): RgbColor => {
    const t = (c + r) / (2 * (n - 1));
    return [0, 1, 2].map((k) => style.from[k] + (style.to[k] - style.from[k]) * t) as unknown as RgbColor;
  };

  /* A rectangle with its corners rounded by their own radii (top-left,
     top-right, bottom-right, bottom-left), as a sampled polygon. */
  const rounded = (rx: number, ry: number, w: number, h: number, radii: readonly number[], color: RgbColor) => {
    const points: [number, number][] = [];
    const corners: [number, number, number][] = [
      [rx + radii[0], ry + radii[0], Math.PI],
      [rx + w - radii[1], ry + radii[1], -Math.PI / 2],
      [rx + w - radii[2], ry + h - radii[2], 0],
      [rx + radii[3], ry + h - radii[3], Math.PI / 2],
    ];
    corners.forEach(([cx, cy, from], i) => {
      const radius = radii[i];
      const steps = radius > 0 ? 8 : 0;
      for (let s = 0; s <= steps; s++) {
        const a = from + (Math.PI / 2) * (steps ? s / steps : 0);
        points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
      }
    });
    doc.polygon(points, color);
  };

  const shape = (cx: number, cy: number, size: number, kind: "square" | "diamond" | "dot", color: RgbColor) => {
    const half = size / 2;
    if (kind === "square") {
      doc.rect(cx - half, cy - half, size, size, color);
    } else if (kind === "dot") {
      rounded(cx - half, cy - half, size, size, [half, half, half, half], color);
    } else {
      doc.polygon([[cx, cy - half], [cx + half, cy], [cx, cy + half], [cx - half, cy]], color);
    }
  };

  const data = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < n && c < n && code.modules[r][c] && !reserved[r][c] && !clear[r][c];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!data(r, c)) continue;
      if (style.module === "liquid") {
        /* Joined sides reach a twenty-fifth of a module into the neighbour, so
           two modules meeting on a fractional coordinate show no seam. */
        const up = data(r - 1, c), down = data(r + 1, c), left = data(r, c - 1), right = data(r, c + 1);
        const e = unit * 0.04;
        const half = unit / 2;
        const x0 = x + c * unit - (left ? e : 0);
        const y0 = y + r * unit - (up ? e : 0);
        const x1 = x + (c + 1) * unit + (right ? e : 0);
        const y1 = y + (r + 1) * unit + (down ? e : 0);
        rounded(x0, y0, x1 - x0, y1 - y0, [
          !up && !left ? half : 0,
          !up && !right ? half : 0,
          !down && !right ? half : 0,
          !down && !left ? half : 0,
        ], ink(c, r));
        continue;
      }
      const size = unit * style.scale * (style.module === "diamond" ? Math.SQRT2 : 1);
      shape(x + (c + 0.5) * unit, y + (r + 0.5) * unit, size, style.module, ink(c, r));
    }
  }

  /* The eyes: a ring one module thick, drawn as four exact rectangles, and a
     centre three modules across. A diamond centre keeps three modules of dark
     on the two lines through its middle, which is where the ratio is read. */
  const ring = (rx: number, ry: number, span: number) => {
    const px = x + rx * unit;
    const py = y + ry * unit;
    doc.rect(px, py, span * unit, unit, style.eye);
    doc.rect(px, py + (span - 1) * unit, span * unit, unit, style.eye);
    /* The sides reach a twentieth of a module under the top and bottom bars,
       or the four meet on fractional coordinates and leave paper at the joins. */
    const seam = unit * 0.05;
    doc.rect(px, py + unit - seam, unit, (span - 2) * unit + 2 * seam, style.eye);
    doc.rect(px + (span - 1) * unit, py + unit - seam, unit, (span - 2) * unit + 2 * seam, style.eye);
  };
  for (const [fx, fy] of finders) {
    ring(fx, fy, 7);
    shape(x + (fx + 3.5) * unit, y + (fy + 3.5) * unit, 3 * unit * (style.pupilShape === "diamond" ? Math.SQRT2 : 1), style.pupilShape, style.pupil);
  }
  for (const [ax, ay] of alignments) {
    ring(ax - 2, ay - 2, 5);
    doc.rect(x + ax * unit, y + ay * unit, unit, unit, style.pupil);
  }
  return field;
}

/* ------------------------------------------------------------- the drawing */

/**
 * Draw a code as filled rectangles, `side` points square, top-left at x, y.
 *
 * Each row's dark modules are merged into runs, so a code is a few hundred
 * rectangles rather than a thousand. Nothing light is painted: the caller owns
 * the ground and must keep QR_QUIET modules of it clear on every side.
 *
 * Every run is drawn a twentieth of a module taller than its row. Rows that
 * meet on a fractional coordinate are rounded twice by a rasteriser, and a
 * hairline of paper between two dark rows is a light line straight through
 * the symbol — the certificate's gloss hit the same seam and is overlapped
 * for the same reason.
 */
export function drawQr(
  doc: Pdf,
  code: QrCode,
  x: number,
  y: number,
  side: number,
  color: RgbColor,
) {
  const unit = side / code.size;
  code.modules.forEach((row, r) => {
    let start = -1;
    for (let c = 0; c <= code.size; c++) {
      const dark = c < code.size && row[c];
      if (dark && start < 0) start = c;
      if (!dark && start >= 0) {
        const tall = r < code.size - 1 ? unit * 1.05 : unit;
        doc.rect(x + start * unit, y + r * unit, (c - start) * unit, tall, color);
        start = -1;
      }
    }
  });
}
