import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import { MAX_IMAGES_PER_RESULT, PREVIEW, createInspector, toolDefinitions } from "../scripts/phoenix-inspect/mcp-server.mjs";
import { RUN_BOUNDS } from "../scripts/phoenix-inspect/lib/safety.mjs";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Content[] } & Record<string, unknown>;

/**
 * Phoenix Visual Intelligence: the local MCP server's tools take IDS ONLY (no URL, script, SQL or
 * selector), refuse a state that is not on the persona's board, cap a call at 40 pages and 10 minutes,
 * allow one capture at a time and 10 calls a minute, return at most four masked images that live
 * inside the run folder, and write only validated ids to the audit log. A capture still running after
 * answerWithinMs answers with its run id (ChatGPT stops waiting at about 45 s), phoenix_get_capture
 * collects it, and every picture goes out as a small JPEG of the top of the page. Driven with a fake
 * runner: no browser, no network.
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
      "phoenix_get_capture",
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
    // Real pictures: the preview is cut and re-encoded, so a file that only starts like a PNG is not enough.
    const tall = await sharp({ create: { width: 1440, height: 2400, channels: 3, background: "#f4f4f4" } }).png().toBuffer();
    const runner = async (options: Record<string, unknown>) => {
      runs.push(options);
      if (hold) await hold;
      const outDir = path.join(dir, "runs", String(options.runId));
      mkdirSync(path.join(outDir, "shots"), { recursive: true });
      const shots: Record<string, unknown>[] = [{ id: "escape", state: "summary", viewport: "desktop", outcome: "captured", image: "../../outside.png" }];
      for (let i = 0; i < 6; i += 1) {
        const image = `shots/${i}.png`;
        writeFileSync(path.join(outDir, image), tall);
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
    const pictures = captured.content.filter((item) => item.type === "image");
    assert.equal(pictures.length, MAX_IMAGES_PER_RESULT);
    // The picture is the top of the page, scaled, as a JPEG: small enough to cross a home uplink in seconds.
    for (const picture of pictures) {
      assert.equal(picture.mimeType, "image/jpeg");
      const meta = await sharp(Buffer.from(picture.data ?? "", "base64")).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.width, PREVIEW.maxWidth, "scaled to the preview width");
      assert.equal(meta.height, Math.round((PREVIEW.topPx * PREVIEW.maxWidth) / 1440), "only the top of the page");
    }
    assert.ok(captured.content.some((item) => /^masked screenshot: shots\/0\.png \(the top 1800 of 2400 px/.test(item.text ?? "")), "each picture says what part of the page it is");
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

    // A capture still running at answerWithinMs answers with its run id; phoenix_get_capture collects it.
    clock += 61_000;
    const quick = createInspector({ runner, repoRoot: dir, now: () => clock, auditFile, answerWithinMs: 200 });
    const quickCall = (name: string, args?: unknown) => quick.call(name, args) as Promise<Result>;
    let finish: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const hung = new Promise<"hung">((resolve) => setTimeout(resolve, 5_000, "hung"));
      const answered = await Promise.race([quickCall("phoenix_open_module", { module: "kpi-reports", persona: "ceo" }), hung]);
      assert.notEqual(answered, "hung", "a capture past answerWithinMs kept the caller waiting instead of answering with its run id");
      const early = answered as Result;
      assert.ok(!early.isError, JSON.stringify(early.content[0]));
      const status = early.structuredContent as { status: string; runId: string; next: { tool: string; arguments: Record<string, string> } };
      assert.equal(status.status, "capturing", "a capture past the deadline answers at once instead of keeping ChatGPT waiting");
      assert.match(status.runId, /^\d{8}-\d{6}-mcp$/);
      assert.deepEqual(status.next, { tool: "phoenix_get_capture", arguments: { module: "kpi-reports", runId: status.runId } });
      assert.match(early.content[0].text ?? "", /phoenix_get_capture/);
      assert.ok(!early.content.some((item) => item.type === "image"));
      const stillGoing = await quickCall("phoenix_get_capture", { module: "kpi-reports", runId: status.runId });
      assert.equal((stillGoing.structuredContent as { status: string }).status, "capturing", "collecting a run still going says so again");
      const busy = await quickCall("phoenix_open_module", { module: "kpi-reports", persona: "sfe" });
      assert.match(busy.content[0].text ?? "", /another capture is already running/, "the waiting run still holds the one-capture rule");
      const runsBefore = runs.length;
      const repeat = await quickCall("phoenix_open_module", { module: "kpi-reports", persona: "ceo" });
      assert.equal((repeat.structuredContent as { runId?: string } | undefined)?.runId, status.runId, "asking for the same capture again answers with the run already going");
      assert.equal(runs.length, runsBefore, "and starts no second browser");
      finish();
      const collected = await quickCall("phoenix_get_capture", { module: "kpi-reports", runId: status.runId });
      assert.ok(!collected.isError, JSON.stringify(collected.content[0]));
      assert.equal((collected.structuredContent as { runId: string }).runId, status.runId, "the collected result is that run's");
      assert.ok(collected.content.some((item) => item.type === "image" && item.mimeType === "image/jpeg"), "with its pictures");
      const again = await quickCall("phoenix_get_capture", { module: "kpi-reports", runId: status.runId });
      assert.equal(again.isError, true, "a collected run is not held in memory for ever");
      // A run that finished while nobody collected it answers a repeat of the same request, once.
      hold = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const late = await quickCall("phoenix_open_module", { module: "kpi-reports", persona: "dm" });
      const lateId = (late.structuredContent as { status: string; runId: string }).runId;
      assert.equal((late.structuredContent as { status: string }).status, "capturing");
      finish();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const countBefore = runs.length;
      const repeated = await quickCall("phoenix_open_module", { module: "kpi-reports", persona: "dm" });
      assert.equal((repeated.structuredContent as { runId?: string } | undefined)?.runId, lateId, "the finished, uncollected run answers the repeat");
      assert.ok(repeated.content.some((item) => item.type === "image"), "with its pictures");
      assert.equal(runs.length, countBefore, "without a second capture");
      const missing = await quickCall("phoenix_get_capture", { module: "kpi-reports", runId: "20261117-000000-nope" });
      assert.match(missing.content[0].text ?? "", /not on this machine/);
    } finally {
      finish();
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
