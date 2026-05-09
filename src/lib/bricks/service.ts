import * as XLSX from "xlsx";

import { BUNDLED_BRICK_REFERENCE_AREAS, BUNDLED_BRICK_REFERENCE_LINE } from "@/lib/bricks/reference-seed";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type BrickReferenceRow = {
  area: string;
  brickNameNormalized: string;
  brickNameRaw: string;
  dsmHrId: string | null;
  line: string;
  sourceDetails: string;
  sourceFileName: string | null;
  sourceRow: number;
};

export type BrickReferenceImportSummary = {
  areas: number;
  bricks: number;
  fileName: string;
  line: string;
};

type ParsedBrickReferenceRow = {
  area: string;
  brickNameRaw: string;
  dsmHrId: string | null;
  line: string;
  sourceDetails: string;
  sourceFileName: string | null;
  sourceRow: number;
};

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeBrickText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[(){}\[\].،,:؛;"'`~!@#$%^&*_+=?|<>/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitBrickDetails(details: string) {
  const normalized = cleanText(details)
    .replace(/[؛]/g, ";")
    .replace(/[،]/g, ",")
    .replace(/\\\\/g, ";")
    .replace(/\//g, ";");

  const parts = normalized
    .split(/[;\n,]+/g)
    .map((part) => part.trim())
    .map((part) => part.replace(/^[-–—\d.]+\s*/g, "").replace(/\s*[-–—]+\s*$/g, "").trim())
    .filter(Boolean);

  return Array.from(new Set(parts));
}

function parseReferenceRows(
  rows: Array<Record<string, unknown>>,
  options: { fileName: string | null; line: string },
) {
  const parsed: ParsedBrickReferenceRow[] = [];

  rows.forEach((row, index) => {
    const dsmHrId = cleanText(row["hr id"] ?? row.hr_id ?? row.hrId ?? row["HR ID"]);
    const area = cleanText(row.Area ?? row.area);
    const details = cleanText(row["Bricks in Details"] ?? row.details ?? row.bricks);
    if (!area && !details) return;

    const bricks = splitBrickDetails(details);
    const fallbackBrick = details ? [details] : [];

    for (const brickNameRaw of (bricks.length > 0 ? bricks : fallbackBrick)) {
      parsed.push({
        area,
        brickNameRaw,
        dsmHrId: dsmHrId || null,
        line: options.line,
        sourceDetails: details,
        sourceFileName: options.fileName,
        sourceRow: index + 2,
      });
    }
  });

  const deduped = new Map<string, ParsedBrickReferenceRow>();
  parsed.forEach((row) => {
    const normalized = normalizeBrickText(row.brickNameRaw);
    if (!normalized) return;
    const key = `${row.line}::${row.area}::${normalized}`;
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  });

  return Array.from(deduped.values());
}

function bundledSeedRows() {
  return parseReferenceRows(
    BUNDLED_BRICK_REFERENCE_AREAS.map((row) => ({
      "hr id": null,
      Area: row.area,
      "Bricks in Details": row.details,
    })),
    { fileName: "Pedia line bricks refernece.xlsx", line: BUNDLED_BRICK_REFERENCE_LINE },
  ).map<BrickReferenceRow>((row) => ({
    ...row,
    brickNameNormalized: normalizeBrickText(row.brickNameRaw),
    dsmHrId: row.dsmHrId,
  }));
}

export async function listBrickReferenceRows(line?: string | null) {
  const supabase = getSupabaseAdmin();
  const normalizedLine = cleanText(line);

  try {
    let importQuery = supabase
      .from("brick_reference_imports")
      .select("id,line")
      .order("created_at", { ascending: false })
      .limit(1);

    if (normalizedLine) {
      importQuery = importQuery.ilike("line", normalizedLine);
    }

    const { data: latestImport, error: importError } = await importQuery.maybeSingle();
    if (importError) throw importError;

    if (!latestImport?.id) {
      return bundledSeedRows().filter((row) =>
        normalizedLine ? normalizeBrickText(row.line) === normalizeBrickText(normalizedLine) : true,
      );
    }

    const { data, error } = await supabase
      .from("brick_reference_rows")
      .select("line,area,brick_name_raw,brick_name_normalized,dsm_hr_id,source_details,source_file_name,source_row")
      .eq("import_id", latestImport.id)
      .order("area", { ascending: true })
      .order("brick_name_raw", { ascending: true });

    if (error) throw error;

    const rows = (data ?? []).map((row) => ({
      area: cleanText(row.area),
      brickNameNormalized: cleanText(row.brick_name_normalized),
      brickNameRaw: cleanText(row.brick_name_raw),
      dsmHrId: cleanText(row.dsm_hr_id) || null,
      line: cleanText(row.line),
      sourceDetails: cleanText(row.source_details),
      sourceFileName: cleanText(row.source_file_name) || null,
      sourceRow: Number(row.source_row ?? 0),
    }));

    return rows.length > 0
      ? rows
      : bundledSeedRows().filter((row) =>
          normalizedLine ? normalizeBrickText(row.line) === normalizeBrickText(normalizedLine) : true,
        );
  } catch {
    return bundledSeedRows().filter((row) =>
      normalizedLine ? normalizeBrickText(row.line) === normalizeBrickText(normalizedLine) : true,
    );
  }
}

export async function previewBrickReferenceWorkbook(file: File, line: string) {
  const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true, type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("Brick reference workbook has no readable sheets.");
  }

  const firstSheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: "" });
  if (rows.length === 0) {
    throw new Error("Brick reference worksheet is empty.");
  }

  const parsed = parseReferenceRows(rows, { fileName: file.name, line });
  const areaCount = new Set(parsed.map((row) => row.area).filter(Boolean)).size;

  return {
    detectedColumns: Object.keys(rows[0] ?? {}),
    fileName: file.name,
    line,
    parsedRows: parsed,
    summary: {
      areas: areaCount,
      bricks: parsed.length,
      rows: rows.length,
    },
  };
}

export async function saveBrickReferenceWorkbook(input: {
  file: File;
  line: string;
  uploadedBy: string;
}) {
  const preview = await previewBrickReferenceWorkbook(input.file, input.line);
  const supabase = getSupabaseAdmin();

  const { data: importRow, error: importError } = await supabase
    .from("brick_reference_imports")
    .insert({
      file_name: preview.fileName,
      line: input.line,
      row_count: preview.summary.rows,
      brick_count: preview.summary.bricks,
      uploaded_by: input.uploadedBy,
    })
    .select("id")
    .single();

  if (importError) throw importError;

  const rows = preview.parsedRows.map((row) => ({
    area: row.area,
    brick_name_normalized: normalizeBrickText(row.brickNameRaw),
    brick_name_raw: row.brickNameRaw,
    dsm_hr_id: row.dsmHrId,
    import_id: importRow.id,
    line: row.line,
    source_details: row.sourceDetails,
    source_file_name: preview.fileName,
    source_row: row.sourceRow,
  }));

  if (rows.length > 0) {
    const { error: rowsError } = await supabase.from("brick_reference_rows").insert(rows);
    if (rowsError) throw rowsError;
  }

  return {
    fileName: preview.fileName,
    summary: preview.summary,
  };
}
