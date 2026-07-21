// Weekly Sales — pre-upload AI verification.
//
// Reads ONLY the header row of the uploaded workbook(s) and compares it against the per-distributor
// column contract (column-contract.ts), so the operator can see exactly which data the engine will
// take from which column BEFORE committing to the upload. An OpenAI call judges each pinned column
// for "drift" (a renamed/moved header), but the verdict math is recomputed server-side — the AI is
// never trusted to gate anything.
//
// PRIVACY: only column HEADER TEXT leaves the server (product/branch column titles, and for PS the
// outlet/location names that are themselves the headers). No sales numbers, quantities, or data rows
// are ever sent — mirrors the privacy posture of src/lib/sales/normalizer/ai-suggest.ts.
//
// PRODUCTION SAFETY: when no AI key is configured (e.g. a preview without OPENAI_API_KEY) or the AI
// call fails, this NEVER throws — it returns the deterministic column plan with aiUsed=false so the
// operator can still review and verify manually. An AI outage must not freeze the upload flow.

import ExcelJS from "exceljs";

import { resolveAiProvider, type AiProvider } from "@/lib/sales/ai/provider";
import { recordAiCall } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";
import { type WeeklyContractSheet } from "@/lib/sales/weekly/column-contract";
import { resolveWeeklyContract } from "@/lib/sales/weekly/weekly-column-profile-store";
import { weeklyDistributorByCode } from "@/lib/sales/weekly/distributors";
import type { WeeklyVerifyColumn, WeeklyVerifyMatrix, WeeklyVerifyResult } from "@/lib/sales/weekly/types";

// ── AI provider resolution (shared with src/lib/sales/ai/provider.ts) ──────────────────────────────
// ai-verify uses the shared "mini" model defaults exactly, so it delegates straight to resolveAiProvider.
function resolveProvider(): AiProvider | null {
  return resolveAiProvider();
}

/** True when an AI key is configured — the route surfaces this so the UI can label the mode. */
export function hasWeeklyVerifyAi(): boolean {
  return resolveProvider() !== null;
}

// ── cell / sheet helpers (mirror parser.ts) ───────────────────────────────────────────────────────
function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const value = cell.value as unknown;
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as { result?: unknown; text?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

function findSheet(workbook: ExcelJS.Workbook, sheet: WeeklyContractSheet): ExcelJS.Worksheet | undefined {
  if (sheet.sheetName) {
    const exact = workbook.worksheets.find((ws) => ws.name.trim().toLowerCase() === sheet.sheetName!.toLowerCase());
    if (exact) return exact;
  }
  if (sheet.sheetIncludes) {
    const partial = workbook.worksheets.find((ws) => ws.name.toLowerCase().includes(sheet.sheetIncludes!.toLowerCase()));
    if (partial) return partial;
  }
  return workbook.worksheets[0];
}

async function loadWorkbook(buffer: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

export type WeeklyVerifyInput = {
  distributorCode: string;
  /** single-file distributors */
  fileBuffer?: ArrayBuffer | Buffer;
  fileName?: string;
  /** PS / Overseas split files */
  salesBuffer?: ArrayBuffer | Buffer;
  salesFileName?: string;
  stockBuffer?: ArrayBuffer | Buffer;
  stockFileName?: string;
};

// ── AI overlay ────────────────────────────────────────────────────────────────────────────────────
type AiJudgement = { id: number; status: "match" | "drift" | "uncertain"; note?: string };

async function judgeWithAi(
  provider: AiProvider,
  distributorName: string,
  items: { id: number; sheetRole: string; label: string; columnIndex: number; expectedHeaderHint: string; observedHeader: string }[],
): Promise<{ judgements: AiJudgement[]; summary: string }> {
  const system =
    "You verify that a pharmaceutical distributor's weekly Excel export still has the columns the import engine expects. " +
    "You are given, per pinned column: the field it should hold, the column number, the header text usually seen there, " +
    "and the header text actually found in the uploaded file (English or Arabic). For each item decide: 'match' (the found " +
    "header means the same thing as expected), 'drift' (the found header clearly means something different — a column was " +
    "moved/renamed/inserted), or 'uncertain' (you cannot tell). Headers may be in Arabic; judge by meaning, not exact text. " +
    "Do NOT invent items or column numbers. Reply with JSON only.";
  const lines = items
    .map((it) => `${it.id} | sheet:${it.sheetRole} | field:${it.label} | col:${it.columnIndex} | expected:"${it.expectedHeaderHint}" | found:"${it.observedHeader}"`)
    .join("\n");
  const user = `Distributor: ${distributorName}\n\nPinned columns (id | sheet | field | col | expected | found):\n${lines}\n\nReturn ONLY JSON of this exact shape: {"items":[{"id":<id>,"status":"match|drift|uncertain","note":"<short reason>"}],"summary":"<one plain-English sentence about whether the file lines up>"}`;

  const startedAt = Date.now();
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    body: JSON.stringify({
      max_completion_tokens: 2000,
      messages: [
        { content: system, role: "system" },
        { content: user, role: "user" },
      ],
      model: provider.model,
      response_format: { type: "json_object" },
    }),
    headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    // Log upstream body server-side only — it can echo request details / key fragments on 401.
    const body = await res.text().catch(() => "");
    logError("Weekly verify AI request failed", {
      labels: { event: "weekly_verify_ai_request_failed", httpStatus: res.status },
      context: { bodySnippet: body.slice(0, 300) },
    });
    recordAiCall({
      component: "sales_weekly_ai_verify",
      errorCode: String(res.status),
      latencyMs: Date.now() - startedAt,
      model: provider.model,
      purpose: "weekly_verify_columns",
      status: "error",
    });
    throw new Error(`AI request failed (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  recordAiCall({
    component: "sales_weekly_ai_verify",
    inputTokens: json.usage?.prompt_tokens,
    latencyMs: Date.now() - startedAt,
    model: provider.model,
    outputTokens: json.usage?.completion_tokens,
    purpose: "weekly_verify_columns",
    status: "success",
  });
  const text = json.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(text) as { items?: AiJudgement[]; summary?: string };
  return { judgements: Array.isArray(parsed.items) ? parsed.items : [], summary: String(parsed.summary ?? "") };
}

// ── main entry ──────────────────────────────────────────────────────────────────────────────────
export async function verifyWeeklyUpload(input: WeeklyVerifyInput): Promise<WeeklyVerifyResult> {
  const distributor = weeklyDistributorByCode(input.distributorCode);
  if (!distributor) throw new Error(`Unknown weekly distributor "${String(input.distributorCode).trim()}".`);

  // Header-name-matched distributors (e.g. Direct's hand-coded sheet, parser.ts adaptDirect) have no
  // fixed-position column-contract.ts entry — there is no positional layout for this check to read.
  // Skip straight to a deterministic "review manually" result instead of throwing "unknown distributor".
  if (distributor.headerNameMatched) {
    return {
      aiNote:
        `${distributor.name}'s columns are matched by header NAME, not position, so there is no fixed layout to check here. ` +
        "Confirm the file's headers look right before uploading.",
      aiUsed: false,
      columns: [],
      distributor: { code: distributor.code, name: distributor.name },
      files: [],
      matrices: [],
      verdict: "pass",
      warnings: [],
    };
  }

  // Resolve the SAME contract the parser will use (DB override merged over code), so the pre-upload
  // verification reflects exactly which columns the importer will read — never a "green lie".
  const contract = await resolveWeeklyContract(input.distributorCode);
  if (!contract) throw new Error(`Unknown weekly distributor "${String(input.distributorCode).trim()}".`);

  // Load each provided file into a workbook, keyed by the form field the contract references.
  const sources: Record<string, { buf?: ArrayBuffer | Buffer; name: string }> = {
    file: { buf: input.fileBuffer, name: input.fileName || "weekly file" },
    salesFile: { buf: input.salesBuffer, name: input.salesFileName || "sales matrix file" },
    stockFile: { buf: input.stockBuffer, name: input.stockFileName || "stock matrix file" },
  };
  const workbooks = new Map<string, ExcelJS.Workbook>();
  for (const key of Object.keys(sources)) {
    const buf = sources[key].buf;
    if (buf) workbooks.set(key, await loadWorkbook(buf));
  }

  const columns: WeeklyVerifyColumn[] = [];
  const matrices: WeeklyVerifyMatrix[] = [];
  const files: { role: string; fileName: string; sheetName: string }[] = [];
  const warnings: string[] = [];

  for (const sheetSpec of contract.sheets) {
    const workbook = workbooks.get(sheetSpec.formField);
    if (!workbook) {
      warnings.push(`The ${sheetSpec.role} file was not provided, so its columns could not be checked.`);
      continue;
    }
    const worksheet = findSheet(workbook, sheetSpec);
    if (!worksheet) {
      warnings.push(`Could not find the "${sheetSpec.sheetName ?? sheetSpec.role}" sheet for the ${sheetSpec.role} data.`);
      continue;
    }
    files.push({ role: sheetSpec.role, fileName: sources[sheetSpec.formField].name, sheetName: worksheet.name });
    const header = worksheet.getRow(sheetSpec.headerRowNumber);

    for (const field of sheetSpec.fields) {
      const observedHeader = cellText(header.getCell(field.columnIndex));
      const critical = field.role === "key" || field.role === "value";
      columns.push({
        sheetRole: sheetSpec.role,
        sheetName: worksheet.name,
        field: field.field,
        label: field.label,
        columnIndex: field.columnIndex,
        expectedHeaderHint: field.expectedHeaderHint,
        observedHeader,
        // Deterministic baseline: empty = structural problem. Non-empty headers stay "uncertain"
        // until the AI judges them (or remain uncertain when AI is unavailable).
        status: observedHeader ? "uncertain" : "empty",
        note: observedHeader ? "" : "No header found at this column — the file layout may have shifted.",
        critical,
      });
    }

    if (sheetSpec.matrix) {
      const { firstColumn, lastColumn, stopAtHeaderPattern } = sheetSpec.matrix;
      const stopRe = stopAtHeaderPattern ? new RegExp(stopAtHeaderPattern, "i") : null;
      const detected: string[] = [];
      const hardLast = lastColumn ?? 400;
      for (let col = firstColumn; col <= hardLast; col += 1) {
        const text = cellText(header.getCell(col));
        if (stopRe && text && stopRe.test(text)) break; // hit the summary column (e.g. Total Qty) — stop, don't count it
        if (!text) {
          if (!lastColumn) break; // run to the first blank when there's no hard last column
          continue;
        }
        detected.push(text);
      }
      matrices.push({
        sheetRole: sheetSpec.role,
        sheetName: worksheet.name,
        kind: sheetSpec.matrix.kind,
        firstColumn,
        detectedCount: detected.length,
        sampleHeaders: detected.slice(0, 8),
        note: sheetSpec.matrix.note,
      });
    }
  }

  // ── AI overlay (graceful: never throws out of here) ──
  const provider = resolveProvider();
  let aiUsed = false;
  let aiNote: string | null =
    "AI verification is not configured here — review the column mapping below and confirm it matches your file before uploading.";

  const judgeItems = columns
    .filter((c) => c.status !== "empty")
    .map((c, index) => ({ id: index, ref: c, sheetRole: c.sheetRole, label: c.label, columnIndex: c.columnIndex, expectedHeaderHint: c.expectedHeaderHint, observedHeader: c.observedHeader }));

  if (provider && judgeItems.length > 0) {
    try {
      const { judgements, summary } = await judgeWithAi(
        provider,
        contract.name,
        judgeItems.map(({ id, sheetRole, label, columnIndex, expectedHeaderHint, observedHeader }) => ({ id, sheetRole, label, columnIndex, expectedHeaderHint, observedHeader })),
      );
      // Clamp: only apply judgements whose id maps to an item we actually sent.
      const byId = new Map(judgeItems.map((it) => [it.id, it.ref]));
      for (const j of judgements) {
        const ref = byId.get(Number(j.id));
        if (!ref) continue;
        if (j.status === "match" || j.status === "drift" || j.status === "uncertain") {
          ref.status = j.status;
          if (j.note) ref.note = String(j.note).slice(0, 240);
        }
      }
      aiUsed = true;
      aiNote = summary ? summary.slice(0, 600) : "Column check complete.";
    } catch (error) {
      // Degrade gracefully — keep the deterministic plan, let the operator verify manually.
      logError("Weekly verify AI overlay failed", {
        labels: { event: "weekly_verify_ai_overlay_failed" },
        error,
      });
      aiUsed = false;
      aiNote = "The AI column check could not run just now — review the mapping below and confirm it looks right before uploading.";
    }
  }

  // ── verdict (deterministic — never trust the model's overall call) ──
  // Drift only when a CRITICAL column clearly drifted or is missing. "uncertain" never blocks "pass"
  // (the operator is the human gate); per the owner's choice drift WARNS but does not hard-block.
  const verdict: "pass" | "drift" = columns.some((c) => c.critical && (c.status === "drift" || c.status === "empty")) ? "drift" : "pass";

  return {
    distributor: { code: distributor.code, name: distributor.name },
    verdict,
    aiUsed,
    aiNote,
    files,
    columns,
    matrices,
    warnings,
  };
}
