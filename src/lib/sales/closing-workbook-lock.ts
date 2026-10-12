import { createHash, randomBytes } from "node:crypto";

import type ExcelJS from "exceljs";
import type JSZip from "jszip";

import { resolveSheetParts } from "./closing-executive-look";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING DOWNLOADS ARE READ-ONLY (owner, 2026-10-13: "lock the closing, premium or normal, that
// the SFE download, and never be able to edit any cell in any tab of the downloaded monthly closing
// sheet").
//
// Every worksheet of every closing workbook leaves the server with sheet protection on. With the
// password set, Excel asks for it before anything can be unprotected; without it, Review >
// Unprotect Sheet is one click. The password is a server secret read from
// `PHOENIX_CLOSING_LOCK_PASSWORD` -- never a constant in this repository, which would make it a
// property of the code and not of the owner.
//
// What stays usable, by his choice: scrolling, selecting, hyperlinks, the filter buttons, and on the
// premium workbook the pivot tables' expand/collapse, both Region slicers and the Rep Card's rep
// picker. Those change what is SHOWN, never a figure. What is refused: typing into or overwriting any
// cell, formatting, inserting or deleting rows and columns, and sorting (which rewrites cells).
//
// Sheet protection is a lock on the Excel UI, not encryption: it stops an edit, not a determined
// person with a zip tool. The numbers that matter are the published closing's own.
// ─────────────────────────────────────────────────────────────────────────────

/** The server secret that Excel asks for before a locked closing sheet can be unprotected. */
export const CLOSING_LOCK_PASSWORD_ENV = "PHOENIX_CLOSING_LOCK_PASSWORD";

/** Excel's own default; the hash is stretched this many times so a stolen file resists guessing. */
const SPIN_COUNT = 100_000;

/** The password this server locks closings with, or "" when none is configured. */
export function closingLockPassword(): string {
  return (process.env[CLOSING_LOCK_PASSWORD_ENV] ?? "").trim();
}

type SheetHash = { algorithmName: "SHA-512"; hashValue: string; saltValue: string; spinCount: number };

/**
 * ECMA-376 legacy-free password hash, the same one ExcelJS writes: SHA-512 over salt + the UTF-16LE
 * password, then re-hashed `spinCount` times with a little-endian iteration counter. Computed ONCE per
 * workbook and shared by every sheet, because a workbook can hold thirty sheets and a hundred
 * thousand rounds each is seconds of a request spent hashing the same word thirty times. A shared
 * salt is not a weakness here -- the sheets share one password anyway.
 */
export function hashSheetPassword(password: string): SheetHash | null {
  if (!password) return null;
  const salt = randomBytes(16);
  let key = createHash("sha512").update(Buffer.concat([salt, Buffer.from(password, "utf16le")])).digest();
  for (let i = 0; i < SPIN_COUNT; i += 1) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32LE(i, 0);
    key = createHash("sha512").update(Buffer.concat([key, counter])).digest();
  }
  return {
    algorithmName: "SHA-512",
    hashValue: key.toString("base64"),
    saltValue: salt.toString("base64"),
    spinCount: SPIN_COUNT,
  };
}

/**
 * Lock every worksheet of an ExcelJS-built closing workbook -- the normal export, the employee-portal
 * and details-only builds, and the Performance Review pack. Hidden sheets (the Calc sheet behind the
 * live formulas) are locked too: "any tab" means any tab.
 *
 * ExcelJS spells its options the opposite way round from the file format: `true` here means the
 * action is ALLOWED. Only selecting cells and the filter buttons are allowed; sorting is not,
 * because a sort rewrites the cells.
 */
export function lockExcelWorkbook(workbook: ExcelJS.Workbook, options: { password?: string } = {}): number {
  const hash = hashSheetPassword(options.password ?? closingLockPassword());
  for (const sheet of workbook.worksheets) {
    (sheet as unknown as { sheetProtection: unknown }).sheetProtection = {
      ...(hash ?? {}),
      autoFilter: true,
      objects: false,
      scenarios: false,
      selectLockedCells: true,
      selectUnlockedCells: true,
      sheet: true,
    };
  }
  return workbook.worksheets.length;
}

function protectionElement(hash: SheetHash | null): string {
  const secret = hash
    ? ` algorithmName="${hash.algorithmName}" hashValue="${hash.hashValue}" saltValue="${hash.saltValue}" spinCount="${hash.spinCount}"`
    : "";
  // `sheet="1"` switches protection on. `autoFilter="0"` and `pivotTables="0"` are the two ALLOWED
  // actions (the file format's default is locked); every other action stays at its locked default,
  // and `objects` is left unprotected so the Region slicers and the owner's macro buttons stay
  // clickable -- a shape is not a cell.
  return `<sheetProtection${secret} sheet="1" autoFilter="0" pivotTables="0"/>`;
}

/**
 * Lock every sheet of the premium engine, in place in the zip. ExcelJS cannot be used here -- it
 * drops pivot tables, slicers and VBA -- so the element is written straight into each sheet part,
 * in the one place the schema allows it: after `sheetData` (and after `sheetCalcPr` when present),
 * before `autoFilter`, `mergeCells`, `conditionalFormatting` and `dataValidations`.
 *
 * `unlockedCells` names cells that stay editable (the Rep Card's rep picker). Each one is given the
 * unlocked style by the caller before this runs; this function only locks the sheet.
 */
export async function lockEngineWorkbook(
  zip: JSZip,
  options: { password?: string; sheetParts?: Map<string, string> } = {},
): Promise<string[]> {
  const hash = hashSheetPassword(options.password ?? closingLockPassword());
  const element = protectionElement(hash);
  const parts = options.sheetParts ?? (await resolveSheetParts(zip));
  const locked: string[] = [];
  for (const [sheetName, part] of parts) {
    const file = zip.file(part);
    if (!file) continue;
    let xml = await file.async("string");
    xml = xml.replace(/<sheetProtection\b[^>]*?\/>/g, "");
    const afterData = /<\/sheetData>|<sheetData\s*\/>/.exec(xml);
    if (!afterData) continue;
    let at = afterData.index + afterData[0].length;
    const calc = /^\s*<sheetCalcPr\b[^>]*?\/>/.exec(xml.slice(at));
    if (calc) at += calc[0].length;
    zip.file(part, `${xml.slice(0, at)}${element}${xml.slice(at)}`);
    locked.push(sheetName);
  }
  return locked;
}

/**
 * Leave named cells editable on an engine sheet that is otherwise locked. Used for exactly one cell:
 * the Rep Card's rep picker, `B5`, a list-validated dropdown that changes WHICH rep the card shows and
 * never a number. It is given a copy of its own style with `locked="0"`, so the cells that merely
 * share its look stay locked.
 *
 * Runs after every pass that renumbers styles: the sheet lock is a sheet-level switch, but the
 * per-cell flag lives in the style, so a later renumbering would point the picker at the wrong xf.
 */
export async function unlockEngineCells(
  zip: JSZip,
  sheetPart: string,
  refs: string[],
): Promise<string[]> {
  const sheetFile = zip.file(sheetPart);
  const stylesFile = zip.file("xl/styles.xml");
  if (!sheetFile || !stylesFile) return [];
  let sheet = await sheetFile.async("string");
  let styles = await stylesFile.async("string");

  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  if (!block) return [];
  const xfs = [...block[1]!.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)].map((one) => one[0]);

  const unlocked: string[] = [];
  const clones = new Map<number, number>();
  for (const ref of refs) {
    const cell = new RegExp(`<c r="${ref}"[^>]*>`).exec(sheet);
    if (!cell) continue;
    const from = Number(/\ss="(\d+)"/.exec(cell[0])?.[1] ?? 0);
    const source = xfs[from];
    if (!source) continue;
    let to = clones.get(from);
    if (to === undefined) {
      const open = /^<xf\b[^>]*?(\/?)>/.exec(source)!;
      const head = open[0].replace(/\s*\/?>$/, "").replace(/\sapplyProtection="\d"/, "");
      const inner = open[1] ? "" : source.slice(open[0].length, source.lastIndexOf("</xf>"));
      const kept = inner.replace(/<protection\b[^>]*?\/>/g, "");
      const cut = kept.search(/<extLst\b/);
      const withProtection = cut === -1
        ? `${kept}<protection locked="0"/>`
        : `${kept.slice(0, cut)}<protection locked="0"/>${kept.slice(cut)}`;
      to = xfs.length;
      xfs.push(`${head} applyProtection="1">${withProtection}</xf>`);
      clones.set(from, to);
    }
    const tag = /\ss="\d+"/.test(cell[0])
      ? cell[0].replace(/\ss="\d+"/, ` s="${to}"`)
      : cell[0].replace(/(\/?)>$/, ` s="${to}"$1>`);
    sheet = sheet.replace(cell[0], () => tag);
    unlocked.push(ref);
  }
  if (!unlocked.length) return [];

  styles = styles.replace(
    /<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/,
    `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>`,
  );
  zip.file("xl/styles.xml", styles);
  zip.file(sheetPart, sheet);
  return unlocked;
}
