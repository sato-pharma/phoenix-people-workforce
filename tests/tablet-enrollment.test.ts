import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { countDevicesByState, getEnterpriseProfile } from "../src/lib/devices/android-enterprise.ts";
import { AndroidManagementRequestError, CHROME_PACKAGE_NAME } from "../src/lib/devices/android-web-app.ts";
import {
  buildManagedTabletRows,
  enrollableTablets,
  imeisToRecord,
  listEnterpriseDevices,
  matchTabletToRegister,
  normalizeImei,
  normalizeSerial,
  type AmapiDevice,
  type ManagedTabletRow,
  type RegisterTablet,
} from "../src/lib/devices/managed-tablets.ts";
import {
  DEFAULT_ENROLLMENT_VALIDITY,
  ENROLLMENT_DATA_MAX_CHARS,
  LEAVE_ALL_SYSTEM_APPS_ENABLED,
  buildEnrollmentTokenRequest,
  createEnrollmentToken,
  isEnrollmentValidity,
  parseEnrollmentTokenData,
  serializeEnrollmentTokenData,
  withBuiltInAppsKept,
} from "../src/lib/devices/tablet-enrollment.ts";
import {
  CHROME_PERMISSION_GRANTS,
  POLICY_APPLICATIONS_LIMIT,
  REP_TABLET_POLICY_ID,
  REP_TABLET_RULES,
  TabletPolicyInputError,
  UPDATE_WINDOW,
  buildRepTabletPolicy,
  getRepTabletPolicy,
  lookUpPlayApp,
  ownerAppsFromPolicy,
  parsePlayStorePackageName,
  policyDrift,
  policySettingLabel,
  pushRepTabletPolicy,
  repTabletPolicyName,
  withOwnerApp,
  withoutOwnerApp,
  type LivePolicy,
  type OwnerApp,
} from "../src/lib/devices/tablet-policy.ts";
import {
  QR_QUIET_ZONE,
  encodeQrBytes,
  encodeQrText,
  qrAlignmentPositions,
  qrByteCapacity,
  qrErrorCorrectionLayout,
  qrFormatBits,
  qrRawDataModules,
  qrReedSolomon,
  qrSvgPath,
  qrVersionBits,
  type QrCode,
  type QrErrorCorrection,
} from "../src/lib/qr/qr-code.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

/**
 * Rep Tablets — the QR code a factory-fresh tablet scans, the rules it is enrolled onto, the
 * list that matches what enrolled to the custody register, and the IMEI each tablet reports, which
 * Phoenix copies into the register.
 *
 * The QR half cannot be checked by eye and cannot be checked by a phone in CI, so it is checked by
 * READING THE SYMBOL BACK with a decoder written here from ISO/IEC 18004 directly — its own map of
 * the function patterns (alignment centres typed from Annex E), its own mask formulas, its own
 * zigzag, its own GF(256). It shares no code with the encoder. Two implementations of one standard
 * agreeing is the evidence; one implementation agreeing with itself would be none.
 *
 * The known answers (capacity chart, format and version words, the Reed–Solomon example) are the
 * PUBLISHED values, typed from the standard, not recomputed from the encoder's own arithmetic.
 */

const LEVELS: readonly QrErrorCorrection[] = ["L", "M", "Q", "H"];

// ---------------------------------------------------------------------------------------------
// Published tables (ISO/IEC 18004)
// ---------------------------------------------------------------------------------------------

/** Byte-mode capacity, Table 7 — L, M, Q, H per version. */
const CAPACITY_CHART: readonly (readonly [number, number, number, number])[] = [
  [17, 14, 11, 7], [32, 26, 20, 14], [53, 42, 32, 24], [78, 62, 46, 34], [106, 84, 60, 44],
  [134, 106, 74, 58], [154, 122, 86, 64], [192, 152, 108, 84], [230, 180, 130, 98], [271, 213, 151, 119],
  [321, 251, 177, 137], [367, 287, 203, 155], [425, 331, 241, 177], [458, 362, 258, 194], [520, 412, 292, 220],
  [586, 450, 322, 250], [644, 504, 364, 280], [718, 560, 394, 310], [792, 624, 442, 338], [858, 666, 482, 382],
  [929, 711, 509, 403], [1003, 779, 565, 439], [1091, 857, 611, 461], [1171, 911, 661, 511], [1273, 997, 715, 535],
  [1367, 1059, 751, 593], [1465, 1125, 805, 625], [1528, 1190, 868, 658], [1628, 1264, 908, 698], [1732, 1370, 982, 742],
  [1840, 1452, 1030, 790], [1952, 1538, 1112, 842], [2068, 1628, 1168, 898], [2188, 1722, 1228, 958], [2303, 1809, 1283, 983],
  [2431, 1911, 1351, 1051], [2563, 1989, 1423, 1093], [2699, 2099, 1499, 1139], [2809, 2213, 1579, 1219], [2953, 2331, 1663, 1273],
];

/** Error-correction codewords per block, Table 9 — L, M, Q, H, index = version. */
const TABLE9_ECC_PER_BLOCK: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Error-correction blocks, Table 9 — L, M, Q, H, index = version. */
const TABLE9_BLOCKS: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** The 32 format words, Annex C Table C.1, masks 0–7 per level. */
const FORMAT_WORDS: Record<QrErrorCorrection, readonly string[]> = {
  L: ["111011111000100", "111001011110011", "111110110101010", "111100010011101", "110011000101111", "110001100011000", "110110001000001", "110100101110110"],
  M: ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"],
  Q: ["011010101011111", "011000001101000", "011111100110001", "011101000000110", "010010010110100", "010000110000011", "010111011011010", "010101111101101"],
  H: ["001011010001001", "001001110111110", "001110011100111", "001100111010000", "000011101100010", "000001001010101", "000110100001100", "000100000111011"],
};

/** The version words, Annex D Table D.1. */
const VERSION_WORDS: Record<number, number> = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6, 12: 0x0c762, 13: 0x0d847, 14: 0x0e60d, 15: 0x0f928,
  16: 0x10b78, 17: 0x1145d, 18: 0x12a17, 19: 0x13532, 20: 0x149a6, 21: 0x15683, 22: 0x168c9, 23: 0x177ec, 24: 0x18ec4,
  25: 0x191e1, 26: 0x1afab, 27: 0x1b08e, 28: 0x1cc1a, 29: 0x1d33f, 30: 0x1ed75, 31: 0x1f250, 32: 0x209d5, 33: 0x216f0,
  34: 0x228ba, 35: 0x2379f, 36: 0x24b0b, 37: 0x2542e, 38: 0x26a64, 39: 0x27541, 40: 0x28c69,
};

/** Alignment pattern centres, Annex E. */
const ANNEX_E_ALIGNMENT: Record<number, readonly number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
  10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
  16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106],
  25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
  29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130], 31: [6, 30, 56, 82, 108, 134],
  32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146],
  35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154], 37: [6, 28, 54, 80, 106, 132, 158],
  38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
};

// ---------------------------------------------------------------------------------------------
// An independent QR reader
// ---------------------------------------------------------------------------------------------

const GF_EXP = new Array<number>(512).fill(0);
const GF_LOG = new Array<number>(256).fill(0);
{
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    GF_EXP[power] = value;
    GF_LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power += 1) GF_EXP[power] = GF_EXP[power - 255];
}

function gfTimes(left: number, right: number): number {
  return left === 0 || right === 0 ? 0 : GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

/** A block is a codeword of the QR generator when it vanishes at α^0 … α^(ecc−1). */
function blockIsCodeword(block: readonly number[], ecc: number): boolean {
  for (let power = 0; power < ecc; power += 1) {
    const root = GF_EXP[power];
    let value = 0;
    for (const coefficient of block) value = gfTimes(value, root) ^ coefficient;
    if (value !== 0) return false;
  }
  return true;
}

/** x = column, y = row — the standard's i is the row, j the column. */
const MASK_CONDITIONS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (y + x) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (y + x) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (x, y) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (x, y) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function includedAlignmentCentres(version: number): Array<[number, number]> {
  const centres = ANNEX_E_ALIGNMENT[version];
  const last = centres.length - 1;
  const out: Array<[number, number]> = [];
  centres.forEach((cy, row) => {
    centres.forEach((cx, column) => {
      // The three corners a finder pattern already occupies.
      if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) return;
      out.push([cx, cy]);
    });
  });
  return out;
}

function functionModuleMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, width: number, height: number) => {
    for (let y = y0; y < y0 + height; y += 1) for (let x = x0; x < x0 + width; x += 1) map[y][x] = true;
  };
  mark(0, 0, 9, 9); // top-left finder, separator, both format strips
  mark(size - 8, 0, 8, 9); // top-right finder, separator, format strip
  mark(0, size - 8, 9, 8); // bottom-left finder, separator, format strip, dark module
  mark(6, 0, 1, size); // vertical timing
  mark(0, 6, size, 1); // horizontal timing
  for (const [cx, cy] of includedAlignmentCentres(version)) mark(cx - 2, cy - 2, 5, 5);
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return map;
}

function formatCopies(code: QrCode): [number, number] {
  const size = code.size;
  const first: Array<[number, number]> = [];
  for (let bit = 0; bit <= 5; bit += 1) first.push([8, bit]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let bit = 9; bit < 15; bit += 1) first.push([14 - bit, 8]);
  const second: Array<[number, number]> = [];
  for (let bit = 0; bit < 8; bit += 1) second.push([size - 1 - bit, 8]);
  for (let bit = 8; bit < 15; bit += 1) second.push([8, size - 15 + bit]);
  const read = (positions: Array<[number, number]>) =>
    positions.reduce((word, [x, y], bit) => word | ((code.modules[y][x] ? 1 : 0) << bit), 0);
  return [read(first), read(second)];
}

function versionCopies(code: QrCode): [number, number] {
  const size = code.size;
  let topRight = 0;
  let bottomLeft = 0;
  for (let bit = 0; bit < 18; bit += 1) {
    const across = size - 11 + (bit % 3);
    const down = Math.floor(bit / 3);
    if (code.modules[down][across]) topRight |= 1 << bit;
    if (code.modules[across][down]) bottomLeft |= 1 << bit;
  }
  return [topRight, bottomLeft];
}

type Decoded = { bytes: Uint8Array; level: QrErrorCorrection; mask: number };

function decodeQr(code: QrCode): Decoded {
  const { size, version } = code;
  assert.equal(size, version * 4 + 17, "a version-v symbol is 4v + 17 modules a side");
  assert.equal(code.modules.length, size);
  for (const row of code.modules) assert.equal(row.length, size);
  const dark = (x: number, y: number) => code.modules[y][x];

  // Finder patterns and their light separators.
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(dark(ox + dx, oy + dy), ring !== 2, `finder pattern at ${ox},${oy}`);
      }
    }
  }
  for (let i = 0; i < 8; i += 1) {
    assert.equal(dark(i, 7) || dark(7, i), false, "top-left separator is light");
    assert.equal(dark(size - 1 - i, 7) || dark(size - 8, i), false, "top-right separator is light");
    assert.equal(dark(i, size - 8) || dark(7, size - 1 - i), false, "bottom-left separator is light");
  }
  // Timing patterns alternate, dark on even coordinates.
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(dark(i, 6), i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(dark(6, i), i % 2 === 0, `vertical timing at ${i}`);
  }
  // Alignment patterns at the Annex E centres.
  for (const [cx, cy] of includedAlignmentCentres(version)) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        assert.equal(dark(cx + dx, cy + dy), Math.max(Math.abs(dx), Math.abs(dy)) !== 1, `alignment at ${cx},${cy}`);
      }
    }
  }
  assert.equal(dark(8, size - 8), true, "the dark module beside the bottom-left finder");

  // Format information: both copies, looked up in the published table.
  const [firstFormat, secondFormat] = formatCopies(code);
  assert.equal(firstFormat, secondFormat, "the two format copies agree");
  let level: QrErrorCorrection | null = null;
  let mask = -1;
  for (const candidate of LEVELS) {
    const index = FORMAT_WORDS[candidate].findIndex((word) => parseInt(word, 2) === firstFormat);
    if (index !== -1) {
      level = candidate;
      mask = index;
    }
  }
  assert.ok(level, `format word ${firstFormat.toString(2).padStart(15, "0")} is not in the published table`);

  if (version >= 7) {
    const [topRight, bottomLeft] = versionCopies(code);
    assert.equal(topRight, VERSION_WORDS[version], "top-right version word is the published one");
    assert.equal(bottomLeft, VERSION_WORDS[version], "bottom-left version word is the published one");
  }

  // The data region, read without the encoder's help.
  const functionMap = functionModuleMap(version);
  const bits: number[] = [];
  let upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1; // the vertical timing column is skipped whole
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [column, column - 1]) {
        if (functionMap[y][x]) continue;
        bits.push(dark(x, y) !== MASK_CONDITIONS[mask](x, y) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  assert.equal(bits.length, qrRawDataModules(version), "the encoder's raw-module count matches an independently drawn map");

  const codewords: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    codewords.push(bits.slice(offset, offset + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }

  // De-interleave into Table 9's blocks and check every block is a Reed–Solomon codeword.
  const blocks = TABLE9_BLOCKS[level][version];
  const ecc = TABLE9_ECC_PER_BLOCK[level][version];
  const shortLength = Math.floor(codewords.length / blocks);
  const shortBlocks = blocks - (codewords.length % blocks);
  const dataLengths = Array.from({ length: blocks }, (_, block) => shortLength - ecc + (block >= shortBlocks ? 1 : 0));
  const blockBytes = dataLengths.map(() => [] as number[]);
  let next = 0;
  for (let index = 0; index < Math.max(...dataLengths); index += 1) {
    for (let block = 0; block < blocks; block += 1) if (index < dataLengths[block]) blockBytes[block].push(codewords[next++]);
  }
  for (let index = 0; index < ecc; index += 1) {
    for (let block = 0; block < blocks; block += 1) blockBytes[block].push(codewords[next++]);
  }
  assert.equal(next, codewords.length, "every codeword belongs to a block");
  blockBytes.forEach((block, index) => {
    assert.ok(blockIsCodeword(block, ecc), `block ${index} of ${blocks} is not a valid Reed–Solomon codeword`);
  });
  const data = blockBytes.flatMap((block, index) => block.slice(0, dataLengths[index]));

  // One byte-mode segment, the terminator, and the 0xEC / 0x11 padding.
  let cursor = 0;
  const read = (count: number) => {
    let value = 0;
    for (let bit = 0; bit < count; bit += 1) {
      value = (value << 1) | ((data[cursor >> 3] >> (7 - (cursor & 7))) & 1);
      cursor += 1;
    }
    return value;
  };
  assert.equal(read(4), 0b0100, "byte mode");
  const count = read(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) bytes[index] = read(8);
  const capacityBits = data.length * 8;
  assert.equal(read(Math.min(4, capacityBits - cursor)), 0, "terminator");
  while (cursor % 8 !== 0) assert.equal(read(1), 0, "zero bits up to the byte boundary");
  let pad = 0xec;
  while (cursor < capacityBits) {
    assert.equal(read(8), pad, "pad codewords alternate 0xEC and 0x11");
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return { bytes, level, mask };
}

/** Deterministic bytes, so a failure reproduces. */
function testBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function runQrTests() {
  // Published Reed–Solomon example: "HELLO WORLD", 1-M, in the standard's worked example.
  assert.deepEqual(
    qrReedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
    "Reed–Solomon must reproduce the standard's HELLO WORLD error-correction codewords",
  );

  for (let version = 1; version <= 40; version += 1) {
    LEVELS.forEach((level, index) => {
      assert.equal(qrByteCapacity(version, level), CAPACITY_CHART[version - 1][index], `byte capacity ${version}-${level}`);
      assert.deepEqual(
        qrErrorCorrectionLayout(version, level),
        { blocks: TABLE9_BLOCKS[level][version], eccPerBlock: TABLE9_ECC_PER_BLOCK[level][version] },
        `Table 9 block structure ${version}-${level}`,
      );
    });
    assert.deepEqual(qrAlignmentPositions(version), ANNEX_E_ALIGNMENT[version], `Annex E alignment centres, version ${version}`);
    if (version >= 7) assert.equal(qrVersionBits(version), VERSION_WORDS[version], `version word ${version}`);
  }
  for (const level of LEVELS) {
    for (let mask = 0; mask < 8; mask += 1) {
      assert.equal(qrFormatBits(level, mask), parseInt(FORMAT_WORDS[level][mask], 2), `format word ${level}/${mask}`);
    }
  }
  assert.equal(qrRawDataModules(1), 208);
  assert.equal(qrRawDataModules(2), 359);
  assert.equal(qrRawDataModules(7), 1568);
  assert.equal(qrRawDataModules(40), 29648);

  // The smallest version that fits is chosen.
  const hello = encodeQrText("HELLO WORLD", { errorCorrection: "M" });
  assert.equal(hello.version, 1);
  assert.equal(new TextDecoder().decode(decodeQr(hello).bytes), "HELLO WORLD");

  // Every level, a spread of versions (both sides of the 8→16-bit count at version 10, the first
  // version with version words, the largest), full capacity and part-filled, every mask.
  let caseNumber = 0;
  for (const version of [1, 2, 5, 6, 7, 9, 10, 14, 21, 27, 33, 40]) {
    LEVELS.forEach((level, levelIndex) => {
      const capacity = qrByteCapacity(version, level);
      const smaller = version === 1 ? 1 : qrByteCapacity(version - 1, level) + 1;
      for (const length of new Set([capacity, smaller])) {
        caseNumber += 1;
        const mask = (version + levelIndex + length) % 8;
        const payload = testBytes(length, caseNumber);
        const code = encodeQrBytes(payload, { errorCorrection: level, mask });
        assert.equal(code.version, version, `${length} bytes at ${level} fit version ${version} exactly`);
        const decoded = decodeQr(code);
        assert.equal(decoded.level, level);
        assert.equal(decoded.mask, mask);
        assert.deepEqual(decoded.bytes, payload, `round trip ${version}-${level}, ${length} bytes, mask ${mask}`);
      }
    });
  }
  for (let mask = 0; mask < 8; mask += 1) {
    const payload = testBytes(60, 900 + mask);
    const code = encodeQrBytes(payload, { errorCorrection: "Q", mask, minVersion: 8 });
    assert.equal(code.version, 8);
    assert.deepEqual(decodeQr(code).bytes, payload, `mask ${mask} reads back`);
  }

  // A payload shaped like Google's, chosen mask and all, plus text that is not ASCII.
  const provisioning = JSON.stringify({
    "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
      "com.google.android.apps.work.clouddpc.EXTRA_ENROLLMENT_TOKEN": "TEST-ENROLLMENT-CODE",
    },
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
      "com.google.android.apps.work.clouddpc/.receivers.CloudDeviceAdminReceiver",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
      "https://play.google.com/managed/downloadManagingApp?identifier=setup",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "TEST-CHECKSUM-NOT-REAL",
    [LEAVE_ALL_SYSTEM_APPS_ENABLED]: true,
  });
  const provisioningCode = encodeQrText(provisioning);
  assert.equal(provisioningCode.errorCorrection, "M", "level M by default");
  assert.ok(provisioningCode.mask >= 0 && provisioningCode.mask <= 7);
  assert.equal(new TextDecoder().decode(decodeQr(provisioningCode).bytes), provisioning);
  // Two-, three- and four-byte UTF-8: Arabic letters, an em dash, an emoji.
  const multiByte = "Phoenix — تابلت \u{1F4F1}";
  assert.equal(new TextDecoder().decode(decodeQr(encodeQrText(multiByte)).bytes), multiByte, "UTF-8 text reads back");

  assert.throws(() => encodeQrBytes(new Uint8Array(2954), { errorCorrection: "L" }), RangeError, "past version 40 is refused");
  assert.throws(() => encodeQrText("x", { minVersion: 3, maxVersion: 2 }), RangeError);
  assert.throws(() => encodeQrText("x", { mask: 8 }), RangeError);
  assert.equal(encodeQrText("A", { minVersion: 5 }).version, 5);

  // The SVG path: one rectangle per horizontal run, offset by the quiet zone.
  const tiny: QrCode = {
    errorCorrection: "M",
    mask: 0,
    modules: [
      [true, true, false],
      [false, true, false],
      [true, false, true],
    ],
    size: 3,
    version: 1,
  };
  assert.equal(qrSvgPath(tiny, 0), "M0,0h2v1h-2zM1,1h1v1h-1zM0,2h1v1h-1zM2,2h1v1h-1z");
  assert.equal(qrSvgPath(tiny).startsWith(`M${QR_QUIET_ZONE},${QR_QUIET_ZONE}h2`), true, "the default border is the quiet zone");
  const pathArea = [...qrSvgPath(hello).matchAll(/h(\d+)v1/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  const darkModules = hello.modules.flat().filter(Boolean).length;
  assert.equal(pathArea, darkModules, "the path covers every dark module exactly once");
}

// ---------------------------------------------------------------------------------------------
// The rep tablet policy
// ---------------------------------------------------------------------------------------------

function runPolicyTests() {
  const policy = buildRepTabletPolicy([]);
  const chrome = policy.applications[0];
  assert.equal(chrome.packageName, CHROME_PACKAGE_NAME, "Chrome comes first — Phoenix runs in it");
  assert.equal(chrome.installType, "FORCE_INSTALLED");
  assert.deepEqual(
    chrome.permissionGrants,
    CHROME_PERMISSION_GRANTS.map((permission) => ({ permission, policy: "GRANT" })),
  );
  assert.deepEqual(
    [...CHROME_PERMISSION_GRANTS].sort(),
    ["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION", "android.permission.CAMERA"],
    "Chrome holds location and camera before any website asks",
  );
  assert.equal(
    policy.advancedSecurityOverrides.untrustedAppsPolicy,
    "DISALLOW_INSTALL",
    "a rep tablet must refuse apps from outside Google Play",
  );
  assert.equal(policy.advancedSecurityOverrides.developerSettings, "DEVELOPER_SETTINGS_DISABLED");
  assert.equal(policy.advancedSecurityOverrides.googlePlayProtectVerifyApps, "VERIFY_APPS_ENFORCED");
  assert.equal(policy.playStoreMode, "WHITELIST", "only the listed apps may be on a rep tablet");
  assert.equal(policy.factoryResetDisabled, true, "a rep cannot reset the tablet out of management");
  assert.equal(policy.locationMode, "LOCATION_ENFORCED");
  assert.deepEqual(policy.passwordPolicies, [{ passwordQuality: "SOMETHING", passwordScope: "SCOPE_DEVICE" }]);
  assert.deepEqual(policy.systemUpdate, { endMinutes: 300, startMinutes: 120, type: "WINDOWED" });
  assert.ok(UPDATE_WINDOW.startMinutes >= 0 && UPDATE_WINDOW.endMinutes <= 1439 && UPDATE_WINDOW.startMinutes < UPDATE_WINDOW.endMinutes);
  assert.deepEqual(policy.statusReportingSettings, { networkInfoEnabled: true, softwareInfoEnabled: true });
  assert.equal(
    policy.statusReportingSettings.networkInfoEnabled,
    true,
    "without network reporting no tablet reports its IMEI, and the custody register never gets one",
  );
  for (const dead of ["installUnknownSourcesAllowed", "debuggingFeaturesAllowed", "passwordRequirements", "addUserDisabled", "kioskCustomLauncherEnabled"]) {
    assert.equal(dead in policy, false, `${dead} is deprecated, ignored or out of scope and must not be sent`);
  }

  // The words on the page are the baseline's.
  assert.equal(REP_TABLET_RULES.length, 8);
  assert.equal(new Set(REP_TABLET_RULES.map((rule) => rule.title)).size, REP_TABLET_RULES.length);
  const updates = REP_TABLET_RULES.find((rule) => rule.title === "Updates overnight");
  assert.ok(updates?.detail.includes(`${UPDATE_WINDOW.startMinutes / 60}:00`) && updates.detail.includes(`${UPDATE_WINDOW.endMinutes / 60}:00`));
  assert.match(REP_TABLET_RULES.find((rule) => rule.title === "Only approved apps")?.detail ?? "", /camera/);
  const reports = REP_TABLET_RULES.find((rule) => rule.title === "What the tablet reports")?.detail ?? "";
  assert.match(reports, /IMEI/, "the page says the tablet reports its IMEI");
  assert.match(reports, /copies the IMEI into the custody register when the register has none/);

  // The owner's apps ride behind Chrome, deduplicated, in order.
  const owned: OwnerApp[] = [
    { installType: "FORCE_INSTALLED", packageName: "com.whatsapp" },
    { installType: "AVAILABLE", packageName: "com.google.android.apps.maps" },
    { installType: "AVAILABLE", packageName: "com.whatsapp" },
  ];
  assert.deepEqual(
    buildRepTabletPolicy(owned).applications.map((app) => [app.packageName, app.installType]),
    [
      [CHROME_PACKAGE_NAME, "FORCE_INSTALLED"],
      ["com.whatsapp", "FORCE_INSTALLED"],
      ["com.google.android.apps.maps", "AVAILABLE"],
    ],
  );
  assert.throws(() => buildRepTabletPolicy([{ installType: "AVAILABLE", packageName: "not a package" }]), TabletPolicyInputError);
  assert.throws(
    () => buildRepTabletPolicy([{ installType: "KIOSK" as unknown as OwnerApp["installType"], packageName: "com.example.app" }]),
    TabletPolicyInputError,
  );
  const tooMany = Array.from({ length: POLICY_APPLICATIONS_LIMIT }, (_, index) => ({
    installType: "AVAILABLE" as const,
    packageName: `com.example.app${index}`,
  }));
  assert.throws(() => buildRepTabletPolicy(tooMany), TabletPolicyInputError, "Chrome plus 3,000 is past Google's ceiling");

  // Editing the list.
  const added = withOwnerApp([], { installType: "AVAILABLE", packageName: "com.whatsapp" });
  assert.deepEqual(added, [{ installType: "AVAILABLE", packageName: "com.whatsapp" }]);
  assert.deepEqual(withOwnerApp(added, { installType: "FORCE_INSTALLED", packageName: "com.whatsapp" }), [
    { installType: "FORCE_INSTALLED", packageName: "com.whatsapp" },
  ]);
  assert.throws(() => withOwnerApp([], { installType: "AVAILABLE", packageName: CHROME_PACKAGE_NAME }), TabletPolicyInputError);
  assert.throws(() => withOwnerApp([], { installType: "AVAILABLE", packageName: "whatsapp" }), TabletPolicyInputError);
  assert.deepEqual(withoutOwnerApp(added, "com.whatsapp"), []);
  assert.throws(() => withoutOwnerApp(added, "com.other.app"), TabletPolicyInputError);

  // Reading the list back out of Google's copy.
  assert.deepEqual(ownerAppsFromPolicy(null), []);
  assert.deepEqual(
    ownerAppsFromPolicy({
      applications: [
        { installType: "FORCE_INSTALLED", packageName: CHROME_PACKAGE_NAME },
        { packageName: "com.whatsapp" },
        { installType: "BLOCKED", packageName: "com.facebook.katana" },
        { installType: "FORCE_INSTALLED", packageName: "com.whatsapp" },
        { installType: "FORCE_INSTALLED", packageName: "com.google.android.apps.maps" },
        "garbage",
      ],
    }),
    [
      { installType: "AVAILABLE", packageName: "com.whatsapp" },
      { installType: "FORCE_INSTALLED", packageName: "com.google.android.apps.maps" },
    ],
    "Chrome is the baseline's, an unset install type is AVAILABLE, a stranger's install type is left for drift",
  );

  // What the Super Admin pastes.
  assert.equal(parsePlayStorePackageName("https://play.google.com/store/apps/details?id=com.whatsapp&hl=en"), "com.whatsapp");
  assert.equal(parsePlayStorePackageName("http://play.google.com/store/apps/details?id=com.x.y"), "com.x.y");
  assert.equal(parsePlayStorePackageName("market://details?id=com.google.android.apps.maps"), "com.google.android.apps.maps");
  assert.equal(parsePlayStorePackageName("  com.example.app  "), "com.example.app");
  for (const refused of [
    "",
    "whatsapp",
    "https://example.com/details?id=com.evil.app",
    "https://play.google.com.evil.example/store/apps/details?id=com.evil.app",
    "https://play.google.com/store/apps",
    "https://play.google.com/store/apps/details?id=not%20a%20package",
  ]) {
    assert.throws(() => parsePlayStorePackageName(refused), TabletPolicyInputError, `refuse ${JSON.stringify(refused)}`);
  }

  // Drift: Google drops defaults and may reorder lists; neither is drift. A changed value is.
  const expected = buildRepTabletPolicy(owned);
  const live = JSON.parse(JSON.stringify(expected)) as LivePolicy & { applications: Array<Record<string, unknown>> };
  live.name = `enterprises/LC017auv4o/policies/${REP_TABLET_POLICY_ID}`;
  live.version = "7";
  live.applications.reverse();
  (live.applications.find((app) => app.packageName === CHROME_PACKAGE_NAME)?.permissionGrants as unknown[]).reverse();
  live.kioskCustomLauncherEnabled = false;
  live.cameraAccess = "CAMERA_ACCESS_UNSPECIFIED";
  assert.deepEqual(policyDrift(live, expected), [], "defaults and list order are not drift");
  assert.deepEqual(policyDrift(null, expected), []);
  assert.deepEqual(policyDrift({ ...live, playStoreMode: "BLACKLIST" }, expected), ["playStoreMode"]);
  assert.deepEqual(policyDrift({ ...live, cameraDisabled: true }, expected), ["cameraDisabled"]);
  assert.deepEqual(
    policyDrift({ ...live, applications: [...live.applications, { installType: "BLOCKED", packageName: "com.x.y" }] }, expected),
    ["applications"],
  );
  const { factoryResetDisabled: _dropped, ...withoutReset } = live;
  assert.deepEqual(policyDrift(withoutReset, expected), ["factoryResetDisabled"], "a missing TRUE is drift");
  assert.equal(policySettingLabel("passwordPolicies"), "Screen lock");
  assert.equal(policySettingLabel("cameraDisabled"), "Camera disabled");
  assert.equal(policySettingLabel(""), "A setting");

  assert.equal(repTabletPolicyName(" enterprises/LC017auv4o "), "enterprises/LC017auv4o/policies/rep-tablet");
  for (const bad of ["LC017auv4o", "enterprises/", "enterprises/LC017/policies/x"]) {
    assert.throws(() => repTabletPolicyName(bad));
  }
}

// ---------------------------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------------------------

function runEnrollmentRequestTests() {
  assert.equal(DEFAULT_ENROLLMENT_VALIDITY, "24h");
  assert.equal(isEnrollmentValidity("7d"), true);
  assert.equal(isEnrollmentValidity("2h"), false);
  assert.equal(isEnrollmentValidity("toString"), false, "an inherited property name is not a validity");

  const targeted = buildEnrollmentTokenRequest({
    enterpriseName: "enterprises/LC017auv4o",
    target: { assetTag: "PHX-TAB-0007", registerDeviceId: "0f3c-register-id" },
    validFor: "24h",
  });
  assert.equal(targeted.allowPersonalUsage, "PERSONAL_USAGE_DISALLOWED", "a rep tablet is the company's, never a work profile");
  assert.equal(targeted.policyName, "enterprises/LC017auv4o/policies/rep-tablet");
  assert.equal(targeted.duration, "86400s");
  assert.equal(targeted.oneTimeOnly, true, "a code made for one tablet works once");
  assert.deepEqual(parseEnrollmentTokenData(targeted.additionalData), {
    assetTag: "PHX-TAB-0007",
    registerDeviceId: "0f3c-register-id",
    v: 1,
  });

  const anyTablet = buildEnrollmentTokenRequest({ enterpriseName: "enterprises/LC017auv4o", target: null, validFor: "1h" });
  assert.equal(anyTablet.oneTimeOnly, false);
  assert.equal(anyTablet.duration, "3600s");
  assert.equal("additionalData" in anyTablet, false);
  assert.equal(buildEnrollmentTokenRequest({ enterpriseName: "enterprises/LC017auv4o", target: null, validFor: "7d" }).duration, "604800s");
  assert.throws(() =>
    buildEnrollmentTokenRequest({ enterpriseName: "enterprises/LC017auv4o", target: null, validFor: "90d" as unknown as "1h" }),
  );

  assert.throws(
    () => serializeEnrollmentTokenData({ assetTag: "x".repeat(ENROLLMENT_DATA_MAX_CHARS), registerDeviceId: "id" }),
    /at most 1024/,
  );
  assert.equal(parseEnrollmentTokenData(undefined), null);
  assert.equal(parseEnrollmentTokenData("not json"), null);
  assert.equal(parseEnrollmentTokenData(JSON.stringify({ registerDeviceId: "id", v: 2 })), null);
  assert.equal(parseEnrollmentTokenData(JSON.stringify({ v: 1 })), null);

  const kept = JSON.parse(withBuiltInAppsKept(JSON.stringify({ "android.app.extra.PROVISIONING_WIFI_SSID": "Office" }))) as Record<string, unknown>;
  assert.equal(
    kept[LEAVE_ALL_SYSTEM_APPS_ENABLED],
    true,
    "the QR payload must keep the tablet's built-in apps — the camera the invoice photo opens among them",
  );
  assert.equal(kept["android.app.extra.PROVISIONING_WIFI_SSID"], "Office", "Google's own keys pass through untouched");
  assert.equal(LEAVE_ALL_SYSTEM_APPS_ENABLED, "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED");
  assert.throws(() => withBuiltInAppsKept("<html>"), AndroidManagementRequestError);
  assert.throws(() => withBuiltInAppsKept("[1,2]"), AndroidManagementRequestError);
}

// ---------------------------------------------------------------------------------------------
// Talking to Google, with a fake fetch
// ---------------------------------------------------------------------------------------------

type RecordedCall = { url: string; method: string; body: string | null; authorization: string | null };

function fakeGoogle(responses: Array<{ status: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
      method: init?.method ?? "GET",
      url: String(input),
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call to ${String(input)}`);
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, impl };
}

const ENTERPRISE = "enterprises/LC017auv4o";
const API = "https://androidmanagement.googleapis.com/v1";
const connection = { enterpriseName: ENTERPRISE, token: "test-access-token" };

async function runGoogleCallTests() {
  // policies.get
  let google = fakeGoogle([{ body: { name: `${ENTERPRISE}/policies/rep-tablet`, version: "3" }, status: 200 }]);
  assert.equal((await getRepTabletPolicy(connection, google.impl))?.version, "3");
  assert.equal(google.calls[0].url, `${API}/${ENTERPRISE}/policies/rep-tablet`);
  assert.equal(google.calls[0].method, "GET");
  assert.equal(google.calls[0].authorization, "Bearer test-access-token");
  google = fakeGoogle([{ body: { error: { code: 404 } }, status: 404 }]);
  assert.equal(await getRepTabletPolicy(connection, google.impl), null, "a policy never pushed reads as none, not an error");
  google = fakeGoogle([{ body: { error: { code: 403 } }, status: 403 }]);
  await assert.rejects(getRepTabletPolicy(connection, google.impl), (error: unknown) => error instanceof AndroidManagementRequestError && error.status === 403);

  // policies.patch — the whole policy, no update mask.
  const policy = buildRepTabletPolicy([{ installType: "AVAILABLE", packageName: "com.whatsapp" }]);
  google = fakeGoogle([{ body: { ...policy, name: `${ENTERPRISE}/policies/rep-tablet`, version: "4" }, status: 200 }]);
  const pushed = await pushRepTabletPolicy({ ...connection, policy }, google.impl);
  assert.equal(pushed.version, "4");
  assert.equal(google.calls[0].method, "PATCH");
  assert.equal(google.calls[0].url, `${API}/${ENTERPRISE}/policies/rep-tablet`, "no updateMask: every field Phoenix does not send is cleared");
  assert.deepEqual(JSON.parse(google.calls[0].body ?? "null"), policy);
  google = fakeGoogle([{ body: {}, status: 200 }]);
  await assert.rejects(pushRepTabletPolicy({ ...connection, policy }, google.impl), AndroidManagementRequestError);

  // applications.get
  google = fakeGoogle([{ body: { title: " WhatsApp Messenger " }, status: 200 }]);
  assert.deepEqual(await lookUpPlayApp({ ...connection, packageName: "com.whatsapp" }, google.impl), {
    packageName: "com.whatsapp",
    title: "WhatsApp Messenger",
  });
  assert.equal(google.calls[0].url, `${API}/${ENTERPRISE}/applications/com.whatsapp?languageCode=en`);
  google = fakeGoogle([{ body: {}, status: 200 }]);
  assert.equal((await lookUpPlayApp({ ...connection, packageName: "com.whatsapp" }, google.impl))?.title, "com.whatsapp");
  google = fakeGoogle([{ body: { error: { code: 404 } }, status: 404 }]);
  assert.equal(await lookUpPlayApp({ ...connection, packageName: "com.nothing.here" }, google.impl), null);
  google = fakeGoogle([]);
  await assert.rejects(lookUpPlayApp({ ...connection, packageName: "../policies/rep-tablet" }, google.impl), TabletPolicyInputError);
  assert.equal(google.calls.length, 0, "a malformed package name never reaches Google, or the path");

  // enrollmentTokens.create
  const request = buildEnrollmentTokenRequest({ enterpriseName: ENTERPRISE, target: null, validFor: "24h" });
  google = fakeGoogle([
    {
      body: {
        expirationTimestamp: "2026-09-19T12:00:00Z",
        name: `${ENTERPRISE}/enrollmentTokens/abc`,
        oneTimeOnly: false,
        qrCode: JSON.stringify({ "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "x/.y" }),
        value: "TEST-ENROLLMENT-CODE",
      },
      status: 200,
    },
  ]);
  const created = await createEnrollmentToken({ ...connection, request }, google.impl);
  assert.equal(google.calls[0].method, "POST");
  assert.equal(google.calls[0].url, `${API}/${ENTERPRISE}/enrollmentTokens`);
  assert.deepEqual(JSON.parse(google.calls[0].body ?? "null"), request);
  assert.equal(created.enrollmentCode, "TEST-ENROLLMENT-CODE");
  assert.equal(created.expiresAt, "2026-09-19T12:00:00Z");
  assert.equal(created.oneTimeOnly, false);
  assert.equal((JSON.parse(created.qrPayload) as Record<string, unknown>)[LEAVE_ALL_SYSTEM_APPS_ENABLED], true);
  assert.equal("name" in created, false, "the token's resource name is dropped, not carried around");
  for (const incomplete of [{ value: "TEST-ENROLLMENT-CODE" }, { qrCode: "{}" }, { qrCode: "not json", value: "TEST-ENROLLMENT-CODE" }]) {
    google = fakeGoogle([{ body: incomplete, status: 200 }]);
    await assert.rejects(createEnrollmentToken({ ...connection, request }, google.impl), AndroidManagementRequestError);
  }

  // devices.list — every page, and a refusal rather than a silent cut past the cap.
  google = fakeGoogle([
    { body: { devices: [{ name: `${ENTERPRISE}/devices/1` }], nextPageToken: "page-2" }, status: 200 },
    { body: { devices: [{ name: `${ENTERPRISE}/devices/2` }] }, status: 200 },
  ]);
  const devices = await listEnterpriseDevices(connection, google.impl);
  assert.deepEqual(devices.map((device) => device.name), [`${ENTERPRISE}/devices/1`, `${ENTERPRISE}/devices/2`]);
  assert.equal(google.calls[0].url, `${API}/${ENTERPRISE}/devices?pageSize=100`);
  assert.equal(google.calls[1].url, `${API}/${ENTERPRISE}/devices?pageSize=100&pageToken=page-2`);
  google = fakeGoogle(Array.from({ length: 20 }, () => ({ body: { devices: [], nextPageToken: "more" }, status: 200 })));
  await assert.rejects(listEnterpriseDevices(connection, google.impl), /more than 2000 devices/);
}

// ---------------------------------------------------------------------------------------------
// Matching to the custody register
// ---------------------------------------------------------------------------------------------

function registerTablet(overrides: Partial<RegisterTablet> & Pick<RegisterTablet, "id" | "assetTag">): RegisterTablet {
  return {
    category: "tablet",
    holderJobTitle: "Medical Representative",
    holderName: null,
    imei: null,
    lineNumber: null,
    manufacturer: "Lenovo",
    model: "Tab M11",
    serialNumber: null,
    simNumber: null,
    status: "assigned",
    ...overrides,
  };
}

function runMatchingTests() {
  assert.equal(normalizeSerial(" hs1 a-2b3 "), "HS1A2B3");
  assert.equal(normalizeSerial("---"), null);
  assert.equal(normalizeImei("35-123456-789012-3"), "351234567890123");
  assert.equal(normalizeImei("1234"), null);

  const register: RegisterTablet[] = [
    registerTablet({ assetTag: "PHX-TAB-0001", holderName: "Mona Adel", id: "reg-1", serialNumber: "HS1-A2B3" }),
    registerTablet({ assetTag: "PHX-TAB-0002", holderName: "Karim Nabil", id: "reg-2", imei: "35123456789012", serialNumber: "HS9-Z9Z9" }),
    registerTablet({ assetTag: "PHX-LAP-0003", category: "laptop", id: "reg-3", serialNumber: "LAP-1" }),
    registerTablet({ assetTag: "PHX-TAB-0004", id: "reg-4", serialNumber: "HS4", status: "retired" }),
    registerTablet({ assetTag: "PHX-TAB-0005", holderName: null, id: "reg-5", serialNumber: "HS5", status: "in_stock" }),
  ];
  const tokenData = serializeEnrollmentTokenData({ assetTag: "PHX-TAB-0001", registerDeviceId: "reg-1" });

  const byCode: AmapiDevice = { enrollmentTokenData: tokenData, hardwareInfo: { serialNumber: "hs1a2b3" } };
  assert.deepEqual(matchTabletToRegister(byCode, register), { entry: register[0], matchedBy: "enrollment" });
  const bySerial: AmapiDevice = { hardwareInfo: { serialNumber: " hs1 a2b3 " } };
  assert.equal(matchTabletToRegister(bySerial, register)?.matchedBy, "serial");
  const byImei: AmapiDevice = { hardwareInfo: { serialNumber: "UNREGISTERED" }, networkInfo: { imei: "351234567890123" } };
  assert.deepEqual(matchTabletToRegister(byImei, register), { entry: register[1], matchedBy: "imei" }, "a register IMEI missing its check digit still matches");
  assert.equal(matchTabletToRegister({ hardwareInfo: { serialNumber: "NOBODY" } }, register), null);
  assert.equal(
    matchTabletToRegister({ enrollmentTokenData: "{\"v\":1,\"registerDeviceId\":\"gone\"}", hardwareInfo: { serialNumber: "HS9Z9Z9" } }, register)?.matchedBy,
    "serial",
    "a code for a register entry that no longer exists falls back to the serial",
  );

  const rows = buildManagedTabletRows(
    [
      {
        appliedPolicyName: `${ENTERPRISE}/policies/rep-tablet`,
        appliedPolicyVersion: "4",
        appliedState: "ACTIVE",
        enrollmentTokenData: tokenData,
        hardwareInfo: { manufacturer: "LENOVO", model: "Lenovo TB330FU", serialNumber: "HS1A2B3" },
        name: `${ENTERPRISE}/devices/ok`,
        networkInfo: { imei: "490154203237518" },
        policyCompliant: true,
        softwareInfo: { androidVersion: "14", securityPatchLevel: "2026-08-05" },
      },
      {
        appliedPolicyName: `${ENTERPRISE}/policies/rep-tablet`,
        appliedPolicyVersion: "4",
        appliedState: "ACTIVE",
        enrollmentTokenData: tokenData,
        hardwareInfo: { serialNumber: "SOMEONE-ELSES" },
        name: `${ENTERPRISE}/devices/wrong-code`,
        networkInfo: { imei: "356938035643809" },
        policyCompliant: true,
      },
      {
        appliedPolicyName: `${ENTERPRISE}/policies/rep-tablet`,
        appliedPolicyVersion: "3",
        appliedState: "ACTIVE",
        hardwareInfo: { serialNumber: "HS9Z9Z9" },
        name: `${ENTERPRISE}/devices/stale`,
        networkInfo: { imei: "351234567890123" },
        nonComplianceDetails: [
          { nonComplianceReason: "APP_NOT_INSTALLED", packageName: "com.whatsapp", settingName: "applications" },
          { nonComplianceReason: "USER_ACTION", settingName: "passwordPolicies" },
        ],
        policyCompliant: false,
      },
      {
        appliedState: "PROVISIONING",
        hardwareInfo: { serialNumber: "STRANGER" },
        name: `${ENTERPRISE}/devices/stranger`,
        networkInfo: { imei: "860000000000001" },
        policyName: `${ENTERPRISE}/policies/other`,
      },
      { appliedState: "LOST", hardwareInfo: { serialNumber: "HS5" }, name: `${ENTERPRISE}/devices/lost`, networkInfo: {} },
    ],
    register,
    { appTitles: new Map([["com.whatsapp", "WhatsApp"]]), currentPolicyVersion: "4" },
  );
  const byKey = new Map(rows.map((row) => [row.key.split("/").pop(), row] as const));

  const ok = byKey.get("ok");
  assert.equal(ok?.assetTag, "PHX-TAB-0001");
  assert.equal(ok?.holderName, "Mona Adel");
  assert.equal(ok?.matchedBy, "enrollment");
  assert.equal(ok?.model, "Lenovo TB330FU", "the maker is not repeated when the model already starts with it");
  assert.equal(ok?.policyUpToDate, true);
  assert.equal(ok?.tone, "ok");
  assert.equal(ok?.stateLabel, "Active");

  const wrong = byKey.get("wrong-code");
  assert.equal(wrong?.enrolledWithAnotherTabletsCode, true, "a tablet enrolled with another tablet's code must be flagged, not hidden");
  assert.equal(wrong?.tone, "bad");

  const stale = byKey.get("stale");
  assert.equal(stale?.assetTag, "PHX-TAB-0002");
  assert.equal(stale?.policyUpToDate, false);
  assert.deepEqual(stale?.issues, ["WhatsApp: not installed yet", "Screen lock: waiting for the rep to act on the tablet"]);
  assert.equal(stale?.tone, "warn");

  const stranger = byKey.get("stranger");
  assert.equal(stranger?.assetTag, null, "a tablet the register does not know is listed, not dropped");
  assert.equal(stranger?.onRepPolicy, false);
  assert.equal(stranger?.policyUpToDate, null);
  assert.equal(stranger?.stateLabel, "Setting up");
  assert.equal(stranger?.stateTone, "warn");

  const lost = byKey.get("lost");
  assert.equal(lost?.stateTone, "bad");
  assert.equal(lost?.tone, "bad");

  assert.deepEqual(
    rows.map((row) => row.key.split("/").pop()),
    ["wrong-code", "lost", "stale", "stranger", "ok"],
    "what needs attention first; within a tone, known tablets by asset tag, strangers last",
  );

  // The IMEI each tablet reports, against the register.
  assert.equal(ok?.imei, "490154203237518");
  assert.equal(ok?.imeiStatus, "to_record", "a tablet its serial confirms, on an entry with no IMEI, has its IMEI copied in");
  assert.equal(wrong?.imeiStatus, "held_back", "another tablet's code never puts this tablet's IMEI on that tablet's entry");
  assert.equal(stale?.imeiStatus, "in_register", "a register IMEI missing its check digit is the same IMEI");
  assert.equal(stranger?.imeiStatus, "unmatched");
  assert.equal(lost?.imei, null);
  assert.equal(lost?.imeiStatus, "none", "a tablet that reported its network and no IMEI has none — a Wi-Fi-only tablet");
  assert.deepEqual(
    imeisToRecord(rows),
    [{ assetTag: "PHX-TAB-0001", imei: "490154203237518", registerDeviceId: "reg-1" }],
    "only the confirmed tablet's IMEI is copied; the one enrolled with its code is held back, and does not block it",
  );

  assert.deepEqual(
    enrollableTablets(register, rows).map((tablet) => [tablet.assetTag, tablet.enrolled]),
    [
      ["PHX-TAB-0001", true],
      ["PHX-TAB-0002", true],
      ["PHX-TAB-0005", true],
    ],
    "tablets only, never a retired, lost or stolen one; enrolled ones marked for a re-enrollment after a reset",
  );
  assert.deepEqual(
    enrollableTablets(register, []).map((tablet) => tablet.enrolled),
    [false, false, false],
  );
}

// ---------------------------------------------------------------------------------------------
// The IMEI each tablet reports, and when Phoenix copies it into the register
// ---------------------------------------------------------------------------------------------

function runImeiTests() {
  const register: RegisterTablet[] = [
    registerTablet({ assetTag: "PHX-TAB-0101", id: "reg-a", serialNumber: "SER-A" }),
    registerTablet({ assetTag: "PHX-TAB-0102", id: "reg-b", imei: "35-209900-176148-1", serialNumber: "SER-B" }),
    registerTablet({ assetTag: "PHX-TAB-0103", id: "reg-c", serialNumber: "SER-C" }),
    registerTablet({ assetTag: "PHX-TAB-0104", id: "reg-d", serialNumber: "SER-D" }),
    registerTablet({ assetTag: "PHX-TAB-0105", id: "reg-e", imei: "  ", serialNumber: "SER-E" }),
  ];
  let count = 0;
  const tablet = (
    hardwareInfo: NonNullable<AmapiDevice["hardwareInfo"]>,
    networkInfo?: AmapiDevice["networkInfo"],
    extra: Partial<AmapiDevice> = {},
  ): AmapiDevice => {
    count += 1;
    return {
      appliedPolicyName: `${ENTERPRISE}/policies/rep-tablet`,
      appliedPolicyVersion: "4",
      appliedState: "ACTIVE",
      hardwareInfo,
      name: `${ENTERPRISE}/devices/imei-${count}`,
      policyCompliant: true,
      ...(networkInfo ? { networkInfo } : {}),
      ...extra,
    };
  };
  const rowsOf = (...devices: AmapiDevice[]) => buildManagedTabletRows(devices, register, { currentPolicyVersion: "4" });
  const only = (device: AmapiDevice): ManagedTabletRow => rowsOf(device)[0];
  const codeFor = (id: string, assetTag: string) => ({ enrollmentTokenData: serializeEnrollmentTokenData({ assetTag, registerDeviceId: id }) });

  // Already in the register — typed with dashes, and found by the IMEI alone.
  const same = only(tablet({ serialNumber: "SER-B" }, { imei: "352099001761481" }));
  assert.equal(same.imeiStatus, "in_register", "an IMEI typed with dashes is the same IMEI");
  assert.equal(same.tone, "ok");
  const foundByImei = only(tablet({ serialNumber: "NOT-IN-THE-REGISTER" }, { imei: "352099001761481" }));
  assert.equal(foundByImei.matchedBy, "imei");
  assert.equal(foundByImei.imeiStatus, "in_register");

  // A typed IMEI is never replaced: the row shows both, and a person decides.
  const differs = only(tablet({ serialNumber: "SER-B" }, { imei: "352099001761499" }));
  assert.equal(differs.imeiStatus, "register_differs");
  assert.equal(differs.registerImei, "35-209900-176148-1", "the register's IMEI is shown as it was typed");
  assert.equal(differs.imei, "352099001761499");
  assert.equal(differs.tone, "warn");
  assert.deepEqual(imeisToRecord([differs]), [], "an IMEI somebody typed is never overwritten");

  // The same IMEI on another entry: the register says this is a different tablet.
  const elsewhere = only(tablet({ serialNumber: "SER-A" }, { imei: "352099001761481" }));
  assert.equal(elsewhere.assetTag, "PHX-TAB-0101", "the serial still decides which entry it is");
  assert.equal(elsewhere.imeiStatus, "on_another_tablet");
  assert.equal(elsewhere.imeiRecordedOn, "PHX-TAB-0102");
  assert.equal(elsewhere.tone, "bad");
  assert.deepEqual(
    imeisToRecord([elsewhere]),
    [],
    "never a second entry with the same IMEI — the unique index compares the text as typed, and would let this one through",
  );

  // An IMEI of spaces is no IMEI.
  const blank = only(tablet({ serialNumber: "SER-E" }, { imei: "490154203237518" }));
  assert.equal(blank.imeiStatus, "to_record");
  assert.deepEqual(imeisToRecord([blank]), [{ assetTag: "PHX-TAB-0105", imei: "490154203237518", registerDeviceId: "reg-e" }]);

  // Nothing reported yet is not a problem with the tablet.
  const silent = only(tablet({ serialNumber: "SER-C" }));
  assert.equal(silent.imei, null);
  assert.equal(silent.imeiStatus, "not_reported");
  assert.equal(silent.tone, "ok");

  // Copied only onto an entry the tablet's own serial confirms — a code alone is not enough.
  const unconfirmed = only(tablet({ model: "TB330FU" }, { imei: "490154203237526" }, codeFor("reg-c", "PHX-TAB-0103")));
  assert.equal(unconfirmed.matchedBy, "enrollment");
  assert.equal(unconfirmed.enrolledWithAnotherTabletsCode, false, "no serial to compare is not a mix-up");
  assert.equal(unconfirmed.imeiStatus, "held_back", "an IMEI is copied only onto an entry the tablet's serial confirms");
  assert.equal(unconfirmed.tone, "warn");
  assert.deepEqual(imeisToRecord([unconfirmed]), []);
  const confirmed = only(tablet({ serialNumber: "ser c" }, { imei: "490154203237526" }, codeFor("reg-c", "PHX-TAB-0103")));
  assert.equal(confirmed.matchedBy, "enrollment");
  assert.equal(confirmed.imeiStatus, "to_record", "the code and the serial agree");

  // Two enrolled tablets that disagree: nothing is copied, and both rows say so.
  const twoImeisOneEntry = rowsOf(
    tablet({ serialNumber: "SER-D" }, { imei: "490154203237534" }),
    tablet({ serialNumber: "SER-D" }, { imei: "490154203237542" }),
  );
  assert.deepEqual(twoImeisOneEntry.map((row) => row.imeiStatus), ["contested", "contested"]);
  assert.deepEqual(twoImeisOneEntry.map((row) => row.tone), ["warn", "warn"]);
  assert.deepEqual(imeisToRecord(twoImeisOneEntry), []);
  const oneImeiTwoEntries = rowsOf(
    tablet({ serialNumber: "SER-A" }, { imei: "490154203237559" }),
    tablet({ serialNumber: "SER-C" }, { imei: "490154203237559" }),
  );
  assert.deepEqual(oneImeiTwoEntries.map((row) => row.imeiStatus), ["contested", "contested"]);
  assert.deepEqual(imeisToRecord(oneImeiTwoEntries), []);

  // The same tablet listed twice — Google keeps the old record after a reset and re-enrollment —
  // is not a conflict, and its IMEI is copied once.
  const reEnrolled = rowsOf(
    tablet({ serialNumber: "SER-A" }, { imei: "490154203237567" }),
    tablet({ serialNumber: "SER-A" }, { imei: "490154203237567" }),
  );
  assert.deepEqual(reEnrolled.map((row) => row.imeiStatus), ["to_record", "to_record"]);
  assert.deepEqual(imeisToRecord(reEnrolled), [{ assetTag: "PHX-TAB-0101", imei: "490154203237567", registerDeviceId: "reg-a" }]);
}

// ---------------------------------------------------------------------------------------------
// The doors: routes, page, registry, and what the credential may never touch
// ---------------------------------------------------------------------------------------------

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

function runDoorTests() {
  const approve = { action: "approve", resource: "company_devices" };
  assert.deepEqual(findAccessRegistryEntry("/api/devices/tablets", "GET")?.permission, approve);
  for (const route of ["/api/devices/tablets/policy", "/api/devices/tablets/enrollment", "/api/devices/tablets/imei", "/api/devices/tablets/usb"]) {
    const entry = findAccessRegistryEntry(route, "POST");
    assert.equal(entry?.pattern, route, `${route} has its own entry`);
    assert.deepEqual(entry?.permission, approve);
    assert.equal(entry?.csrf.required, true);
    assert.equal(entry?.audit.required, true);
    assert.equal(entry?.audit.classification, "mutation");
  }

  const routes = {
    enrollment: source("app/api/devices/tablets/enrollment/route.ts"),
    imei: source("app/api/devices/tablets/imei/route.ts"),
    policy: source("app/api/devices/tablets/policy/route.ts"),
    read: source("app/api/devices/tablets/route.ts"),
    usb: source("app/api/devices/tablets/usb/route.ts"),
  };
  for (const [name, text] of Object.entries(routes)) {
    assert.match(text, /assertPermission\(access, "company_devices", "approve"\)/, `${name} route asserts approve`);
  }
  for (const text of [routes.enrollment, routes.imei, routes.policy, routes.usb]) {
    assert.match(text, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);
  }
  assert.match(routes.enrollment, /"cache-control": "no-store"/, "the enrollment code must not be cached between Phoenix and the browser");
  assert.doesNotMatch(
    routes.imei,
    /request\.(json|text|formData|arrayBuffer|blob)\(|searchParams/,
    "the IMEI copy takes nothing from the browser — which IMEI goes onto which entry is decided on the server",
  );

  const page = source("app/(admin)/devices/tablets/page.tsx");
  assert.match(page, /canAccess\(access, "company_devices", "approve"\)/);
  assert.match(page, /redirect\("\/hr\/devices"\)/);

  // The audit row for a code records the tablet and the expiry — never the code.
  const service = source("src/lib/devices/rep-tablets-service.ts");
  const tokenAuditStart = service.lastIndexOf("writeRequiredAuditLog({", service.indexOf('"android_enrollment_token"'));
  const tokenAudit = service.slice(tokenAuditStart, service.indexOf("});", tokenAuditStart));
  assert.ok(tokenAuditStart !== -1 && tokenAudit.includes('"android_enrollment_token"'));
  assert.doesNotMatch(tokenAudit, /enrollmentCode|qrPayload|\.\.\.created|request\b/, "the enrollment audit row must never hold the code");

  // The one register write whose value nobody typed: never over an IMEI, audited first, conditional.
  assert.match(service, /imeisToRecord\(rows\)/, "which IMEIs are copied is decided by imeisToRecord, on the server");
  const register = source("src/lib/devices/service.ts");
  const copyStart = register.indexOf("export async function recordReportedImei(");
  const copy = register.slice(copyStart, register.indexOf("\nexport ", copyStart + 1));
  const leaveAlone = copy.indexOf("if (trimmed(row.imei)) return false;");
  const audited = copy.indexOf("writeRequiredAuditLog({");
  const updated = copy.indexOf(".update(");
  assert.ok(copyStart !== -1 && leaveAlone !== -1, "an entry that already holds an IMEI is left as it is");
  assert.ok(audited !== -1 && leaveAlone < audited, "it is left alone before anything is written");
  assert.ok(updated !== -1 && audited < updated, "the audit row is written before the register changes");
  assert.match(copy, /update\.is\("imei", null\)/, "the write lands only on an entry still holding no IMEI");
  assert.match(copy, /update\.eq\("imei", row\.imei\)/);
  assert.doesNotMatch(copy, /\.upsert\(|\.insert\(/);

  const consoleSource = source("src/components/devices/rep-tablets-console.tsx");
  assert.doesNotMatch(consoleSource, /dangerouslySetInnerHTML|innerHTML|appendChild|insertBefore/, "React draws the QR; nothing writes into the page behind it");
  assert.doesNotMatch(consoleSource, /localStorage|sessionStorage|indexedDB/, "the code is never stored in the browser");
  // THE QR DRAWING MOVED to `src/components/devices/qr-image.tsx` on 2026-09-25, when ManageEngine
  // enrollment arrived and needed the same symbol. Both guards follow it there, and the console must
  // not have kept a second copy behind to drift from it.
  const qrImageSource = source("src/components/devices/qr-image.tsx");
  assert.match(qrImageSource, /qrSvgPath\(/, "the symbol is drawn by React, from Phoenix's own encoder");
  assert.doesNotMatch(qrImageSource, /dangerouslySetInnerHTML|innerHTML|appendChild|insertBefore/);
  assert.doesNotMatch(qrImageSource, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(
    consoleSource,
    /function QrImage\(|function saveQrImage\(/,
    "one copy of the QR drawing, not two that can drift",
  );
  // WHOLE STATEMENTS, not lines. A type import wide enough to wrap is still a type import, and
  // reading this one line at a time called the second line of one a value import (2026-09-25).
  for (const statement of consoleSource.match(/^import[\s\S]*?;$/gm) ?? []) {
    if (!/from "@\/lib\/devices\//.test(statement)) continue;
    assert.match(
      statement,
      /^import type /,
      `a client component takes only TYPES from the server-side device modules: ${statement.replace(/\s+/g, " ")}`,
    );
  }
  assert.doesNotMatch(consoleSource, /\brounded\b|rounded-|\btruncate\b|text-ellipsis|overflow-x-auto/);
  assert.match(consoleSource, /requestJson<ImeiRecordResult>\("\/api\/devices\/tablets\/imei", \{\}\)/, "the page asks for the IMEI copy by itself");
  assert.match(
    consoleSource,
    /imeiAsked\.current\.has\(id\)/,
    "once per register entry per visit — a copy that fails is shown, never retried in a loop",
  );

  for (const file of [
    "src/lib/qr/qr-code.ts",
    "src/lib/devices/tablet-policy.ts",
    "src/lib/devices/tablet-enrollment.ts",
    "src/lib/devices/managed-tablets.ts",
    "src/lib/devices/rep-tablets-service.ts",
    "src/lib/devices/rep-tablets-http.ts",
    "app/api/devices/tablets/route.ts",
    "app/api/devices/tablets/policy/route.ts",
    "app/api/devices/tablets/enrollment/route.ts",
    "app/api/devices/tablets/imei/route.ts",
    "app/api/devices/tablets/usb/route.ts",
    "src/lib/devices/tablet-auto-register.ts",
    "src/components/devices/rep-tablets-console.tsx",
    "src/components/devices/qr-image.tsx",
  ]) {
    assert.doesNotMatch(source(file), /\bconsole\.(log|info|warn|error|debug)\(/, `${file} logs nothing — an enrollment code must never reach a log`);
  }
}

// ---------------------------------------------------------------------------------------------
// The enterprise itself, and its device count
// ---------------------------------------------------------------------------------------------

/**
 * WHAT THIS PINS. The page shows which Google enterprise the fleet is, and how many tablets Google
 * holds under it — the number a refusal that speaks of a limit has to be read against.
 *
 * 🔴 THE COUNT IS EVERY STATE, AND IT SURVIVES A FAILED `enterprises.get`. Counting only working
 * tablets would answer a limit question with a smaller number than Google's own, and letting the
 * display-name call fail the page would answer it with no number at all. Both are asserted here.
 */
async function runEnterpriseTests() {
  let google = fakeGoogle([
    {
      body: {
        contactInfo: { contactEmail: "phoenixx.oag@gmail.com" },
        enterpriseDisplayName: "Sato Pharma",
        enterpriseType: "MANAGED_GOOGLE_PLAY_ACCOUNTS_ENTERPRISE",
        name: ENTERPRISE,
      },
      status: 200,
    },
  ]);
  let profile = await getEnterpriseProfile(connection, google.impl);
  assert.equal(google.calls[0].url, `${API}/${ENTERPRISE}`);
  assert.equal(google.calls[0].method, "GET");
  assert.equal(google.calls[0].authorization, "Bearer test-access-token");
  assert.equal(profile.displayName, "Sato Pharma");
  assert.equal(profile.contactEmail, "phoenixx.oag@gmail.com");
  assert.equal(
    profile.kind,
    "Managed Google Play Accounts — created by Phoenix itself",
    "the kind decides which Google limits apply, so it is shown in words, not as a shouted constant",
  );

  // An older enterprise answers only the per-kind field. Reading it keeps the line from going blank.
  google = fakeGoogle([
    { body: { enterpriseType: "ENTERPRISE_TYPE_UNSPECIFIED", managedGoogleDomainType: "TYPE_TEAM" }, status: 200 },
  ]);
  profile = await getEnterpriseProfile(connection, google.impl);
  assert.equal(profile.kind, "Bound to a Google Workspace domain");

  // Proto3 drops defaults: an enterprise that set none of it still answers, with the binding intact.
  google = fakeGoogle([{ body: {}, status: 200 }]);
  profile = await getEnterpriseProfile(connection, google.impl);
  assert.deepEqual(profile, { contactEmail: null, displayName: null, kind: null, name: ENTERPRISE });

  google = fakeGoogle([{ body: { error: { code: 403 } }, status: 403 }]);
  await assert.rejects(
    getEnterpriseProfile(connection, google.impl),
    (error: unknown) => error instanceof AndroidManagementRequestError && error.status === 403,
    "the module throws; the PAGE is what decides a failed read costs a display name and not the count",
  );

  const states = countDevicesByState([
    { state: "ACTIVE" },
    { state: "ACTIVE" },
    { state: "DELETED" },
    { state: "PROVISIONING" },
    { state: "SOMETHING_NEW" },
    {},
  ]);
  assert.deepEqual(states, [
    { count: 2, label: "Working" },
    { count: 1, label: "SOMETHING_NEW" },
    { count: 1, label: "STATE_NOT_REPORTED" },
    { count: 1, label: "Still setting up" },
    { count: 1, label: "Wiped and removed" },
  ]);
  assert.equal(
    states.reduce((total, row) => total + row.count, 0),
    6,
    "every device is counted somewhere — a state with no word for it is shown as Google spells it, never dropped",
  );
  assert.deepEqual(countDevicesByState([]), [], "an empty fleet shows no rows of zeroes");

  const service = source("src/lib/devices/rep-tablets-service.ts");
  assert.match(
    service,
    /deviceCount: devices\.length/,
    "the count is the whole device list — no state filter, or it would answer a limit question with a smaller number than Google's own",
  );
  assert.match(
    service,
    /getEnterpriseProfile\(connection\)\.catch\(/,
    "a failed enterprises.get costs the page a display name, never the device count beside it",
  );

  const consoleSource = source("src/components/devices/rep-tablets-console.tsx");
  assert.match(consoleSource, /<EnterpriseSection enterprise=\{data\.enterprise\}/, "the page shows the enterprise");
  assert.match(consoleSource, /Tablets Google holds/);
}

export async function runTabletEnrollmentTests() {
  runQrTests();
  runPolicyTests();
  runEnrollmentRequestTests();
  await runGoogleCallTests();
  await runEnterpriseTests();
  runMatchingTests();
  runImeiTests();
  runDoorTests();
}
