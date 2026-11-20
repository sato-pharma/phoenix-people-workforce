/**
 * The capture viewer — the small page ChatGPT shows inside the conversation for the screenshot and
 * video tools (an MCP Apps view, the same mechanism as the staging inspector's scripts/phoenix-inspect/widget.mjs).
 *
 * Why it exists: ChatGPT shows neither the person nor the model a tool's image block on its own (live
 * test, 17 Nov 2026). A view named in the tool's `_meta.ui.resourceUri` is the one way a connector
 * puts its own picture, or a playable video, into the conversation.
 *
 * What the page does, and nothing else:
 *   - Speaks the MCP Apps bridge (JSON-RPC 2.0 over postMessage to window.parent): `ui/initialize`,
 *     `ui/notifications/initialized`, receives `ui/notifications/tool-result`, reports its height.
 *   - Shows the screenshot from the result's image block, and plays the video from the result's
 *     `_meta["phoenix/video"]` (a data address), or — when the video was too big to send — links it.
 *   - Fetches nothing: no external script, style, font or image. Text is set with textContent.
 *
 * The URI is versioned because ChatGPT caches a view by its URI: change the page, bump it.
 */

export const CAPTURE_VIEWER_URI = "ui://phoenix/capture-v1.html";
export const CAPTURE_VIEWER_MIME = "text/html;profile=mcp-app";
export const VIDEO_META_KEY = "phoenix/video";
/** The screenshot again, for a host that hands the view only `window.openai` (no image blocks). */
export const IMAGE_META_KEY = "phoenix/image";

/** The `_meta` a capture tool's descriptor carries, linking it to the viewer. */
export function captureToolMeta(invoking: string, invoked: string): Record<string, unknown> {
  return {
    ui: { resourceUri: CAPTURE_VIEWER_URI },
    "openai/outputTemplate": CAPTURE_VIEWER_URI,
    "openai/widgetAccessible": false,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

export function captureViewerResource() {
  return {
    uri: CAPTURE_VIEWER_URI,
    mimeType: CAPTURE_VIEWER_MIME,
    text: captureViewerHtml(),
    _meta: {
      ui: { prefersBorder: true },
      "openai/widgetDescription": "The screenshot or video of a live Phoenix page that the capture tool returned.",
      "openai/widgetPrefersBorder": true,
    },
  };
}

export function captureViewerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phoenix capture</title>
<style>
:root { --ink:#0b1f3a; --muted:#5b6b80; --rule:#d5dbe3; --paper:#ffffff; --blue:#1f5fbf; --flag:#9a3412; }
:root[data-theme="dark"] { --ink:#e8edf4; --muted:#9aa8ba; --rule:#2c3a4d; --paper:#0f1724; --blue:#7fa8e8; --flag:#f0a37a; }
* { box-sizing:border-box; border-radius:0; }
html, body { margin:0; background:var(--paper); color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { padding:14px 16px 16px; }
.micro { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
h1 { font-size:16px; font-weight:600; margin:2px 0 10px; overflow-wrap:anywhere; }
.meta { display:flex; flex-wrap:wrap; gap:4px 14px; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); padding:8px 0; margin-bottom:12px; }
.meta b { font-weight:600; color:var(--ink); }
figure { margin:0 0 12px; }
figure img, video { display:block; width:100%; height:auto; border:1px solid var(--rule); background:var(--paper); }
figure img { cursor:zoom-in; }
figure.full img { cursor:zoom-out; }
figcaption { margin-top:6px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
a { color:var(--blue); overflow-wrap:anywhere; }
.status { padding:10px 0; color:var(--muted); }
.error { color:var(--flag); }
</style>
</head>
<body>
<main id="app"><p class="status">Waiting for the capture…</p></main>
<script>
(() => {
  "use strict";
  const app = document.getElementById("app");
  const pending = new Map();
  let nextId = 1;

  const post = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
      setTimeout(() => { if (pending.delete(id)) reject(new Error(method + " got no answer")); }, 30000);
    });
  const notify = (method, params) => post({ method, params: params || {} });

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  function reportSize() {
    notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) });
  }
  function status(text, isError) {
    app.replaceChildren(el("p", isError ? "status error" : "status", text));
    reportSize();
  }
  function safeLink(url) {
    return typeof url === "string" && /^https:\\/\\//.test(url) ? url : null;
  }

  function render(result, metaFallback) {
    if (!result) return;
    if (result.isError) {
      const first = (result.content || []).find((item) => item && item.type === "text");
      return status(first ? first.text : "The capture failed.", true);
    }
    const sc = result.structuredContent || {};
    const data = sc.data || {};
    const meta = result._meta || metaFallback || {};
    const page = document.createDocumentFragment();
    page.append(el("div", "micro", "Phoenix · live · read-only capture"));
    page.append(el("h1", "", data.title || data.page || "Capture"));
    const facts = el("div", "meta micro");
    const pages = Array.isArray(data.pages) ? data.pages.map((p) => p && p.path).filter(Boolean).join(", ") : data.page;
    for (const [name, value] of [["Page", pages], ["Screen", data.viewport], ["Seen as", data.seen_as], ["Taken", data.taken_at_cairo]]) {
      if (!value) continue;
      const item = el("span", "", name + " ");
      item.append(el("b", "", value));
      facts.append(item);
    }
    page.append(facts);

    const blocks = (result.content || []).filter((item) => item && item.type === "image");
    const metaImage = meta[${JSON.stringify(IMAGE_META_KEY)}];
    if (blocks.length === 0 && metaImage && typeof metaImage === "object") blocks.push({ type: "image", data: metaImage.data, mimeType: metaImage.mimeType });
    blocks.forEach((item) => {
      if (!item || item.type !== "image" || typeof item.data !== "string" || !/^image\\/(jpeg|png)$/.test(item.mimeType || "")) return;
      const figure = el("figure");
      const img = el("img");
      img.alt = "Screenshot of " + (data.title || data.page || "a Phoenix page");
      img.src = "data:" + item.mimeType + ";base64," + item.data;
      img.addEventListener("load", reportSize);
      img.addEventListener("click", () => {
        figure.classList.toggle("full");
        request("ui/request-display-mode", { mode: figure.classList.contains("full") ? "fullscreen" : "inline" }).catch(() => {});
      });
      figure.append(img);
      page.append(figure);
    });

    const video = meta[${JSON.stringify(VIDEO_META_KEY)}];
    if (video && typeof video === "object") {
      const figure = el("figure");
      if (typeof video.data === "string" && /^video\\/(mp4|webm)$/.test(video.mimeType || "")) {
        const player = el("video");
        player.controls = true;
        player.muted = true;
        player.playsInline = true;
        player.src = "data:" + video.mimeType + ";base64," + video.data;
        player.addEventListener("loadedmetadata", reportSize);
        figure.append(player);
      } else {
        figure.append(el("p", "status", "The video is too large to play here."));
      }
      page.append(figure);
    }

    const link = safeLink(data.download_url);
    if (link) {
      const line = el("p", "micro");
      const anchor = el("a", "", data.kind === "video" ? "Open the video" : "Open the full-size picture");
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      line.append(anchor, document.createTextNode(" · for you only, while signed in to Phoenix"));
      page.append(line);
    }
    if (typeof data.writes_stopped === "number" && data.writes_stopped > 0) {
      page.append(el("p", "micro", data.writes_stopped + " request(s) that would have changed something were stopped. Nothing was saved."));
    }
    app.replaceChildren(page);
    reportSize();
  }

  function theme(context) {
    if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "error"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") render(message.params || {});
    else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
    else if (message.method === "ui/resource-teardown" && message.id !== undefined) post({ id: message.id, result: {} });
  });

  // The window.openai globals, where the host provides them instead.
  function fromGlobals() {
    const openai = window.openai;
    if (!openai) return;
    theme({ theme: openai.theme });
    if (openai.toolOutput && !app.querySelector("figure")) {
      render({ structuredContent: openai.toolOutput, content: [] }, openai.toolResponseMetadata || {});
    }
  }
  window.addEventListener("openai:set_globals", fromGlobals);
  fromGlobals();

  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "phoenix-capture", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  })
    .then((result) => { theme(result && result.hostContext); notify("ui/notifications/initialized"); })
    .catch(() => notify("ui/notifications/initialized"));
})();
</script>
</body>
</html>
`;
}
