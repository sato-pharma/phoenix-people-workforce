/**
 * The DESIGN fingerprint of the two weekly workbooks the owner locked behind a password.
 *
 * Owner instruction, 2026-09-08: *"template design never change unless set this password"*, naming
 * the weekly BI export and the NSM/DSM export. Tonight both already had design pins living inside
 * their test files, which anyone could edit; this module is the half that makes the pin a LOCK —
 * the fingerprints move to a committed JSON file that only `scripts/weekly-export-design-unlock.ts`
 * rewrites, and it will not rewrite it without the password.
 *
 * WHY THIS IS A SHARED MODULE AND NOT TWO COPIES. The test asserts the emitted workbook against the
 * pins, and the unlock script writes the pins from the emitted workbook. If those two computed the
 * fingerprint even slightly differently, unlocking would produce a file the test rejects — a lock
 * that cannot be legitimately opened is as broken as one that never closes. One function, both
 * callers.
 *
 * WHAT IS FINGERPRINTED is the design and nothing else: the sheet set with its order and
 * visibility, every column width, row height, merge, freeze pane, autofilter and conditional
 * format, the style index on every cell, the whole style table, and the chart inventory. Cell
 * VALUES and FORMULAS are stripped, deliberately — a corrected number or a re-worded label is not a
 * design change and must not need the owner's password.
 *
 * DETERMINISM IS A REQUIREMENT, NOT A HOPE. Both fixtures are fixed, and the fingerprints were
 * confirmed identical across repeated builds and across separate processes before being pinned. A
 * fingerprint that drifts on its own would turn the required CI check into a coin toss and train
 * everyone to re-pin on red, which is exactly the habit this lock exists to prevent.
 */
import { createHash } from "node:crypto";

import JSZip from "jszip";

/** Strip data, keep structure — including the `s=` style index, which is how a restyle shows up. */
function sheetDesign(xml: string): string {
  return xml
    .replace(/<v>[\s\S]*?<\/v>/g, "<v/>")
    .replace(/<is>[\s\S]*?<\/is>/g, "<is/>")
    .replace(/<f[^>]*>[\s\S]*?<\/f>/g, "<f/>")
    .replace(/<f[^>]*\/>/g, "<f/>");
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

export type DesignFingerprint = {
  charts: string;
  sheets: { name: string; state: string; design: string }[];
  styles: string;
};

/** The design fingerprint of an emitted .xlsx package. */
export async function designFingerprint(buffer: Buffer): Promise<DesignFingerprint> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const index = [...workbookXml.matchAll(/<sheet\b[^>]*\/>/g)].map((match) => ({
    name: /name="([^"]*)"/.exec(match[0])?.[1] ?? "?",
    state: /state="([^"]*)"/.exec(match[0])?.[1] ?? "visible",
  }));

  const sheets: DesignFingerprint["sheets"] = [];
  for (let position = 0; position < index.length; position += 1) {
    const part = await zip.file(`xl/worksheets/sheet${position + 1}.xml`)?.async("string");
    sheets.push({
      design: part ? digest(sheetDesign(part)) : "MISSING",
      name: index[position].name,
      state: index[position].state,
    });
  }

  const chartNames = Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name)).sort();
  const chartShapes: string[] = [];
  for (const name of chartNames) {
    const xml = (await zip.files[name].async("string")) ?? "";
    const kinds = [...new Set([...xml.matchAll(/<c:(\w+Chart)>/g)].map((match) => match[1]))].sort();
    chartShapes.push(`${name.replace("xl/charts/", "")}:${kinds.join("+")}`);
  }

  return {
    charts: `${chartNames.length} charts | ${chartShapes.join(" ")}`,
    sheets,
    styles: digest((await zip.file("xl/styles.xml")?.async("string")) ?? ""),
  };
}

/**
 * Compare two fingerprints and say what MOVED, in words a reader can act on.
 *
 * A lock that only says "different" trains people to re-pin. This names the sheet.
 */
export function describeDrift(expected: DesignFingerprint, actual: DesignFingerprint): string[] {
  const out: string[] = [];
  const shape = (f: DesignFingerprint) => f.sheets.map((s) => `${s.name} [${s.state}]`);
  if (shape(expected).join("|") !== shape(actual).join("|")) {
    out.push(
      `the SHEET SET changed — a sheet was added, removed, renamed, reordered or changed visibility.\n` +
        `      pinned: ${shape(expected).join(", ")}\n` +
        `      built : ${shape(actual).join(", ")}`,
    );
  } else {
    const moved = actual.sheets.filter((sheet, i) => expected.sheets[i]?.design !== sheet.design).map((s) => s.name);
    if (moved.length > 0) {
      out.push(
        `the LAYOUT of these sheets changed: ${moved.join(", ")} — a column width, row height, merge, ` +
          `freeze pane, autofilter, conditional format or per-cell style moved. Values and formulas are NOT pinned, ` +
          `so if you only changed a number this is not what fired.`,
      );
    }
  }
  if (expected.styles !== actual.styles) {
    out.push("the STYLE TABLE changed — a colour, font, border, fill or number format moved.");
  }
  if (expected.charts !== actual.charts) {
    out.push(`the CHARTS changed — pinned "${expected.charts}", built "${actual.charts}".`);
  }
  return out;
}
