/**
 * The ChatGPT connector's screenshot and video tools (src/lib/chatgpt-connector/browser/, tools/screens.ts).
 *
 * Owner, 20 Nov 2026: "I WANT THE CINNECTER BE ABLE TO TAKE SCEEN SHOTS AND RE CORD VIDEOS" — on the
 * live data connector, as the owner or the CEO. Nothing here opens a browser: the pieces that decide
 * what a capture may touch are pure and are tested directly.
 *
 *   1. The request fence: GET and HEAD only, no Server Action, no never-touch path, no side-effect API
 *      route, no page whose server render writes, no plain http off the box, and CLOSED when the
 *      source-built list cannot be read.
 *   2. The page path ChatGPT asks for: inside Phoenix only, never /api, never a render-writer page,
 *      query kept.
 *   3. The ffmpeg arguments for both codecs, and the loopback origin the browser signs in to.
 *   4. The capture viewer fetches nothing from outside and reads the video from `_meta`.
 *   5. Both tools are listed for both seats, marked read-only and linked to the viewer; a capture's
 *      picture goes out as an image block, its video in `_meta`, and never as base64 in the text.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAccessContext } from "@/lib/auth/permissions";
import { captureOrigin, ffmpegArgs, VIDEO_RECORD_MS, videoPageBudgetMs } from "@/lib/chatgpt-connector/browser/capture";
import {
  checkCapturePath,
  classifyCaptureRequest,
  loadSideEffectRoutes,
  parseSideEffectRoutes,
  routePatternToRegex,
  SIDE_EFFECT_ROUTES_FILE,
  type SideEffectRoutes,
} from "@/lib/chatgpt-connector/browser/fence";
import { CAPTURE_VIEWER_URI, captureViewerHtml, IMAGE_META_KEY, VIDEO_META_KEY } from "@/lib/chatgpt-connector/browser/viewer";
import { allConnectorTools, buildConnectorServer, runConnectorTool, toolsForRole } from "@/lib/chatgpt-connector/server";
import { CONNECTOR_FILE_CONTENT_TYPES } from "@/lib/chatgpt-connector/files";
import { recordVideoTool } from "@/lib/chatgpt-connector/tools/screens";
import { defineTool, type ConnectorTool } from "@/lib/chatgpt-connector/types";

const ORIGIN = "http://127.0.0.1:8080";

function fixtureRoutes(): SideEffectRoutes {
  return parseSideEffectRoutes(
    JSON.stringify({
      apiRoutes: [{ pattern: "/api/admin/activity/timeline" }, { pattern: "/api/things/:id/act" }],
      renderWriterPages: [{ pattern: "/employee-portals/incentive" }, { pattern: "/employee-portals/marketing-requests/decision/:requestId" }],
    }),
  );
}

function requestFence() {
  const routes = fixtureRoutes();
  assert.equal(routes.ok, true);
  const policy = { origin: ORIGIN, sameAppOrigins: ["https://phoenix-hr.satopharma.com"], routes };
  const decide = (method: string, url: string, headers?: Record<string, string>) => classifyCaptureRequest({ method, url, headers }, policy);

  assert.deepEqual(decide("GET", `${ORIGIN}/admin/employees`), { allow: true }, "a plain page read passes");
  assert.deepEqual(decide("HEAD", `${ORIGIN}/admin/employees`), { allow: true });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(decide(method, `${ORIGIN}/api/employees`), { allow: false, reason: "write-method" }, `${method} is stopped`);
  }
  assert.deepEqual(decide("GET", `${ORIGIN}/admin/employees`, { "Next-Action": "abc" }), { allow: false, reason: "server-action" }, "a Server Action is stopped even as a GET");
  assert.deepEqual(decide("GET", `${ORIGIN}/api/admin/activity/timeline`), { allow: false, reason: "side-effect-route" });
  assert.deepEqual(decide("GET", `${ORIGIN}/api/things/42/act`), { allow: false, reason: "side-effect-route" }, "a :param pattern matches");
  assert.deepEqual(decide("GET", `${ORIGIN}/employee-portals/incentive`), { allow: false, reason: "render-writer-page" });
  assert.deepEqual(decide("GET", `${ORIGIN}/logout`), { allow: false, reason: "never-touch-path" });
  assert.deepEqual(decide("GET", `${ORIGIN}/admin/payroll/export`), { allow: false, reason: "never-touch-path" });
  assert.deepEqual(decide("GET", `${ORIGIN}/api/cron/anything`), { allow: false, reason: "never-touch-path" });
  assert.deepEqual(decide("GET", `${ORIGIN}/api/employees/B-10/photo`), { allow: false, reason: "never-touch-api-shape" });
  assert.deepEqual(decide("GET", "https://phoenix-hr.satopharma.com/logout"), { allow: false, reason: "never-touch-path" }, "the public address is held to the same rules");
  assert.deepEqual(decide("GET", "https://fonts.example.test/a.woff2"), { allow: true }, "an https font or tile from another site passes");
  assert.deepEqual(decide("GET", "http://tiles.example.test/1.png"), { allow: false, reason: "insecure-off-origin" });
  assert.deepEqual(decide("GET", "ftp://example.test/x"), { allow: false, reason: "scheme" });
  assert.deepEqual(decide("GET", "data:image/png;base64,AAAA"), { allow: true });

  // Fails closed: a missing or malformed list stops every same-app request.
  for (const text of ["", "{", JSON.stringify({ apiRoutes: [], renderWriterPages: [] }), JSON.stringify({ apiRoutes: [{ pattern: "/api/x" }] })]) {
    const broken = parseSideEffectRoutes(text);
    assert.equal(broken.ok, false, `list ${JSON.stringify(text).slice(0, 40)} is not trusted`);
    assert.deepEqual(classifyCaptureRequest({ method: "GET", url: `${ORIGIN}/admin/employees` }, { origin: ORIGIN, routes: broken }), {
      allow: false,
      reason: "side-effect-list-unreadable",
    });
  }
  assert.equal(loadSideEffectRoutes(path.join(process.cwd(), "no-such-folder")).ok, false, "an unreadable file is not trusted");

  assert.ok(routePatternToRegex("/api/a/**").test("/api/a/b/c"));
  assert.ok(!routePatternToRegex("/api/a/:id").test("/api/a/b/c"));
}

function capturePath() {
  const routes = fixtureRoutes();
  assert.deepEqual(checkCapturePath("/admin/employees?tab=active", routes), { ok: true, path: "/admin/employees?tab=active" }, "the query is kept");
  assert.deepEqual(checkCapturePath("  /employee-portal  ", routes), { ok: true, path: "/employee-portal" });
  for (const bad of ["", "admin/employees", "https://evil.example/x", "//evil.example/x", "/\\evil", "/api/employees", "/api", "/employee-portals/incentive", "/logout", 42, null]) {
    const checked = checkCapturePath(bad, routes);
    assert.equal(checked.ok, false, `${JSON.stringify(bad)} is refused`);
  }
  const notOk = checkCapturePath("/admin/employees", parseSideEffectRoutes("{"));
  assert.equal(notOk.ok, false, "no list, no capture");
  assert.ok(!notOk.ok && /safety list/.test(notOk.reason));

  // The real, source-built list is shipped and readable, and refuses its own render-writer pages.
  const real = parseSideEffectRoutes(readFileSync(path.join(process.cwd(), SIDE_EFFECT_ROUTES_FILE), "utf8"));
  assert.equal(real.ok, true, "the generated side-effect list parses");
  assert.equal(checkCapturePath("/employee-portals/incentive", real).ok, false);

  const nextConfig = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  assert.ok(nextConfig.includes("./scripts/phoenix-inspect/generated/side-effect-routes.json"), "the list is traced into the production build");
  const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  const apkLines = [...dockerfile.matchAll(/RUN apk add(?:[^\n]*\\\n)*[^\n]*/g)].map((match) => match[0]);
  assert.ok(apkLines.some((line) => /\bffmpeg\b/.test(line) && /\bchromium\b/.test(line)), "the runner image installs ffmpeg beside chromium for the video tool");
}

function encoderAndOrigin() {
  const h264 = ffmpegArgs(8, "h264", "/tmp/out.mp4");
  assert.deepEqual(h264.slice(h264.indexOf("-framerate"), h264.indexOf("-framerate") + 2), ["-framerate", "8.000"]);
  assert.ok(h264.includes("libx264") && h264.includes("yuv420p") && h264.includes("+faststart"));
  assert.equal(h264.at(-1), "/tmp/out.mp4");
  assert.ok(h264.includes("-an"), "no sound track");
  const vp8 = ffmpegArgs(6.5, "vp8", "/tmp/out.webm");
  assert.ok(vp8.includes("vp8") && vp8.includes("webm"));
  assert.equal(vp8.at(-1), "/tmp/out.webm");

  assert.equal(captureOrigin({}), "http://127.0.0.1:3000");
  assert.equal(captureOrigin({ PORT: "8080" }), "http://127.0.0.1:8080");
  assert.equal(captureOrigin({ PORT: "8080", PHOENIX_CAPTURE_ORIGIN: "http://localhost:9999/ignored/path" }), "http://localhost:9999");
}

function viewerPage() {
  const html = captureViewerHtml();
  assert.ok(!/<script[^>]+src=/i.test(html), "no external script");
  assert.ok(!/<link[^>]+href=/i.test(html), "no external stylesheet or font");
  assert.ok(!/@import|url\(/i.test(html), "no CSS fetch");
  assert.ok(!/innerHTML/.test(html), "text is set with textContent, never innerHTML");
  assert.ok(html.includes(JSON.stringify(VIDEO_META_KEY)) && html.includes(JSON.stringify(IMAGE_META_KEY)), "the video and fallback picture are read from _meta");
  assert.ok(html.includes("ui/notifications/tool-result") && html.includes("ui/initialize"), "it speaks the MCP Apps bridge");
  assert.ok(/border-radius:0/.test(html), "square edges");
}

async function toolsAndResult() {
  const names = allConnectorTools().map((tool) => tool.name);
  for (const name of ["phoenix_screenshot_page", "phoenix_record_video"]) {
    assert.ok(names.includes(name), `${name} is a connector tool`);
    for (const role of ["Super Admin", "CEO"]) {
      assert.ok(toolsForRole(role).some((tool) => tool.name === name && tool.viewer === true), `${name} is open to ${role} and uses the viewer`);
    }
  }
  const screens = readFileSync(path.join(process.cwd(), "src/lib/chatgpt-connector/tools/screens.ts"), "utf8");
  assert.equal((screens.match(/checkCapturePath\(/g) ?? []).length, 2, "both tools check the path before any browser opens");

  // The examples ChatGPT is shown are real pages. The first live capture asked for /admin/employees,
  // the tool's own example, and got a 404: "(admin)" is a route group and adds nothing to the address.
  const fence = readFileSync(path.join(process.cwd(), "src/lib/chatgpt-connector/browser/fence.ts"), "utf8");
  const groups = readdirSync(path.join(process.cwd(), "app")).filter((name) => /^\(.+\)$/.test(name));
  const examples = [...`${screens}\n${fence}`.matchAll(/for example ((?:\/[a-z0-9-]+)+)(?: or ((?:\/[a-z0-9-]+)+))?/g)].flatMap((match) => match.slice(1).filter(Boolean));
  assert.ok(examples.length >= 3, "the tool's description and the path hint both give example pages");
  for (const example of examples) {
    const candidates = ["", ...groups].map((group) => path.join(process.cwd(), "app", group, example, "page.tsx"));
    assert.ok(candidates.some((file) => existsSync(file)), `${example}, an example page shown to ChatGPT, is a real Phoenix page`);
  }

  const ctx = createAccessContext({ hrId: "B-10", loginId: "owner", role: "Super Admin", source: "session" });
  const picture = Buffer.from("not really a jpeg").toString("base64");
  const video = Buffer.from("not really a video").toString("base64");
  const capture = defineTool({
    name: "phoenix_test_capture",
    title: "Capture",
    description: "test",
    input: {},
    viewer: true,
    run: async () => ({
      summary: "Screenshot taken.",
      data: { kind: "screenshot", download_url: "https://phoenix.example.test/api/connector/files/1" },
      attachments: [
        { type: "image", mimeType: "image/jpeg", data: picture, label: "Employees" },
        { type: "video", mimeType: "video/mp4", data: video, url: "https://phoenix.example.test/api/connector/files/2", label: "Employees" },
      ],
    }),
  });
  const result = await runConnectorTool(ctx, capture as unknown as ConnectorTool, {}, { audit: async () => undefined });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(result.content[1], { type: "image", data: picture, mimeType: "image/jpeg" }, "the picture is an image block");
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.ok(!text.includes(picture) && !text.includes(video), "no base64 in the text ChatGPT reads");
  assert.deepEqual(result._meta?.[VIDEO_META_KEY], { data: video, mimeType: "video/mp4", url: "https://phoenix.example.test/api/connector/files/2" });
  assert.deepEqual(result._meta?.[IMAGE_META_KEY], { data: picture, mimeType: "image/jpeg" });

  const plain = defineTool({ name: "phoenix_test_plain", title: "Plain", description: "test", input: {}, run: async () => ({ summary: "ok", data: null }) });
  const plainResult = await runConnectorTool(ctx, plain as unknown as ConnectorTool, {}, { audit: async () => undefined });
  assert.equal(plainResult._meta, undefined, "a tool without media carries no _meta");
  assert.equal(plainResult.content.length, 1);

  // The server lists the viewer resource only when a tool uses it, and links the tool to it.
  const server = buildConnectorServer(ctx, [capture as unknown as ConnectorTool, plain as unknown as ConnectorTool]);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const listed = await client.listTools();
  const captureTool = listed.tools.find((tool) => tool.name === "phoenix_test_capture");
  const plainTool = listed.tools.find((tool) => tool.name === "phoenix_test_plain");
  assert.equal((captureTool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri, CAPTURE_VIEWER_URI);
  assert.equal(captureTool?.annotations?.readOnlyHint, true);
  assert.equal(plainTool?._meta, undefined);
  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri), [CAPTURE_VIEWER_URI]);
  const read = await client.readResource({ uri: CAPTURE_VIEWER_URI });
  assert.equal(read.contents[0].mimeType, "text/html;profile=mcp-app");
  await client.close();
  await server.close();

  const bare = buildConnectorServer(ctx, [plain as unknown as ConnectorTool]);
  const [bareClientSide, bareServerSide] = InMemoryTransport.createLinkedPair();
  await bare.connect(bareServerSide);
  const bareClient = new Client({ name: "test", version: "1.0.0" });
  await bareClient.connect(bareClientSide);
  const bareListed = await bareClient.listTools();
  assert.deepEqual(bareListed.tools.map((tool) => tool.name), ["phoenix_test_plain"]);
  await bareClient.close();
  await bare.close();
}

/**
 * The bucket accepts every type the connector stores. On 20 Nov 2026 both screenshots ChatGPT asked
 * for failed on production with "mime type image/png is not supported": the job-exports bucket's
 * type list (20261119013709) predated the capture tools. The newest migration that sets that list
 * must name every CONNECTOR_FILE_CONTENT_TYPES value.
 */
function storageAcceptsEveryKind() {
  const dir = path.join(process.cwd(), "supabase/migrations");
  const pattern = /allowed_mime_types = array\[([^\]]*)\]\s*where id = 'job-exports'/;
  const latest = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => pattern.exec(readFileSync(path.join(dir, name), "utf8")))
    .filter((match): match is RegExpExecArray => match !== null)
    .at(-1);
  assert.ok(latest, "a migration sets job-exports' allowed_mime_types");
  const allowed = [...latest[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  for (const [kind, type] of Object.entries(CONNECTOR_FILE_CONTENT_TYPES)) {
    assert.ok(allowed.includes(type), `job-exports accepts ${type}, the type the connector stores a ${kind} under`);
  }
  assert.ok(allowed.includes("application/json"), "the background worker's JSON exports stay accepted");
}

/**
 * A length the person names is the video's length. On 20 Nov 2026 the owner asked ChatGPT for "a
 * 10-second video of /employees" and got 3.4 s: the tool had no length, and a page one and a half
 * screens tall reached its bottom in one scroll step, which ended the recording.
 */
function videoLength() {
  const seconds = recordVideoTool.input.seconds;
  assert.ok(seconds, "the video tool takes a seconds option");
  assert.equal(seconds.safeParse(10).success, true, "10 seconds is accepted");
  assert.equal(seconds.safeParse(undefined).success, true, "the length stays optional");
  for (const bad of [1, 17, 2.5]) assert.equal(seconds.safeParse(bad).success, false, `${bad} is refused`);
  assert.match(recordVideoTool.description, /seconds/, "the description tells ChatGPT the length can be asked for");

  // Asked for 10 s on one page: the whole 10 s goes to that page, past the 9 s cap of an unasked video.
  assert.equal(videoPageBudgetMs({ targetMs: 10_000, recordedMs: 0, pagesLeft: 1 }), 10_000);
  // Shared by the pages still to come, from what is left of the asked length.
  assert.equal(videoPageBudgetMs({ targetMs: 12_000, recordedMs: 0, pagesLeft: 3 }), 4_000);
  assert.equal(videoPageBudgetMs({ targetMs: 12_000, recordedMs: 5_000, pagesLeft: 2 }), 3_500);
  // Never past the 16 s ceiling, and nothing once the asked length is used.
  assert.equal(videoPageBudgetMs({ targetMs: 60_000, recordedMs: 0, pagesLeft: 1 }), VIDEO_RECORD_MS);
  assert.equal(videoPageBudgetMs({ targetMs: 8_000, recordedMs: 9_000, pagesLeft: 1 }), 0);
  // Not asked: unchanged, up to 9 s a page.
  assert.equal(videoPageBudgetMs({ recordedMs: 0, pagesLeft: 1 }), 9_000);
  assert.equal(videoPageBudgetMs({ recordedMs: 12_000, pagesLeft: 1 }), 4_000);

  // The recorder holds a page at its bottom for its share when a length was asked.
  const capture = readFileSync(path.join(process.cwd(), "src/lib/chatgpt-connector/browser/capture.ts"), "utf8");
  assert.match(capture, /hold\(targetMs === undefined \? 900 : Math\.max\(0, pageEnd - Date\.now\(\)\), pageEnd\)/, "an asked length holds the page until its share is used");
  const screens = readFileSync(path.join(process.cwd(), "src/lib/chatgpt-connector/tools/screens.ts"), "utf8");
  assert.match(screens, /recordPages\(ctx, \{ paths, viewport: screen, routes, seconds: input\.seconds \}\)/, "the asked length reaches the recorder");
}

export async function runChatgptConnectorCaptureTests() {
  storageAcceptsEveryKind();
  videoLength();
  requestFence();
  capturePath();
  encoderAndOrigin();
  viewerPage();
  await toolsAndResult();
}
