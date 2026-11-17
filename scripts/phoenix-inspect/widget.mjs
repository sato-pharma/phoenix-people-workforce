/**
 * Phoenix Inspect — the screenshot viewer ChatGPT shows inside the conversation (an MCP Apps view).
 *
 * Why: ChatGPT does not pass a tool's image block to the model or show it in the reply (live test,
 * 17 Nov 2026: every measurement arrived, the picture did not). An MCP Apps view is the one way a custom
 * MCP server puts its own picture in the conversation. The capture tools name this page in
 * `_meta.ui.resourceUri`; ChatGPT reads it once with resources/read and renders it in a sandboxed frame.
 *
 * What the page does, and nothing else:
 *   - It talks to ChatGPT over the MCP Apps postMessage bridge (JSON-RPC 2.0 to window.parent): it sends
 *     `ui/initialize`, then `ui/notifications/initialized`, and receives `ui/notifications/tool-result`.
 *   - It shows the masked JPEG previews that the result already carries in `content`, each under its
 *     own label, and the measurements from `structuredContent`. The pictures are the same masked pixels
 *     the tool returns; nothing is fetched from anywhere.
 *   - A capture still running ("status: capturing") is collected by calling phoenix_get_capture through
 *     the bridge's `tools/call`, a few times at most.
 *   - It reports its height with `ui/notifications/size-changed`.
 *
 * Self-contained: no external script, style, font or image, so the host's default CSP (img-src 'self'
 * data:; connect-src 'none') is all it needs. Text from the result is set with textContent, never parsed
 * as HTML. The URI is versioned because ChatGPT caches a view by its URI: change the page, bump it.
 */

export const WIDGET_URI = "ui://phoenix-inspect/screenshot-v1.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";
/** The tools whose results the viewer renders: every tool that returns a capture. */
export const WIDGET_TOOLS = Object.freeze(["phoenix_open_module", "phoenix_capture_page", "phoenix_inspect_ui_state", "phoenix_get_capture"]);

/** The `_meta` a capture tool's descriptor carries, linking it to the viewer. */
export function widgetToolMeta() {
  return {
    ui: { resourceUri: WIDGET_URI },
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Capturing on staging",
    "openai/toolInvocation/invoked": "Capture ready",
  };
}

/** The resources/list entry. */
export function widgetListing() {
  return {
    uri: WIDGET_URI,
    name: "phoenix-inspect-screenshot",
    title: "Phoenix Inspector screenshot",
    description: "Shows a capture's masked staging screenshot and its measurements in the conversation.",
    mimeType: WIDGET_MIME,
  };
}

/** The resources/read contents. */
export function widgetResource() {
  return {
    uri: WIDGET_URI,
    mimeType: WIDGET_MIME,
    text: widgetHtml(),
    _meta: {
      ui: { prefersBorder: true },
      "openai/widgetDescription": "The masked staging screenshot and its measurements, as the capture tool returned them.",
      "openai/widgetPrefersBorder": true,
    },
  };
}

const MEASURES = [
  ["horizontalOverflowPx", "Horizontal overflow", "px"],
  ["roundedElements", "Rounded elements", ""],
  ["ellipsisCuts", "Ellipsis cuts", ""],
  ["distinctFontSizes", "Font sizes", ""],
  ["nonTokenTextColours", "Off-token text colours", ""],
  ["nonTokenBackgrounds", "Off-token backgrounds", ""],
  ["smallTapTargets", "Small tap targets", ""],
  ["lowContrastText", "Low-contrast text", ""],
  ["contrastUnmeasured", "Contrast not measured", ""],
  ["internalScrollers", "Internal scrollers", ""],
];

export function widgetHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phoenix Inspector</title>
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
figure { margin:0 0 14px; }
figure img { display:block; width:100%; height:auto; border:1px solid var(--rule); cursor:zoom-in; }
figure.full img { cursor:zoom-out; }
figcaption { margin-top:6px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
table { width:100%; table-layout:fixed; border-collapse:collapse; }
td { padding:5px 0; border-bottom:1px solid var(--rule); vertical-align:top; overflow-wrap:anywhere; }
td.v { text-align:right; font-variant-numeric:tabular-nums; width:34%; }
td.v.flag { color:var(--flag); font-weight:600; }
.shot + .shot { margin-top:18px; padding-top:14px; border-top:1px solid var(--ink); }
.status { padding:10px 0; color:var(--muted); }
.error { color:var(--flag); }
</style>
</head>
<body>
<main id="app"><p class="status">Waiting for the capture…</p></main>
<script>
(() => {
  "use strict";
  const MEASURES = ${JSON.stringify(MEASURES)};
  const app = document.getElementById("app");
  const pending = new Map();
  let nextId = 1;
  let input = null;
  let collecting = 0;

  const post = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(method + " got no answer"));
      }, 60000);
    });
  const notify = (method, params) => post({ method, params: params || {} });

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  function reportSize() {
    const height = Math.ceil(document.documentElement.scrollHeight);
    const width = Math.ceil(document.documentElement.scrollWidth);
    notify("ui/notifications/size-changed", { width, height });
  }

  function status(text, isError) {
    app.replaceChildren(el("p", isError ? "status error" : "status", text));
    reportSize();
  }

  /** Pairs each image block with the "masked screenshot: …" label right before it. */
  function pictures(content) {
    const out = [];
    (content || []).forEach((item, index) => {
      if (!item || item.type !== "image" || typeof item.data !== "string") return;
      if (!/^image\\/(jpeg|png)$/.test(item.mimeType || "")) return;
      const before = content[index - 1];
      const label = before && before.type === "text" && /^masked screenshot:/.test(before.text || "") ? before.text : "masked screenshot";
      out.push({ src: "data:" + item.mimeType + ";base64," + item.data, label });
    });
    return out;
  }

  function measureTable(measurements, extra) {
    const table = el("table");
    const add = (name, value, unit, flag) => {
      const row = el("tr");
      row.append(el("td", "", name));
      const shown = value === null || value === undefined ? "not measured" : String(value) + (unit && value !== null ? " " + unit : "");
      row.append(el("td", flag ? "v flag" : "v", shown));
      table.append(row);
    };
    const m = measurements || {};
    for (const [key, name, unit] of MEASURES) {
      if (!(key in m)) continue;
      const flag = typeof m[key] === "number" && m[key] > 0 && key !== "distinctFontSizes" && key !== "internalScrollers";
      add(name, m[key], unit, flag);
    }
    for (const [name, value] of extra) add(name, value, "", false);
    return table;
  }

  function render(result) {
    const sc = (result && result.structuredContent) || {};
    if (result && result.isError) {
      const first = (result.content || []).find((item) => item.type === "text");
      return status(first ? first.text : "The capture failed.", true);
    }
    if (sc.status === "capturing") return collect(sc);
    const shots = Array.isArray(sc.shots) ? sc.shots : sc.shot ? [sc.shot] : [];
    const images = pictures(result && result.content);
    const page = document.createDocumentFragment();
    page.append(el("div", "micro", "Phoenix Inspector · staging · read-only"));
    const module = sc.moduleTitle || sc.module || (input && input.module) || "Capture";
    page.append(el("h1", "", module));
    const meta = el("div", "meta micro");
    const persona = Array.isArray(sc.persona) ? sc.persona.map((p) => (p && (p.role || p.id)) || p).join(", ") : (input && input.persona) || "";
    const pairs = [["Persona", persona], ["Run", sc.runId || ""], ["Staging revision", (sc.revision || "").slice(0, 9)]];
    for (const [name, value] of pairs) {
      if (!value) continue;
      const item = el("span", "", name + " ");
      item.append(el("b", "", value));
      meta.append(item);
    }
    page.append(meta);
    if (shots.length === 0 && images.length === 0) page.append(el("p", "status", "This capture returned no screenshot."));
    let pictureIndex = 0;
    shots.forEach((shot) => {
      const block = el("section", "shot");
      block.append(el("div", "micro", [shot.state, shot.viewport, shot.outcome].filter(Boolean).join(" · ")));
      if (shot.image && pictureIndex < images.length) {
        const picture = images[pictureIndex++];
        const figure = el("figure");
        const img = el("img");
        img.alt = "Masked screenshot of " + module + (shot.state ? ", " + shot.state : "");
        img.src = picture.src;
        img.addEventListener("load", reportSize);
        img.addEventListener("click", () => {
          figure.classList.toggle("full");
          requestDisplayMode(figure.classList.contains("full") ? "fullscreen" : "inline");
        });
        figure.append(img, el("figcaption", "", picture.label.replace(/^masked screenshot:\\s*/, "")));
        block.append(figure);
      }
      if (shot.error) block.append(el("p", "status error", shot.error));
      block.append(measureTable(shot.measurements, [["Writes stopped", shot.writesStopped ?? 0], ["Console errors", shot.consoleErrors ?? 0]]));
      page.append(block);
    });
    for (; pictureIndex < images.length; pictureIndex++) {
      const figure = el("figure");
      const img = el("img");
      img.alt = "Masked screenshot";
      img.src = images[pictureIndex].src;
      img.addEventListener("load", reportSize);
      figure.append(img, el("figcaption", "", images[pictureIndex].label));
      page.append(figure);
    }
    app.replaceChildren(page);
    reportSize();
  }

  function requestDisplayMode(mode) {
    request("ui/request-display-mode", { mode }).catch(() => {});
  }

  /** A run still going: ask phoenix_get_capture for it, a few times at most (each call waits up to 25 s). */
  async function collect(sc) {
    const args = (sc.next && sc.next.arguments) || { module: sc.module, runId: sc.runId };
    if (collecting >= 6) return status("The capture is still running (run " + sc.runId + "). Ask again to collect it.", false);
    collecting += 1;
    status("Capturing on staging… run " + sc.runId, false);
    try {
      const result = await callTool("phoenix_get_capture", args);
      render(result);
    } catch (error) {
      status("Could not collect run " + sc.runId + ": " + error.message, true);
    }
  }

  async function callTool(name, args) {
    try {
      return await request("tools/call", { name, arguments: args });
    } catch (error) {
      if (window.openai && typeof window.openai.callTool === "function") return window.openai.callTool(name, args);
      throw error;
    }
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
    if (message.method === "ui/notifications/tool-input") input = (message.params && message.params.arguments) || null;
    else if (message.method === "ui/notifications/tool-result") render(message.params || {});
    else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
    else if (message.method === "ui/resource-teardown" && message.id !== undefined) post({ id: message.id, result: {} });
  });

  function theme(context) {
    if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme;
  }

  // The window.openai globals, where the host provides them: the structured result arrives there too.
  function fromGlobals() {
    const openai = window.openai;
    if (!openai) return;
    theme({ theme: openai.theme });
    if (openai.toolInput) input = openai.toolInput;
  }
  window.addEventListener("openai:set_globals", fromGlobals);
  fromGlobals();

  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "phoenix-inspect-screenshot", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  })
    .then((result) => {
      theme(result && result.hostContext);
      notify("ui/notifications/initialized");
    })
    .catch(() => notify("ui/notifications/initialized"));
})();
</script>
</body>
</html>
`;
}
