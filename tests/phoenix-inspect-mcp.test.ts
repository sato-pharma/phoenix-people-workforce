import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_IMAGES_PER_RESULT, createInspector, toolDefinitions } from "../scripts/phoenix-inspect/mcp-server.mjs";
import { RUN_BOUNDS } from "../scripts/phoenix-inspect/lib/safety.mjs";

type Content = { type: string; text?: string; data?: string };
type Result = { isError?: boolean; content: Content[] } & Record<string, unknown>;

/**
 * Phoenix Visual Intelligence: the local MCP server's tools take IDS ONLY (no URL, script, SQL or
 * selector), refuse a state that is not on the persona's board, cap a call at 40 pages and 10 minutes,
 * allow one capture at a time and 10 calls a minute, return at most four masked images that live
 * inside the run folder, and write only validated ids to the audit log. Driven with a fake runner:
 * no browser, no network.
 */
export async function runPhoenixInspectMcpTests() {
  const tools = toolDefinitions();
  assert.deepEqual(
    tools.map((tool: { name: string }) => tool.name),
    [
      "phoenix_list_portals_and_modules",
      "phoenix_list_module_pages",
      "phoenix_open_module",
      "phoenix_capture_page",
      "phoenix_inspect_ui_state",
      "phoenix_get_component_map",
      "phoenix_get_visual_audit",
      "phoenix_get_implementation_plan",
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} refuses unknown fields`);
    for (const [key, property] of Object.entries(tool.inputSchema.properties) as [string, Record<string, unknown>][]) {
      assert.ok(!/url|origin|script|sql|selector|query|code|path/i.test(key), `${tool.name}.${key} is not a free-text door`);
      const items = (property.items ?? property) as Record<string, unknown>;
      assert.ok(Array.isArray(items.enum) || typeof items.pattern === "string", `${tool.name}.${key} is an enum of ids or a fixed pattern`);
    }
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "phoenix-inspect-mcp-"));
  try {
    const auditFile = path.join(dir, "audit.jsonl");
    const runs: Record<string, unknown>[] = [];
    let clock = Date.parse("2026-11-14T18:00:00Z");
    let hold: Promise<void> | null = null;
    const runner = async (options: Record<string, unknown>) => {
      runs.push(options);
      if (hold) await hold;
      const outDir = path.join(dir, "runs", String(options.runId));
      mkdirSync(path.join(outDir, "shots"), { recursive: true });
      const shots: Record<string, unknown>[] = [{ id: "escape", state: "summary", viewport: "desktop", outcome: "captured", image: "../../outside.png" }];
      for (let i = 0; i < 6; i += 1) {
        const image = `shots/${i}.png`;
        writeFileSync(path.join(outDir, image), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, i]));
        shots.push({ id: `00${i}`, state: "summary", viewport: "desktop", outcome: "captured", image, writesStopped: [], console: [] });
      }
      return { outDir, manifest: { runId: options.runId, totals: { captured: 7 }, personas: [], shots, denied: [], notRun: [] } };
    };
    const outsideBytes = Buffer.from("not inside the run folder");
    writeFileSync(path.join(dir, "outside.png"), outsideBytes);
    const leaksOutside = (result: Result) => result.content.some((item) => item.type === "image" && item.data === outsideBytes.toString("base64"));
    const inspector = createInspector({ runner, repoRoot: dir, now: () => clock, auditFile });
    const call = (name: string, args?: unknown) => inspector.call(name, args) as Promise<Result>;
    const refusedWith = async (name: string, args: unknown, why: RegExp) => {
      const result = await call(name, args);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} is refused`);
      assert.match(result.content[0].text ?? "", why);
    };

    // Inputs: ids only.
    await refusedWith("phoenix_capture_page", { module: "kpi-reports", persona: "ceo", states: ["summary"], url: "https://phoenix-hr.satopharma.com/admin" }, /unknown field "url"/);
    await refusedWith("phoenix_capture_page", { module: "kpi-reports", persona: "superadmin", states: ["summary"] }, /persona must be one of/);
    await refusedWith("phoenix_capture_page", { module: "kpi-reports", persona: "ceo" }, /missing states/);
    await refusedWith("phoenix_inspect_ui_state", { module: "kpi-reports", persona: "ceo", state: "summary", script: "document.cookie" }, /unknown field "script"/);
    await refusedWith("phoenix_run_sql", { sql: "select 1" }, /unknown tool/);
    await refusedWith("phoenix_capture_page", { module: "kpi-reports", persona: "dm", states: ["tab-call-rate"] }, /not on the District Manager board/);
    clock += 61_000;
    await refusedWith(
      "phoenix_capture_page",
      { module: "kpi-reports", persona: "ceo", states: ["summary", "tab-weekly", "tab-coverage", "tab-frequency", "tab-am-pm", "tab-pharmacies", "tab-call-rate", "call-rate-am", "call-rate-pm", "weekly-quarter", "period-week-1", "sorted-coverage-desc", "filter-band-behind", "search-no-match"], viewports: ["desktop", "tablet", "mobile"] },
      new RegExp(`at most ${RUN_BOUNDS.maxPagesPerToolCall}`),
    );
    assert.equal(runs.length, 0, "no refused call reached the runner");

    // A capture: the runner gets ids and the per-call bounds; at most four images, none from outside the run.
    const captured = await call("phoenix_capture_page", { module: "kpi-reports", persona: "dm", states: ["summary"], viewports: ["desktop", "mobile"] });
    assert.ok(!captured.isError, JSON.stringify(captured.content[0]));
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].personas, ["dm"]);
    assert.match(String(runs[0].runId), /^\d{8}-\d{6}-mcp$/);
    assert.ok(Number(runs[0].maxMinutes) <= RUN_BOUNDS.maxMinutesPerToolCall);
    assert.equal(captured.content.filter((item) => item.type === "image").length, MAX_IMAGES_PER_RESULT);
    assert.ok(!leaksOutside(captured), "a manifest path outside the run folder is never read");
    assert.ok(!("_manifest" in captured) && !("_outDir" in captured), "internal fields never reach the client");
    // ChatGPT may not pass a tool's image to the model, so the measurements also travel as structured data.
    assert.deepEqual(captured.structuredContent, JSON.parse(captured.content[0].text ?? "null"), "a capture's summary is also structuredContent");
    const escape = await call("phoenix_inspect_ui_state", { module: "kpi-reports", persona: "ceo", state: "summary", viewport: "desktop" });
    assert.ok(!escape.isError);
    assert.deepEqual(escape.structuredContent, JSON.parse(escape.content[0].text ?? "null"), "an inspected state's detail is also structuredContent");
    assert.ok(!leaksOutside(escape) && !escape.content.some((item) => item.type === "image"), "the first shot's image is outside the run folder, so none is returned");

    // One capture at a time.
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = call("phoenix_open_module", { module: "kpi-reports", persona: "ceo" });
      const waited = new Promise<"waited">((resolve) => setTimeout(resolve, 2_000, "waited"));
      const second = await Promise.race([call("phoenix_open_module", { module: "kpi-reports", persona: "sfe" }), waited]);
      assert.notEqual(second, "waited", "a second capture started alongside the first instead of being refused");
      assert.equal((second as Result).isError, true);
      assert.match((second as Result).content[0].text ?? "", /another capture is already running/);
      release();
      assert.ok(!(await first).isError);
    } finally {
      release();
      hold = null;
    }

    // Ten calls a minute.
    clock += 61_000;
    for (let i = 0; i < RUN_BOUNDS.toolCallsPerMinute; i += 1) assert.ok(!(await call("phoenix_list_module_pages", { module: "kpi-reports" })).isError);
    await refusedWith("phoenix_list_module_pages", { module: "kpi-reports" }, /calls in a minute/);

    // The audit log holds ids and outcomes, never what a refused call tried to send.
    const audit = readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(audit.length >= 20);
    const raw = readFileSync(auditFile, "utf8");
    assert.ok(!raw.includes("satopharma") && !raw.includes("document.cookie") && !raw.includes("select 1"), "refused inputs are not logged");
    assert.ok(audit.some((record) => record.outcome === "busy") && audit.some((record) => record.outcome === "rate-limited"));
    assert.ok(audit.every((record) => typeof record.ms === "number" && typeof record.at === "string"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
