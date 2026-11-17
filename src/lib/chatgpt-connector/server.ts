/**
 * The MCP server ChatGPT talks to, built fresh for every /api/mcp request (stateless) and bound to
 * ONE person's access context — the owner or the CEO, checked live by identity.ts before this runs.
 *
 * Every tool is read-only and runs as that person: the tool asserts the same permission and scope
 * the matching Phoenix screen does. A tool the person's seat may not use is not even listed.
 *
 * Each call is bounded (40 s), turns a ToolRefusal into a plain message ChatGPT reads to the person,
 * turns any other failure into a short "could not" without the internals, and leaves one audit row
 * (entity type `chatgpt_connector`): which tool, its small inputs, the outcome and how long it took.
 * The answer is never written to the audit trail.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { afterResponse } from "@/lib/http/after-response";
import { logError } from "@/lib/observability/log";

import { FILE_TOOLS } from "./files";
import { DOMAIN_TOOLS } from "./tools";
import { ToolRefusal, type ConnectorRole, type ConnectorTool, type ToolAnswer } from "./types";

export const CONNECTOR_TOOL_TIMEOUT_MS = 40_000;
/** ChatGPT reads the whole text; past this the rows are cut and the answer says so. */
export const CONNECTOR_MAX_TEXT_CHARS = 180_000;

export const CONNECTOR_INSTRUCTIONS = [
  "Phoenix is Sato Pharma's HR, payroll, attendance, sales and field CRM system.",
  "Every tool reads live Phoenix data as the signed-in person and sees exactly what their own Phoenix screens show.",
  "Find a person with phoenix_find_people first when you only have a name, then pass their HR number to the other tools.",
  "Sales and target figures come only from the published monthly closing. Never add units of different products; compare by value.",
  "Show people by name, never by HR number alone. Dates are Cairo dates.",
  "When the person wants a sheet or a PDF, call phoenix_make_sheet or phoenix_make_pdf with the rows, and give them the download link it returns.",
].join(" ");

export function allConnectorTools(): ConnectorTool[] {
  return [...DOMAIN_TOOLS, ...FILE_TOOLS] as ConnectorTool[];
}

export function toolsForRole(role: string, tools: ConnectorTool[] = allConnectorTools()): ConnectorTool[] {
  return tools.filter((tool) => !tool.roles || tool.roles.includes(role as ConnectorRole));
}

/** Small inputs are kept for the audit row; long text and lists are described, never copied. */
export function auditableInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") kept[key] = value;
    else if (typeof value === "string") kept[key] = value.length <= 120 ? value : `[text, ${value.length} characters]`;
    else if (Array.isArray(value)) kept[key] = `[list of ${value.length}]`;
    else kept[key] = "[object]";
  }
  return kept;
}

/** The answer as ChatGPT receives it: the summary, then the data as JSON, cut with a note if huge. */
export function renderAnswer(answer: ToolAnswer): { text: string; cut: boolean } {
  const data = JSON.stringify(answer.data ?? null, null, 1);
  const whole = `${answer.summary}\n\n${data}`;
  if (whole.length <= CONNECTOR_MAX_TEXT_CHARS) return { text: whole, cut: false };
  const room = Math.max(0, CONNECTOR_MAX_TEXT_CHARS - answer.summary.length - 400);
  return {
    text: `${answer.summary}\n\nThe data was too large to send whole; the first ${room.toLocaleString("en-US")} characters follow. Ask a narrower question (a shorter period, one line or one area) for the rest.\n\n${data.slice(0, room)}`,
    cut: true,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolRefusal(`Phoenix took longer than ${Math.round(ms / 1000)} seconds on this question. Ask for a shorter period or a narrower group.`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Runs one tool for one person. Exported for the tests; the MCP server calls it per request. */
export async function runConnectorTool(
  ctx: AccessContext,
  tool: ConnectorTool,
  input: unknown,
  options: { timeoutMs?: number; audit?: (row: Record<string, unknown>) => Promise<void> } = {},
): Promise<ToolResult> {
  const started = Date.now();
  let outcome: "answered" | "refused" | "failed" = "answered";
  let result: ToolResult;
  try {
    if (tool.roles && !tool.roles.includes(ctx.role as ConnectorRole)) {
      throw new ToolRefusal("This question is not open to your Phoenix seat.");
    }
    const answer = await withTimeout(tool.run(ctx, input as never), options.timeoutMs ?? CONNECTOR_TOOL_TIMEOUT_MS);
    const rendered = renderAnswer(answer);
    result = {
      content: [{ type: "text", text: rendered.text }],
      structuredContent: rendered.cut ? { summary: answer.summary, cut: true } : { summary: answer.summary, data: answer.data as unknown },
    };
  } catch (error) {
    if (error instanceof ToolRefusal) {
      outcome = "refused";
      result = { content: [{ type: "text", text: error.message }], isError: true };
    } else {
      outcome = "failed";
      logError("ChatGPT connector tool failed", {
        labels: { event: "chatgpt_connector_tool_failed", tool: tool.name, hrId: ctx.hrId ?? "", role: ctx.role ?? "" },
        error,
      });
      result = { content: [{ type: "text", text: "Phoenix could not answer that just now. Try again in a minute." }], isError: true };
    }
  }
  const row = {
    tool: tool.name,
    input: auditableInput(input),
    outcome,
    ms: Date.now() - started,
  };
  const audit =
    options.audit ??
    ((values: Record<string, unknown>) =>
      writeAuditLog({
        actorLoginId: ctx.loginId ?? null,
        entityType: "chatgpt_connector",
        entityId: tool.name,
        summary: `ChatGPT asked Phoenix (${tool.title}) for ${ctx.role}: ${outcome}`,
        newValues: values,
      }));
  await afterResponse("chatgpt_connector_audit", () => audit(row));
  return result;
}

export function buildConnectorServer(ctx: AccessContext, tools: ConnectorTool[] = toolsForRole(ctx.role ?? "")): McpServer {
  const server = new McpServer({ name: "phoenix", title: "Phoenix", version: "1.0.0" }, { instructions: CONNECTOR_INSTRUCTIONS });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      // The SDK validates the input against `tool.input` before this runs.
      (async (input: unknown) => runConnectorTool(ctx, tool, input)) as never,
    );
  }
  return server;
}
