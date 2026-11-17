/**
 * The ChatGPT connector: what one tool is.
 *
 * ChatGPT reaches Phoenix through `/api/mcp` (app/api/mcp/route.ts), signed in as the owner or the CEO
 * with a connector token (src/lib/chatgpt-connector/identity.ts). Every tool below runs with THAT
 * person's access context, so it sees exactly what their Phoenix screens show — each tool asserts the
 * same permission the matching page asserts, and narrows rows with the same scope helper the page uses.
 *
 * Every tool is read-only. A tool never writes, sends, publishes or approves anything; the two file
 * tools only build a file for the same person to download (src/lib/chatgpt-connector/files.ts).
 *
 * Owner decision, 17 Nov 2026: the live app, everything the person's role can see (pay, bank, ID and
 * medical included), the owner and the CEO only, files built by Phoenix. Account:
 * docs/phoenix-intelligence/CHATGPT_DATA_CONNECTOR.md.
 */
import type { z } from "zod";

import type { AccessContext } from "@/lib/auth/permissions";

/** The two seats that may connect ChatGPT (owner, 17 Nov 2026: "Me + CEO"). */
export const CONNECTOR_ROLES = ["Super Admin", "CEO"] as const;
export type ConnectorRole = (typeof CONNECTOR_ROLES)[number];

/**
 * What a tool hands back. `summary` is the plain-language answer ChatGPT reads first; `data` is the
 * structured result (rows, figures) it can compute with or put in a sheet. Keep `data` JSON-safe:
 * plain objects, arrays, strings, numbers, booleans and null. Dates as ISO strings.
 */
export type ToolAnswer = {
  summary: string;
  data: unknown;
};

/** One connector tool. `input` is a zod raw shape (an object of zod schemas), validated by the MCP SDK. */
export type ConnectorTool<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  /** snake_case, starts with `phoenix_`. */
  name: string;
  title: string;
  /** What it answers and when ChatGPT should call it — this is the only manual ChatGPT reads. */
  description: string;
  input: Shape;
  /** The seats allowed to call it. Omitted = both connector seats. */
  roles?: readonly ConnectorRole[];
  run: (ctx: AccessContext, input: z.infer<z.ZodObject<Shape>>) => Promise<ToolAnswer>;
};

/** A refusal the person should read as-is (not found, not allowed, bad period). Never a crash. */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** Identity helper so `defineTool({...})` keeps the input type inferred. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ConnectorTool<Shape>): ConnectorTool<Shape> {
  return tool;
}
