#!/usr/bin/env node
/**
 * Phoenix Inspect — a LOCAL Model Context Protocol server (stdio) over the visual explorer.
 *
 *   node scripts/phoenix-inspect/mcp-server.mjs [--runner spare|local]
 *
 * It gives an MCP client eight tools that LOOK at Phoenix on STAGING and read the module's
 * documentation. It is deliberately narrow (kickoff: "Never expose an unrestricted browser/JavaScript/
 * SQL execution endpoint"):
 *
 *   - Every input is an ID from the module spec: a module id, a persona id, state ids, viewport names,
 *     a run id. No URL, selector, script, SQL or free text is accepted (lib/safety.mjs
 *     validateToolInput; each tool's JSON schema also says additionalProperties: false).
 *   - The target is always staging (explore.mjs refuses production). Browsing contexts send GET only.
 *   - One capture at a time, 10 tool calls a minute, at most 40 pages and 10 minutes per call, a fresh
 *     browser per call. Images are the explorer's MASKED screenshots, never a raw page.
 *   - Every call is written to artifacts/phoenix-inspection/mcp-audit.jsonl: tool, ids, outcome, ms.
 *
 * Runner: "spare" sends each capture to the spare laptop (on-spare.ps1), so the machine running this
 * server starts no browser; "local" runs the explorer here (for the spare itself, or any machine with
 * the credentials file). Default: spare when this is Windows and the spare scripts exist, else local.
 *
 * The same eight tools are served over Streamable HTTP, behind OAuth, by mcp-http.mjs: both doors build
 * their protocol server with `buildMcpServer` below. Remote use (ChatGPT) is NOT deployed anywhere: see
 * docs/phoenix-intelligence/CHATGPT_INTERFACE.md.
 * stdout belongs to the protocol; this file logs to stderr only.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODULES, buildPlan, cairoStamp } from "./explore.mjs";
import { RUN_BOUNDS, VIEWPORTS, createRateLimiter, createSingleFlight, validateToolInput } from "./lib/safety.mjs";
import { addressFor } from "./modules/kpis.mjs";
import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "mcp-server",
  entry: import.meta.url,
  known: ["--runner"],
  hints: ["node scripts/phoenix-inspect/mcp-server.mjs [--runner spare|local]"],
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
const RUN_ROOT = ["artifacts", "phoenix-inspection"];
const INVENTORY = "docs/phoenix-intelligence/route-inventory.json";
const MODULE_DOCS = Object.freeze({
  "kpi-reports": {
    componentMap: "docs/phoenix-intelligence/KPI_REPORTS_COMPONENT_MAP.md",
    audit: "docs/phoenix-intelligence/KPI_REPORTS_VISUAL_AUDIT.md",
    plan: "docs/phoenix-intelligence/KPI_REPORTS_PREMIUM_POLISH_PLAN.md",
    prompt: "docs/phoenix-intelligence/SECOND_STAGE_PROMPT.md",
  },
});
export const MAX_IMAGES_PER_RESULT = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** All the images of one result together, before base64 (which adds a third). */
export const MAX_IMAGE_BYTES_PER_RESULT = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TEXT = 60_000;
const CALL_MINUTES = RUN_BOUNDS.maxMinutesPerToolCall;

const unique = (items) => [...new Set(items)];

/** The eight tools, with JSON schemas built from the module specs (enums of ids, nothing free). */
export function toolDefinitions() {
  const specs = Object.values(MODULES);
  const moduleId = { type: "string", enum: Object.keys(MODULES), description: "A module id from phoenix_list_portals_and_modules." };
  const persona = { type: "string", enum: unique(specs.flatMap((spec) => spec.personas.map((item) => item.id))), description: "A persona id (a staging-only inspection login)." };
  const stateIds = unique(specs.flatMap((spec) => spec.states.map((state) => state.id)));
  const state = { type: "string", enum: stateIds, description: "A state id from phoenix_list_module_pages." };
  const viewport = { type: "string", enum: Object.keys(VIEWPORTS) };
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const look = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const schema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
  return [
    {
      name: "phoenix_list_portals_and_modules",
      description: "Lists Phoenix's portals (admin, HR, employee portal) with their sidebar pages per role, from the route inventory generated from source, and the modules the visual explorer can capture.",
      inputSchema: schema({}, []),
      annotations: read,
    },
    {
      name: "phoenix_list_module_pages",
      description: "Lists one module's pages and UI states (tabs, filters, sorts, periods, drill-downs, clicks, mocked loading and error), the personas that may open each, and the controls the explorer never touches.",
      inputSchema: schema({ module: moduleId }, ["module"]),
      annotations: read,
    },
    {
      name: "phoenix_open_module",
      description: "Opens a module's landing page on STAGING as one persona at desktop width and returns the masked full-page screenshot with its measurements. Read-only.",
      inputSchema: schema({ module: moduleId, persona }, ["module", "persona"]),
      annotations: look,
    },
    {
      name: "phoenix_capture_page",
      description: `Captures masked full-page screenshots of up to ${RUN_BOUNDS.maxPagesPerToolCall} states x viewports of a module on STAGING as one persona. Returns a summary of every shot and up to ${MAX_IMAGES_PER_RESULT} images. Read-only.`,
      inputSchema: schema({ module: moduleId, persona, states: { type: "array", items: state, minItems: 1, maxItems: RUN_BOUNDS.maxPagesPerToolCall }, viewports: { type: "array", items: viewport, minItems: 1, maxItems: 3 } }, ["module", "persona", "states"]),
      annotations: look,
    },
    {
      name: "phoenix_inspect_ui_state",
      description: "Captures ONE state at one viewport and returns everything measured: horizontal overflow, rounded corners, ellipsis cuts, off-token colours and font sizes, small tap targets, contrast, internal scrollers, the masked accessibility snapshot, the source files its visible text comes from, stopped writes and console errors.",
      inputSchema: schema({ module: moduleId, persona, state, viewport }, ["module", "persona", "state"]),
      annotations: look,
    },
    {
      name: "phoenix_get_component_map",
      description: "Returns the module's route -> layout -> page -> component -> domain -> table map, each link marked certain or inferred.",
      inputSchema: schema({ module: moduleId }, ["module"]),
      annotations: read,
    },
    {
      name: "phoenix_get_visual_audit",
      description: "Returns the module's visual audit and, with runId, that run's totals and per-shot measurements.",
      inputSchema: schema({ module: moduleId, runId: { type: "string", pattern: "^\\d{8}-\\d{6}(?:-[a-z0-9]{1,12})?$" } }, ["module"]),
      annotations: read,
    },
    {
      name: "phoenix_get_implementation_plan",
      description: "Returns the module's premium-polish plan and the second-stage implementation prompt (proposals only; nothing is changed).",
      inputSchema: schema({ module: moduleId }, ["module"]),
      annotations: read,
    },
  ];
}

const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
const refusal = (message) => ({ isError: true, content: [text(message)] });
/** The JSON a client receives: undefined fields dropped, exactly as in the text twin. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const clip = (value, limit = MAX_TEXT) => (value.length > limit ? `${value.slice(0, limit)}\n[cut at ${limit} characters]` : value);

function readRepoFile(repoRoot, file) {
  const full = path.join(repoRoot, file);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/** A file inside the run folder, or null: a manifest path never leads outside it. */
function insideRun(outDir, relative) {
  if (typeof relative !== "string") return null;
  const full = path.resolve(outDir, relative);
  return full.startsWith(path.resolve(outDir) + path.sep) && existsSync(full) ? full : null;
}

/**
 * A shot's MASKED picture as an MCP image block, or null. Only a shot the explorer marked "captured"
 * (its leak check passed; a failed check deletes the files and records no image), only a PNG under the
 * run's `shots/` folder, only under the per-image cap, and only when the file starts as a PNG does.
 */
function maskedImage(outDir, shot) {
  if (shot?.outcome !== "captured" || Number(shot.redaction?.leakCount) > 0) return null;
  const relative = shot.image;
  if (typeof relative !== "string" || !/^shots\/[^/\\]+\.png$/.test(relative)) return null;
  const full = insideRun(outDir, relative);
  if (!full || statSync(full).size > MAX_IMAGE_BYTES) return null;
  const bytes = readFileSync(full);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return { block: { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }, bytes: bytes.length };
}

function shotSummary(shot) {
  return {
    shot: shot.id ?? shot.shotId,
    state: shot.state,
    viewport: shot.viewport,
    outcome: shot.outcome,
    image: shot.image,
    measurements: shot.measurements,
    writesStopped: shot.writesStopped?.length ?? 0,
    consoleErrors: shot.console?.length ?? 0,
    sourceCandidates: (shot.sourceCandidates ?? []).slice(0, 8),
    ...(shot.error ? { error: shot.error } : {}),
  };
}

/**
 * The tool handler, without the protocol: `call(name, args)` answers an MCP CallTool result. The
 * runner is injected so the tests drive it without a browser. `imageLimits` lowers (never raises) the
 * per-result image count and byte caps; `callLimits` lowers (never raises) the pages and minutes of one
 * capture, and the minutes are a HARD stop: the runner gets an AbortSignal that closes its browser (or
 * stops the spare's run), and the call answers at the limit. `maxResultBytes` caps the whole serialized
 * result: images are dropped, last first, until it fits (the tunnel's envelope is 10 MiB).
 * @param {{ runner: (options: Record<string, unknown>) => Promise<{ outDir: string, manifest: Record<string, unknown> }>, repoRoot?: string, now?: () => number, auditFile?: string|null, imageLimits?: { count?: number, bytes?: number }, callLimits?: { pages?: number, minutes?: number }, maxResultBytes?: number|null }} deps
 */
export function createInspector({ runner, repoRoot = REPO_ROOT, now = () => Date.now(), auditFile, imageLimits = {}, callLimits = {}, maxResultBytes = null } = {}) {
  const tools = toolDefinitions();
  const maxImages = Math.min(MAX_IMAGES_PER_RESULT, imageLimits.count ?? MAX_IMAGES_PER_RESULT);
  const maxImageBytes = Math.min(MAX_IMAGE_BYTES_PER_RESULT, imageLimits.bytes ?? MAX_IMAGE_BYTES_PER_RESULT);
  const maxPages = Math.max(1, Math.min(RUN_BOUNDS.maxPagesPerToolCall, callLimits.pages ?? RUN_BOUNDS.maxPagesPerToolCall));
  const callMinutes = Math.min(CALL_MINUTES, callLimits.minutes ?? CALL_MINUTES);
  if (!(callMinutes > 0)) throw new Error("callLimits.minutes must be positive");
  const limiter = createRateLimiter(RUN_BOUNDS.toolCallsPerMinute, now);
  const flight = createSingleFlight();
  const auditPath = auditFile === undefined ? path.join(repoRoot, ...RUN_ROOT, "mcp-audit.jsonl") : auditFile;

  function audit(record) {
    if (!auditPath) return;
    try {
      mkdirSync(path.dirname(auditPath), { recursive: true });
      appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      console.error(`audit log not written: ${error.message}`);
    }
  }

  async function capture({ module, persona, states, viewports }) {
    const spec = MODULES[module];
    const who = spec.personas.find((item) => item.id === persona);
    const offered = spec.states.filter((state) => state.shells.includes(who.shell)).map((state) => state.id);
    const wrong = states.filter((id) => !offered.includes(id));
    if (wrong.length > 0) {
      return refusal(`refused: ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not on the ${who.role} board. Its states: ${offered.join(", ")}`);
    }
    const plan = buildPlan(spec, { personas: [persona], states, viewports });
    if (plan.jobs.length === 0) return refusal("refused: nothing to capture for that persona and those states");
    if (plan.jobs.length > maxPages) {
      return refusal(`refused: ${plan.jobs.length} pages asked; one call captures at most ${maxPages}`);
    }
    const runId = `${cairoStamp(new Date(now())).id}-mcp`;
    const { outDir, manifest } = await runBounded((signal) =>
      runner({ module, personas: [persona], states, viewports: viewports ?? ["desktop"], runId, maxMinutes: callMinutes, signal }),
    );
    const shots = manifest.shots ?? [];
    // The same summary as text AND as structuredContent: ChatGPT does not guarantee that a tool's image
    // reaches the model (OpenAI support, 22 Apr 2026), so the measurements must stand without it.
    const summary = {
      runId: manifest.runId,
      revision: manifest.revision,
      sourceCommit: manifest.sourceCommit ?? null,
      persona: manifest.personas,
      totals: manifest.totals,
      shots: shots.map(shotSummary),
      denied: manifest.denied ?? [],
      notRun: manifest.notRun ?? [],
    };
    const content = [text(summary)];
    let images = 0;
    let bytes = 0;
    for (const shot of shots.filter((item) => item.image)) {
      if (images >= maxImages) break;
      const image = maskedImage(outDir, shot);
      if (!image || bytes + image.bytes > maxImageBytes) continue;
      content.push(text(`masked screenshot: ${shot.image}`), image.block);
      images += 1;
      bytes += image.bytes;
    }
    return fit({ content, structuredContent: plain(summary), _manifest: manifest, _outDir: outDir });
  }

  /**
   * The runner inside the one-capture-at-a-time rule, with the hard time limit. On the limit the signal
   * aborts (the runner closes its browser) and the call answers; the single flight stays held until the
   * runner has really stopped, so a second capture never starts beside a browser still closing.
   */
  function runBounded(start) {
    const controller = new AbortController();
    let timer = null;
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`the capture was stopped at its ${Math.round(callMinutes * 60)}-second limit`));
      }, callMinutes * 60_000);
    });
    const running = flight.run(() => start(controller.signal));
    running.catch(() => {});
    return Promise.race([running, stopped]).finally(() => clearTimeout(timer));
  }

  /** Drops screenshots (each with its label), last first, until the serialized result fits `maxResultBytes`. */
  function fit(result) {
    if (!maxResultBytes) return result;
    const size = () => Buffer.byteLength(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }));
    let dropped = 0;
    while (size() > maxResultBytes) {
      const last = result.content.map((item) => item.type).lastIndexOf("image");
      if (last === -1) break;
      const labelled = last > 0 && /^masked screenshot:/.test(result.content[last - 1]?.text ?? "");
      result.content.splice(labelled ? last - 1 : last, labelled ? 2 : 1);
      dropped += 1;
    }
    if (dropped > 0) result.content.push(text(`${dropped} screenshot(s) left out to fit the ${Math.floor(maxResultBytes / 1_048_576)} MiB transport limit; capture fewer states per call`));
    return result;
  }

  const handlers = {
    phoenix_list_portals_and_modules() {
      const raw = readRepoFile(repoRoot, INVENTORY);
      const inventory = raw ? JSON.parse(raw) : null;
      const portals = {};
      for (const entry of inventory?.entries ?? []) {
        const key = entry.portal;
        portals[key] ??= { pages: new Set(), roles: new Set() };
        portals[key].pages.add(entry.route);
        portals[key].roles.add(entry.role);
      }
      return {
        content: [
          text({
            inventory: inventory ? INVENTORY : "route inventory not generated (node scripts/phoenix-inspect/route-inventory.ts)",
            portals: Object.fromEntries(Object.entries(portals).map(([key, value]) => [key, { distinctPages: value.pages.size, roles: [...value.roles] }])),
            modules: Object.values(MODULES).map((spec) => ({
              id: spec.id,
              title: spec.title,
              personas: spec.personas.map((item) => ({ id: item.id, role: item.role, board: item.shell, scope: item.matrix })),
              states: spec.states.length,
            })),
          }),
        ],
      };
    },
    phoenix_list_module_pages({ module }) {
      const spec = MODULES[module];
      const sample = (shell) => spec.personas.find((item) => item.shell === shell && item.matrix !== "denied");
      return {
        content: [
          text({
            module: spec.id,
            states: spec.states.map((state) => ({
              id: state.id,
              label: state.label,
              boards: state.shells,
              addresses: Object.fromEntries(state.shells.map((shell) => [shell, sample(shell) ? addressFor(sample(shell), state) : null])),
              how: state.mock ? `mock (${state.mock})` : state.click ? "click" : state.keyboard ? "keyboard" : state.followFirst ? "follow the page's first link" : "address",
            })),
            personas: spec.personas.map((item) => ({ id: item.id, role: item.role, board: item.shell, scope: item.matrix })),
            neverTouched: spec.neverTouch.map((rule) => rule.reason),
          }),
        ],
      };
    },
    async phoenix_open_module({ module, persona }) {
      const spec = MODULES[module];
      const landing = spec.states.find((state) => state.landing);
      return capture({ module, persona, states: [landing.id], viewports: ["desktop"] });
    },
    phoenix_capture_page: capture,
    async phoenix_inspect_ui_state({ module, persona, state, viewport }) {
      const result = await capture({ module, persona, states: [state], viewports: [viewport ?? "desktop"] });
      if (result.isError) return result;
      const shot = result._manifest.shots?.[0];
      if (!shot) return result;
      const aria = shot.aria ? insideRun(result._outDir, shot.aria) : null;
      const detail = {
        shot: shotSummary(shot),
        measurementDetail: shot.measurementDetail,
        sourceCandidates: shot.sourceCandidates,
        redaction: shot.redaction,
        writesStopped: shot.writesStopped,
        console: shot.console,
        scrollers: shot.scrollers,
        steps: shot.steps,
      };
      const content = [text(detail)];
      if (aria) content.push(text(`masked accessibility snapshot:\n${clip(readFileSync(aria, "utf8"), 20_000)}`));
      const image = maskedImage(result._outDir, shot);
      if (image && image.bytes <= maxImageBytes) content.push(image.block);
      return fit({ content, structuredContent: plain(detail) });
    },
    phoenix_get_component_map({ module }) {
      const doc = readRepoFile(repoRoot, MODULE_DOCS[module].componentMap);
      return { content: [text(doc ? clip(doc) : "The component map has not been written yet.")] };
    },
    phoenix_get_visual_audit({ module, runId }) {
      const doc = readRepoFile(repoRoot, MODULE_DOCS[module].audit);
      const content = [text(doc ? clip(doc) : "The visual audit has not been written yet.")];
      if (runId) {
        const file = path.join(repoRoot, ...RUN_ROOT, module, runId, "manifest.json");
        if (!existsSync(file)) content.push(text(`run ${runId} is not on this machine`));
        else {
          const manifest = JSON.parse(readFileSync(file, "utf8"));
          content.push(text({ runId, revision: manifest.revision, totals: manifest.totals, shots: (manifest.shots ?? []).map(shotSummary), denied: manifest.denied, notRun: manifest.notRun }));
        }
      }
      return { content };
    },
    phoenix_get_implementation_plan({ module }) {
      const plan = readRepoFile(repoRoot, MODULE_DOCS[module].plan);
      const prompt = readRepoFile(repoRoot, MODULE_DOCS[module].prompt);
      return {
        content: [
          text(plan ? clip(plan, 40_000) : "The premium-polish plan has not been written yet."),
          text(prompt ? clip(prompt, 20_000) : "The second-stage prompt has not been written yet."),
        ],
      };
    },
  };

  /**
   * One tool call. `observe`, when given, receives the same record the audit log gets (validated ids,
   * outcome, ms; never a refused input) — the HTTP door folds it into its own per-request audit line.
   * @param {string} name
   * @param {unknown} [args]
   * @param {(record: Record<string, unknown>) => void} [observe]
   */
  async function call(name, args, observe) {
    const started = now();
    const record = { at: cairoStamp(new Date(started)).text, tool: null, outcome: "refused-input" };
    try {
      const tool = tools.find((item) => item.name === name);
      if (!tool) return refusal("refused: unknown tool");
      record.tool = tool.name;
      if (!limiter.take()) {
        record.outcome = "rate-limited";
        return refusal(`refused: more than ${RUN_BOUNDS.toolCallsPerMinute} calls in a minute; wait and ask again`);
      }
      const checked = validateToolInput(args ?? {}, { modules: MODULES, allowedKeys: Object.keys(tool.inputSchema.properties) });
      if (!checked.ok) return refusal(`refused: ${checked.errors.join("; ")}`);
      const missing = tool.inputSchema.required.filter((key) => !(key in checked.value));
      if (missing.length > 0) return refusal(`refused: missing ${missing.join(", ")}`);
      // Only validated ids reach the audit log.
      for (const key of ["module", "persona", "state", "viewport", "runId"]) if (key in checked.value) record[key] = checked.value[key];
      if (checked.value.states) record.states = checked.value.states.length;
      const result = await handlers[tool.name](checked.value);
      record.outcome = result.isError ? "refused" : "ok";
      if (result._manifest) record.totals = result._manifest.totals;
      const { _manifest, _outDir, ...clean } = result;
      return clean;
    } catch (error) {
      record.outcome = /another capture is already running/.test(error.message) ? "busy" : /second limit/.test(error.message) ? "time-limit" : "error";
      return refusal(`${record.outcome === "busy" ? "refused" : "failed"}: ${String(error.message).slice(0, 300)}`);
    } finally {
      record.ms = now() - started;
      audit(record);
      try {
        observe?.(record);
      } catch (error) {
        console.error(`audit observer failed: ${error.message}`);
      }
    }
  }

  return { tools, call };
}

/**
 * The MCP protocol server over an inspector: tools/list and tools/call, nothing else. The stdio door
 * builds one for the process; the HTTP door builds one per request (stateless), sharing the inspector so
 * the rate limit and the one-capture-at-a-time rule hold across requests.
 * @param {{ tools: Array<{ name: string, description: string, inputSchema: Record<string, unknown>, annotations: Record<string, unknown> }>, call: (name: string, args?: unknown, observe?: (record: Record<string, unknown>) => void) => Promise<Record<string, unknown>> }} inspector
 * @param {{ observe?: (record: Record<string, unknown>) => void }} [options]
 */
export async function buildMcpServer(inspector, { observe } = {}) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "phoenix-inspect", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: inspector.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => inspector.call(request.params.name, request.params.arguments, observe));
  return server;
}

/**
 * The checkout's own commit, `+dirty` when tracked files changed, or null: the SOURCE revision a capture
 * was read beside, recorded apart from the staging deployment's revision (the manifest's `revision`).
 */
export function sourceCommitOf(repoRoot = REPO_ROOT) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? `${sha}${dirty ? "+dirty" : ""}` : null;
  } catch {
    return null;
  }
}

/** Runs the explorer in this process (the machine holding the credentials file). */
export function localRunner(repoRoot = REPO_ROOT) {
  return async (options) => {
    const { runExplorer } = await import("./explore.mjs");
    return runExplorer({ sourceCommit: sourceCommitOf(repoRoot) ?? undefined, ...options, out: path.join(repoRoot, ...RUN_ROOT) });
  };
}

/** Sends the run to the spare laptop through on-spare.ps1 and reads the copied-back manifest. */
export function spareRunner(repoRoot = REPO_ROOT) {
  return (options) =>
    new Promise((resolve, reject) => {
      const args = [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "on-spare.ps1"), "explore",
        "--module", options.module, "--personas", options.personas.join(","), "--states", options.states.join(","),
        "--viewports", options.viewports.join(","), "--run-id", options.runId, "--max-minutes", String(options.maxMinutes),
      ];
      const child = spawn("powershell.exe", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let tail = "";
      const keep = (chunk) => {
        tail = `${tail}${chunk}`.slice(-2_000);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const timer = setTimeout(() => child.kill(), (options.maxMinutes + 5) * 60_000);
      options.signal?.addEventListener("abort", () => child.kill(), { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const outDir = path.join(repoRoot, ...RUN_ROOT, options.module, options.runId);
        const file = path.join(outDir, "manifest.json");
        if (existsSync(file)) resolve({ outDir, manifest: JSON.parse(readFileSync(file, "utf8")) });
        else reject(new Error(`the spare returned no manifest: ${tail.split("\n").filter(Boolean).slice(-2).join(" / ")}`));
      });
    });
}

async function main() {
  const argv = process.argv.slice(2);
  const asked = argv.includes("--runner") ? argv[argv.indexOf("--runner") + 1] : null;
  const spareReady = process.platform === "win32" && existsSync(path.join(os.homedir(), ".claude", "scripts", "spare-address.ps1"));
  const mode = asked ?? (spareReady ? "spare" : "local");
  if (!["spare", "local"].includes(mode)) throw new Error("--runner must be spare or local");
  const inspector = createInspector({ runner: mode === "spare" ? spareRunner() : localRunner() });

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = await buildMcpServer(inspector);
  await server.connect(new StdioServerTransport());
  console.error(`phoenix-inspect MCP server ready (stdio, runner: ${mode}, target: staging only)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
