/**
 * QR Code encoder — byte mode, all four error-correction levels, versions 1 to 40.
 *
 * WHY PHOENIX CARRIES ITS OWN. A tablet is enrolled into the company fleet by scanning a QR code
 * that Google's Android Management API hands back as a JSON string. Nothing in this repository
 * could draw one: no QR package is installed, and adding a dependency for a single screen is a
 * lockfile change that every worktree on the machine then has to absorb. The encoder is a few
 * hundred lines of well-documented arithmetic from ISO/IEC 18004, so it lives here instead.
 *
 * WHAT IT DOES NOT DO. Only byte mode is implemented. Numeric, alphanumeric and kanji modes pack
 * some inputs tighter, but the enrollment payload is JSON — braces, quotes, lower case — which only
 * byte mode can carry, so the other modes would be code with no caller. No ECI header is written:
 * the payload is ASCII, and ASCII is what every scanner assumes without one.
 *
 * HOW IT IS CHECKED. `tests/tablet-enrollment.test.ts` pins the arithmetic to the published tables
 * (the byte-capacity chart for all 160 version/level pairs, every format and version word, every
 * alignment position) and then reads each symbol back with an independent decoder written in the
 * test: format bits from both copies, the zigzag walk, the mask, the Reed–Solomon syndromes and the
 * byte-mode payload. A symbol that decodes there is one a phone's camera will read.
 *
 * The structure follows Project Nayuki's reference encoder (MIT), which is the implementation most
 * other libraries are checked against.
 */

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

export type QrCode = {
  /** 1 to 40. The symbol is `4 × version + 17` modules on each side. */
  version: number;
  size: number;
  errorCorrection: QrErrorCorrection;
  /** 0 to 7 — whichever of the eight masks scored the lowest penalty. */
  mask: number;
  /** `modules[y][x]`, row by row. `true` is a dark module. The quiet zone is NOT included. */
  modules: boolean[][];
};

export type EncodeQrOptions = {
  /** Defaults to `M`, which recovers from roughly 15% damage — a smudged screen, a bent printout. */
  errorCorrection?: QrErrorCorrection;
  minVersion?: number;
  maxVersion?: number;
  /** Force one mask instead of choosing by penalty score. Used by the tests; nothing else needs it. */
  mask?: number;
};

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/** The four modules of light margin the standard requires around a symbol. */
export const QR_QUIET_ZONE = 4;

/** The two-bit value each level carries in the format information. Not in L-M-Q-H order. */
const FORMAT_BITS: Record<QrErrorCorrection, number> = { H: 2, L: 1, M: 0, Q: 3 };

const LEVEL_INDEX: Record<QrErrorCorrection, number> = { H: 3, L: 0, M: 1, Q: 2 };

/** Error-correction codewords per block, by level (L, M, Q, H) then version. Index 0 is unused. */
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

/** Error-correction blocks, by level (L, M, Q, H) then version. Index 0 is unused. */
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Penalty weights from the standard's mask evaluation (§7.8.3). */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < QR_MIN_VERSION || version > QR_MAX_VERSION) {
    throw new RangeError(`A QR version is a whole number from 1 to 40 — got ${version}.`);
  }
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

// ---------------------------------------------------------------------------------------------
// Capacity arithmetic
// ---------------------------------------------------------------------------------------------

/** Modules left for data and error correction once every function pattern is drawn. */
export function qrRawDataModules(version: number): number {
  assertVersion(version);
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function qrErrorCorrectionLayout(
  version: number,
  level: QrErrorCorrection,
): { blocks: number; eccPerBlock: number } {
  assertVersion(version);
  const index = LEVEL_INDEX[level];
  return {
    blocks: NUM_ERROR_CORRECTION_BLOCKS[index][version],
    eccPerBlock: ECC_CODEWORDS_PER_BLOCK[index][version],
  };
}

/** 8-bit data codewords a symbol of this version and level holds, before error correction. */
export function qrDataCodewords(version: number, level: QrErrorCorrection): number {
  const { blocks, eccPerBlock } = qrErrorCorrectionLayout(version, level);
  return Math.floor(qrRawDataModules(version) / 8) - eccPerBlock * blocks;
}

/** Byte-mode character-count field width: 8 bits up to version 9, 16 from version 10. */
function byteModeCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** The most bytes a byte-mode symbol of this version and level can carry. */
export function qrByteCapacity(version: number, level: QrErrorCorrection): number {
  return Math.floor((qrDataCodewords(version, level) * 8 - 4 - byteModeCountBits(version)) / 8);
}

/** Centre coordinates of the alignment patterns, the same list for rows and columns. */
export function qrAlignmentPositions(version: number): number[] {
  assertVersion(version);
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const size = version * 4 + 17;
  const result = [6];
  for (let position = size - 7; result.length < numAlign; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

/** The 15-bit format word: level and mask, BCH-protected, then XOR-masked. */
export function qrFormatBits(level: QrErrorCorrection, mask: number): number {
  const data = (FORMAT_BITS[level] << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18-bit version word, drawn twice from version 7 up. */
export function qrVersionBits(version: number): number {
  assertVersion(version);
  let remainder = version;
  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return (version << 12) | remainder;
}

// ---------------------------------------------------------------------------------------------
// Reed–Solomon over GF(2^8), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
// ---------------------------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> bit) & 1) * x;
  }
  return product;
}

/** Generator polynomial of the given degree, highest coefficient dropped (it is always 1). */
function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let term = 0; term < result.length; term += 1) {
      result[term] = gfMultiply(result[term], root);
      if (term + 1 < result.length) result[term] ^= result[term + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for one block of data codewords. */
export function qrReedSolomon(data: readonly number[], eccLength: number): number[] {
  const divisor = reedSolomonDivisor(eccLength);
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

/** Encode a string as UTF-8 bytes in byte mode. */
export function encodeQrText(text: string, options: EncodeQrOptions = {}): QrCode {
  return encodeQrBytes(new TextEncoder().encode(text), options);
}

export function encodeQrBytes(bytes: Uint8Array, options: EncodeQrOptions = {}): QrCode {
  const level = options.errorCorrection ?? "M";
  const minVersion = options.minVersion ?? QR_MIN_VERSION;
  const maxVersion = options.maxVersion ?? QR_MAX_VERSION;
  assertVersion(minVersion);
  assertVersion(maxVersion);
  if (minVersion > maxVersion) {
    throw new RangeError(`minVersion ${minVersion} is above maxVersion ${maxVersion}.`);
  }
  if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) {
    throw new RangeError(`A QR mask is 0 to 7 — got ${options.mask}.`);
  }

  let version = minVersion;
  while (bytes.length > qrByteCapacity(version, level)) {
    if (version >= maxVersion) {
      throw new RangeError(
        `${bytes.length} bytes do not fit a level-${level} QR code up to version ${maxVersion} ` +
          `(it holds ${qrByteCapacity(maxVersion, level)}).`,
      );
    }
    version += 1;
  }

  const dataCodewords = buildDataCodewords(bytes, version, level);
  const allCodewords = addErrorCorrectionAndInterleave(dataCodewords, version, level);
  return drawSymbol(allCodewords, version, level, options.mask);
}

function buildDataCodewords(bytes: Uint8Array, version: number, level: QrErrorCorrection): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };

  append(0b0100, 4);
  append(bytes.length, byteModeCountBits(version));
  for (const byte of bytes) append(byte, 8);

  const capacityBits = qrDataCodewords(version, level) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index + bit];
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/**
 * Split into blocks, append each block's error correction, and interleave.
 *
 * When the codewords do not divide evenly the LAST blocks are one data codeword longer. Reading
 * across the blocks column by column skips the short blocks at that extra position, which is why
 * a placeholder is pushed into each short block and then left out.
 */
function addErrorCorrectionAndInterleave(
  data: readonly number[],
  version: number,
  level: QrErrorCorrection,
): number[] {
  const { blocks: numBlocks, eccPerBlock } = qrErrorCorrectionLayout(version, level);
  const rawCodewords = Math.floor(qrRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  for (let index = 0, offset = 0; index < numBlocks; index += 1) {
    const length = shortBlockLength - eccPerBlock + (index < numShortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = qrReedSolomon(block, eccPerBlock);
    if (index < numShortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }

  const result: number[] = [];
  for (let column = 0; column < blocks[0].length; column += 1) {
    blocks.forEach((block, index) => {
      if (column !== shortBlockLength - eccPerBlock || index >= numShortBlocks) {
        result.push(block[column]);
      }
    });
  }
  return result;
}

type Canvas = {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
};

function drawSymbol(
  codewords: readonly number[],
  version: number,
  level: QrErrorCorrection,
  forcedMask: number | undefined,
): QrCode {
  const size = version * 4 + 17;
  const canvas: Canvas = {
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    size,
  };

  drawFunctionPatterns(canvas, version, level);
  drawCodewords(canvas, codewords);

  let mask = forcedMask ?? -1;
  if (mask === -1) {
    let lowest = Infinity;
    for (let candidate = 0; candidate < 8; candidate += 1) {
      applyMask(canvas, candidate);
      drawFormatBits(canvas, level, candidate);
      const penalty = penaltyScore(canvas);
      if (penalty < lowest) {
        mask = candidate;
        lowest = penalty;
      }
      applyMask(canvas, candidate); // XOR again to undo
    }
  }
  applyMask(canvas, mask);
  drawFormatBits(canvas, level, mask);

  return { errorCorrection: level, mask, modules: canvas.modules, size, version };
}

function setFunctionModule(canvas: Canvas, x: number, y: number, dark: boolean): void {
  canvas.modules[y][x] = dark;
  canvas.isFunction[y][x] = true;
}

function drawFunctionPatterns(canvas: Canvas, version: number, level: QrErrorCorrection): void {
  const { size } = canvas;

  for (let index = 0; index < size; index += 1) {
    setFunctionModule(canvas, 6, index, index % 2 === 0);
    setFunctionModule(canvas, index, 6, index % 2 === 0);
  }

  // Finder patterns with their light separators, clipped at the symbol's edge.
  for (const [centreX, centreY] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = centreX + dx;
        const y = centreY + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunctionModule(canvas, x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  // Alignment patterns, except the three that would sit on a finder pattern.
  const positions = qrAlignmentPositions(version);
  const count = positions.length;
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      const onFinder =
        (row === 0 && column === 0) || (row === 0 && column === count - 1) || (row === count - 1 && column === 0);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunctionModule(
            canvas,
            positions[row] + dx,
            positions[column] + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }

  // Reserve the format areas now (mask 0 as a placeholder); the real word is drawn after masking.
  drawFormatBits(canvas, level, 0);

  if (version >= 7) {
    const bits = qrVersionBits(version);
    for (let index = 0; index < 18; index += 1) {
      const dark = getBit(bits, index);
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      setFunctionModule(canvas, a, b, dark);
      setFunctionModule(canvas, b, a, dark);
    }
  }
}

function drawFormatBits(canvas: Canvas, level: QrErrorCorrection, mask: number): void {
  const { size } = canvas;
  const bits = qrFormatBits(level, mask);

  // First copy, wrapped around the top-left finder.
  for (let index = 0; index <= 5; index += 1) setFunctionModule(canvas, 8, index, getBit(bits, index));
  setFunctionModule(canvas, 8, 7, getBit(bits, 6));
  setFunctionModule(canvas, 8, 8, getBit(bits, 7));
  setFunctionModule(canvas, 7, 8, getBit(bits, 8));
  for (let index = 9; index < 15; index += 1) setFunctionModule(canvas, 14 - index, 8, getBit(bits, index));

  // Second copy, split between the top-right and bottom-left finders.
  for (let index = 0; index < 8; index += 1) setFunctionModule(canvas, size - 1 - index, 8, getBit(bits, index));
  for (let index = 8; index < 15; index += 1) setFunctionModule(canvas, 8, size - 15 + index, getBit(bits, index));
  setFunctionModule(canvas, 8, size - 8, true); // the dark module, always dark
}

/** Two columns at a time from the right, snaking up and down, stepping over the vertical timing line. */
function drawCodewords(canvas: Canvas, codewords: readonly number[]): void {
  const { size } = canvas;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (!canvas.isFunction[y][x] && bitIndex < totalBits) {
          canvas.modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex += 1;
        }
        // Modules past the last codeword are the remainder bits and stay light.
      }
    }
  }
}

/** The eight mask conditions of §7.8.2, `x` the column and `y` the row. */
export function qrMaskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError(`A QR mask is 0 to 7 — got ${mask}.`);
  }
}

function applyMask(canvas: Canvas, mask: number): void {
  const { size } = canvas;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!canvas.isFunction[y][x] && qrMaskApplies(mask, x, y)) {
        canvas.modules[y][x] = !canvas.modules[y][x];
      }
    }
  }
}

function penaltyScore(canvas: Canvas): number {
  const { modules, size } = canvas;
  let result = 0;

  const addHistory = (runLength: number, history: number[]) => {
    const length = history[0] === 0 ? runLength + size : runLength; // light border before the first run
    history.pop();
    history.unshift(length);
  };
  const countFinderLike = (history: readonly number[]) => {
    const unit = history[1];
    const core =
      unit > 0 && history[2] === unit && history[3] === unit * 3 && history[4] === unit && history[5] === unit;
    return (
      (core && history[0] >= unit * 4 && history[6] >= unit ? 1 : 0) +
      (core && history[6] >= unit * 4 && history[0] >= unit ? 1 : 0)
    );
  };
  const terminate = (runDark: boolean, runLength: number, history: number[]) => {
    let length = runLength;
    if (runDark) {
      addHistory(length, history);
      length = 0;
    }
    addHistory(length + size, history); // light border after the last run
    return countFinderLike(history);
  };

  for (const axis of ["row", "column"] as const) {
    for (let line = 0; line < size; line += 1) {
      let runDark = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let index = 0; index < size; index += 1) {
        const dark = axis === "row" ? modules[line][index] : modules[index][line];
        if (dark === runDark) {
          runLength += 1;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result += 1;
        } else {
          addHistory(runLength, history);
          if (!runDark) result += countFinderLike(history) * PENALTY_N3;
          runDark = dark;
          runLength = 1;
        }
      }
      result += terminate(runDark, runLength, history) * PENALTY_N3;
    }
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const dark = modules[y][x];
      if (dark === modules[y][x + 1] && dark === modules[y + 1][x] && dark === modules[y + 1][x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let darkCount = 0;
  for (const row of modules) for (const dark of row) if (dark) darkCount += 1;
  const total = size * size;
  const deviation = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  result += deviation * PENALTY_N4;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

/**
 * One SVG path covering every dark module, offset by the quiet zone.
 *
 * Horizontal runs are merged into a single rectangle each, which keeps a version-16 enrollment code
 * to a few kilobytes of path data. Pair it with `viewBox="0 0 {size + 2 × border} …"` and
 * `shape-rendering="crispEdges"` so the modules land on whole pixels.
 */
export function qrSvgPath(code: QrCode, border: number = QR_QUIET_ZONE): string {
  if (!Number.isInteger(border) || border < 0) {
    throw new RangeError(`The quiet zone is a whole number of modules — got ${border}.`);
  }
  const parts: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    let x = 0;
    while (x < code.size) {
      if (!code.modules[y][x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < code.size && code.modules[y][x]) x += 1;
      parts.push(`M${start + border},${y + border}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join("");
}
