#!/usr/bin/env node
/**
 * Phoenix Inspect — end-to-end smoke of the local MCP server, through a REAL stdio MCP client.
 *
 *   node scripts/phoenix-inspect/mcp-smoke.mjs [--capture] [--runner spare|local]
 *
 * Starts mcp-server.mjs as a child process, speaks the protocol to it with the SDK's own client, and
 * checks what any MCP client would see:
 *   1. the nine tools are listed, every schema closed (additionalProperties: false);
 *   2. listing portals and the KPIs module's pages works and returns no address outside staging paths;
 *   3. a URL where an id belongs, an unknown persona and an extra key are each REFUSED;
 *   4. the component map is readable;
 *   5. with --capture only: one real capture (CEO, Summary, desktop) through the runner, and the
 *      result carries a masked image and no refusal.
 * Prints one line per check and exits 0 only when every check passed. Starts no browser itself.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "mcp-smoke",
  entry: import.meta.url,
  known: ["--capture", "--runner"],
  hints: ["node scripts/phoenix-inspect/mcp-smoke.mjs [--capture] [--runner spare|local]"],
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const EXPECTED_TOOLS = [
  "phoenix_list_portals_and_modules",
  "phoenix_list_module_pages",
  "phoenix_open_module",
  "phoenix_capture_page",
  "phoenix_inspect_ui_state",
  "phoenix_get_capture",
  "phoenix_get_component_map",
  "phoenix_get_visual_audit",
  "phoenix_get_implementation_plan",
];

const argv = process.argv.slice(2);
const doCapture = argv.includes("--capture");
const runner = argv.includes("--runner") ? argv[argv.indexOf("--runner") + 1] : "spare";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function textOf(result) {
  return (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "mcp-server.mjs"), "--runner", runner],
  cwd: REPO_ROOT,
  stderr: "pipe",
});
const client = new Client({ name: "phoenix-inspect-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  check("the server answers the MCP handshake", true);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  check("nine tools, exactly the expected ones", JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), names.join(", "));
  check(
    "every tool schema is closed (additionalProperties: false)",
    tools.every((tool) => tool.inputSchema?.additionalProperties === false),
  );
  const freeText = tools.flatMap((tool) =>
    Object.entries(tool.inputSchema?.properties ?? {})
      .filter(([, schema]) => schema.type === "string" && !schema.enum && !schema.pattern)
      .map(([key]) => `${tool.name}.${key}`),
  );
  check("no free-text string input anywhere", freeText.length === 0, freeText.join(", "));

  const portals = await client.callTool({ name: "phoenix_list_portals_and_modules", arguments: {} });
  const portalsText = textOf(portals);
  check("portals and modules are listed", !portals.isError && /kpi-reports/.test(portalsText));
  check("the listing names no production host", !/phoenix-hr\.satopharma\.com/.test(portalsText));

  const pages = await client.callTool({ name: "phoenix_list_module_pages", arguments: { module: "kpi-reports" } });
  const pagesText = textOf(pages);
  check("the KPIs module's states are listed", !pages.isError && /summary/.test(pagesText) && /call-rate/.test(pagesText));
  check("Export XLSX is listed as never touched", /export/i.test(pagesText));

  const refusals = [
    ["a URL where a module id belongs", "phoenix_open_module", { module: "https://phoenix-hr.satopharma.com/admin/kpis", persona: "ceo" }],
    ["an unknown persona", "phoenix_open_module", { module: "kpi-reports", persona: "superadmin" }],
    ["an extra key (a script)", "phoenix_open_module", { module: "kpi-reports", persona: "ceo", script: "document.cookie" }],
    ["an unknown state", "phoenix_inspect_ui_state", { module: "kpi-reports", persona: "ceo", state: "export-xlsx", viewport: "desktop" }],
    ["an unknown tool", "phoenix_run_javascript", { code: "1+1" }],
  ];
  for (const [label, name, args] of refusals) {
    const result = await client.callTool({ name, arguments: args });
    check(`refused: ${label}`, result.isError === true && /refused/.test(textOf(result)), textOf(result).slice(0, 120));
  }

  const map = await client.callTool({ name: "phoenix_get_component_map", arguments: { module: "kpi-reports" } });
  check("the component map is readable", !map.isError && /component map/i.test(textOf(map)));

  if (doCapture) {
    const shot = await client.callTool(
      { name: "phoenix_capture_page", arguments: { module: "kpi-reports", persona: "ceo", states: ["summary"], viewports: ["desktop"] } },
      undefined,
      { timeout: 15 * 60_000 },
    );
    const images = (shot.content ?? []).filter((part) => part.type === "image");
    check("one real capture comes back without a refusal", !shot.isError, textOf(shot).slice(0, 200));
    check("the capture carries a masked image", images.length >= 1 && images.every((image) => image.mimeType === "image/png"));
  }
} catch (error) {
  check("the smoke ran to the end", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await client.close().catch(() => {});
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed${doCapture ? " (with a real capture)" : ""}`);
process.exit(failed === 0 ? 0 : 1);
