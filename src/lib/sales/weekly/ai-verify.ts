// Weekly Sales — pre-upload AI verification.
//
// Reads ONLY the header row of the uploaded workbook(s) and compares it against the per-distributor
// column contract (column-contract.ts), so the operator can see exactly which data the engine will
// take from which column BEFORE committing to the upload. An OpenAI call judges each pinned column
// for "drift" (a renamed/moved header), but the verdict math is recomputed server-side — the AI is
// never trusted to gate anything. The call goes to the OpenAI-compatible provider first and to Anthropic
// when that account is out of credit or its key is rejected (src/lib/sales/ai/provider.ts).
//
// PRIVACY: only column HEADER TEXT leaves the server (product/branch column titles, and for PS the
// outlet/location names that are themselves the headers). No sales numbers, quantities, or data rows
// are ever sent — mirrors the privacy posture of src/lib/sales/normalizer/ai-suggest.ts.
//
// PRODUCTION SAFETY: when no AI key is configured (e.g. a preview without OPENAI_API_KEY or ANTHROPIC_API_KEY) or the AI
// call fails, this NEVER throws — it returns the deterministic column plan with aiUsed=false so the
// operator can still review and verify manually. An AI outage must not freeze the upload flow.

import ExcelJS from "exceljs";

import { anthropicJson, hasAiProvider, runWithSalesAiFailover, salesAiFailureCodeFor, salesLegOutcome, SalesAiError } from "@/lib/sales/ai/provider";
import { aiErrorCodeForResponse, recordAiCall } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";
import { type WeeklyContractSheet, type WeeklyDistributorContract } from "@/lib/sales/weekly/column-contract";
import { resolveWeeklyContract } from "@/lib/sales/weekly/weekly-column-profile-store";
import { weeklyDistributorByCode } from "@/lib/sales/weekly/distributors";
import { matchWeeklySheet, weeklySheetMatcher } from "@/lib/sales/weekly/sheet-match";
import type { WeeklyVerifyColumn, WeeklyVerifyMatrix, WeeklyVerifyResult } from "@/lib/sales/weekly/types";
import type { WeeklyVerifyAiState } from "@/lib/sales/weekly/verify-ai-state";

// ── AI provider planning (shared with src/lib/sales/ai/provider.ts) ────────────────────────────────
// ai-verify uses the shared "mini" model defaults exactly, so it passes none.

/** True when an AI key is configured (either provider) — the route surfaces this so the UI can label the mode. */
export function hasWeeklyVerifyAi(): boolean {
  return hasAiProvider();
}

// ── cell helper (mirrors parser.ts) ───────────────────────────────────────────────────────────────
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

// Exported for tests/sales-ai-failover.test.ts: the only other way in is verifyWeeklyUpload, which reads the
// column contract from the database.
export async function judgeWithAi(
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

  const text = await runWithSalesAiFailover(async (leg, { failoverTo }) => {
    if (leg.kind === "anthropic") {
      const reply = await anthropicJson({
        component: "sales_weekly_ai_verify",
        failoverTo,
        maxTokens: 2000,
        model: leg.model,
        purpose: "weekly_verify_columns",
        system,
        timeoutMs: 45_000,
        user,
      });
      return reply.text;
    }

    const { provider } = leg;
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
      const code = salesAiFailureCodeFor(res.status, body);
      logError("Weekly verify AI request failed", {
        labels: { event: "weekly_verify_ai_request_failed", httpStatus: res.status },
        context: { bodySnippet: body.slice(0, 300) },
      });
      recordAiCall({
        component: "sales_weekly_ai_verify",
        errorCode: aiErrorCodeForResponse(res.status, body),
        latencyMs: Date.now() - startedAt,
        model: provider.model,
        provider: provider.name,
        purpose: "weekly_verify_columns",
        ...salesLegOutcome(code, failoverTo),
      });
      throw new SalesAiError(code, `AI request failed (HTTP ${res.status}).`, res.status);
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
      provider: provider.name,
      purpose: "weekly_verify_columns",
      status: "success",
    });
    return json.choices?.[0]?.message?.content ?? "{}";
  });
  const parsed = JSON.parse(text) as { items?: AiJudgement[]; summary?: string };
  return { judgements: Array.isArray(parsed.items) ? parsed.items : [], summary: String(parsed.summary ?? "") };
}

// ── deterministic column plan (pure: no database, no AI) ─────────────────────────────────────────
type WeeklyVerifyFormField = WeeklyContractSheet["formField"];

export type WeeklyVerifyPlan = Pick<WeeklyVerifyResult, "files" | "columns" | "matrices" | "warnings">;

/**
 * Read each contract sheet's header row from the uploaded workbook(s) and lay out which column the
 * import takes each field from. The worksheet is picked by sheet-match.ts — the SAME rule the parser's
 * adapters use — so this can only ever show a sheet the import will read. A sheet the import would not
 * find is reported as MISSING, one row per pinned field, and is never replaced by another sheet: the
 * EGD month-end file of 2026-08 had no "Current Stock Branches", and the old fallback showed "Current
 * Stock Pharmacy" (or column 3 of the sales sheet) as the stock source while the import read no stock.
 */
export function planWeeklyVerify(input: {
  distributorCode: string;
  contract: WeeklyDistributorContract;
  workbooks: ReadonlyMap<WeeklyVerifyFormField, ExcelJS.Workbook>;
  fileNames: Record<WeeklyVerifyFormField, string>;
}): WeeklyVerifyPlan {
  const columns: WeeklyVerifyColumn[] = [];
  const matrices: WeeklyVerifyMatrix[] = [];
  const files: WeeklyVerifyPlan["files"] = [];
  const warnings: string[] = [];

  for (const sheetSpec of input.contract.sheets) {
    const workbook = input.workbooks.get(sheetSpec.formField);
    if (!workbook) {
      warnings.push(`The ${sheetSpec.role} file was not provided, so its columns could not be checked.`);
      continue;
    }
    const matcher = weeklySheetMatcher(input.distributorCode, sheetSpec.role);
    const match = matcher ? matchWeeklySheet(workbook, matcher) : null;
    if (!matcher || !match) {
      const wanted = matcher ? `"${matcher.name}" sheet` : `${sheetSpec.role} sheet`;
      const present = workbook.worksheets.map((ws) => `"${ws.name.trim()}"`).join(", ") || "none";
      warnings.push(
        `MISSING: this file has no ${wanted}, so the import will not read any ${sheetSpec.role} data from it — ` +
          `no other sheet is used in its place. Sheets in the file: ${present}.`,
      );
      for (const field of sheetSpec.fields) {
        columns.push({
          sheetRole: sheetSpec.role,
          sheetName: "",
          field: field.field,
          label: field.label,
          columnIndex: field.columnIndex,
          expectedHeaderHint: field.expectedHeaderHint,
          observedHeader: "",
          status: "missing",
          note: `This file has no ${wanted} — the import reads no ${sheetSpec.role} data.`,
          critical: field.role === "key" || field.role === "value",
        });
      }
      continue;
    }
    const worksheet = match.worksheet;
    // Some adapters read the first sheet when no sheet carries the expected name (Ibn Sina's real
    // exports always do). With one sheet there is nothing else it could be; with several, say so.
    if (match.matchedBy === "first-sheet" && workbook.worksheets.length > 1) {
      warnings.push(
        `No sheet is named "${matcher.name}", so the import reads this file's first sheet, "${worksheet.name.trim()}", ` +
          `for the ${sheetSpec.role} data. Check that it is the right sheet before uploading.`,
      );
    }
    files.push({ role: sheetSpec.role, fileName: input.fileNames[sheetSpec.formField], sheetName: worksheet.name });
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

  return { files, columns, matrices, warnings };
}

/**
 * Drift only when a CRITICAL column clearly drifted, is empty, or sits on a sheet the file does not have.
 * "uncertain" never blocks "pass" (the operator is the human gate); per the owner's choice drift WARNS
 * but does not hard-block.
 */
export function weeklyVerifyVerdict(columns: readonly WeeklyVerifyColumn[]): WeeklyVerifyResult["verdict"] {
  return columns.some((c) => c.critical && (c.status === "drift" || c.status === "empty" || c.status === "missing")) ? "drift" : "pass";
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
      aiState: "header_name_file",
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
  const sources: Record<WeeklyVerifyFormField, { buf?: ArrayBuffer | Buffer; name: string }> = {
    file: { buf: input.fileBuffer, name: input.fileName || "weekly file" },
    salesFile: { buf: input.salesBuffer, name: input.salesFileName || "sales matrix file" },
    stockFile: { buf: input.stockBuffer, name: input.stockFileName || "stock matrix file" },
  };
  const workbooks = new Map<WeeklyVerifyFormField, ExcelJS.Workbook>();
  for (const key of Object.keys(sources) as WeeklyVerifyFormField[]) {
    const buf = sources[key].buf;
    if (buf) workbooks.set(key, await loadWorkbook(buf));
  }

  const { files, columns, matrices, warnings } = planWeeklyVerify({
    distributorCode: distributor.code,
    contract,
    workbooks,
    fileNames: { file: sources.file.name, salesFile: sources.salesFile.name, stockFile: sources.stockFile.name },
  });

  // ── AI overlay (graceful: never throws out of here) ──
  const aiAvailable = hasAiProvider();
  let aiUsed = false;
  let aiState: WeeklyVerifyAiState = aiAvailable ? "nothing_to_check" : "not_configured";
  const judgeItems = columns
    .filter((c) => c.status !== "empty" && c.status !== "missing")
    .map((c, index) => ({ id: index, ref: c, sheetRole: c.sheetRole, label: c.label, columnIndex: c.columnIndex, expectedHeaderHint: c.expectedHeaderHint, observedHeader: c.observedHeader }));

  // With AI switched on, an empty column list is the file's doing, never "not configured" — that wording
  // sent operators looking for a missing key that was there all along.
  let aiNote: string | null = !aiAvailable
    ? "AI verification is not configured here — review the column mapping below and confirm it matches your file before uploading."
    : judgeItems.length === 0
      ? "No filled columns were found for AI to check — confirm the file has data under the expected headers before uploading."
      : null;

  if (aiAvailable && judgeItems.length > 0) {
    try {
      const { judgements, summary } = await judgeWithAi(
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
      aiState = "checked";
      aiNote = summary ? summary.slice(0, 600) : "Column check complete.";
    } catch (error) {
      // Degrade gracefully — keep the deterministic plan, let the operator verify manually.
      logError("Weekly verify AI overlay failed", {
        labels: { event: "weekly_verify_ai_overlay_failed" },
        error,
      });
      aiUsed = false;
      aiState = "failed";
      aiNote = "The AI column check could not run just now — review the mapping below and confirm it looks right before uploading.";
    }
  }

  // ── verdict (deterministic — never trust the model's overall call) ──
  const verdict = weeklyVerifyVerdict(columns);

  return {
    distributor: { code: distributor.code, name: distributor.name },
    verdict,
    aiState,
    aiUsed,
    aiNote,
    files,
    columns,
    matrices,
    warnings,
  };
}
