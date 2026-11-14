#!/usr/bin/env node
/**
 * Browser checks for the Phoenix visual explorer, against a LOCAL fixture page (never the app):
 * no-mutation, masking, leak deletion, navigation failure, refused controls, screenshot reliability,
 * internal scrollers and responsive baselines.
 *
 *   node scripts/phoenix-inspect/self-check.mjs [--out <dir>]
 *
 * The fixture is full of fake personal data and tries every kind of write a page can make: a POST
 * fetch, an XHR POST, a beacon on leaving, a form that posts itself, a request to another origin,
 * and an Export link. The fixture server counts every request that is not a GET; the check passes
 * only when that count is zero and every one of them is listed as stopped.
 *
 * Needs a browser (Playwright's Chromium, or installed Edge/Chrome), so it runs on the spare laptop
 * (on-spare.ps1), not in CI. Exit 0 = every check passed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { captureOne, launchBrowser } from "./lib/capture.mjs";
import { assertTargetOrigin } from "./lib/safety.mjs";
import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "self-check",
  entry: import.meta.url,
  known: ["--out"],
  hints: ["node scripts/phoenix-inspect/self-check.mjs [--out <folder>]"],
});

const outArg = process.argv.indexOf("--out");
const outDir = path.resolve(outArg >= 0 ? process.argv[outArg + 1] : "artifacts/phoenix-inspection/self-check");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const FAKE = {
  name: "Sammy Example",
  hrId: "Z-9043",
  phone: "01012345678",
  email: "sammy.e@example.com",
  arabic: "أحمد مصطفى",
  nationalId: "29913990000000",
};

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<style>
  body { font-family: sans-serif; margin: 0; }
  .rounded { border-radius: 8px; border: 1px solid #333; padding: 8px; width: 200px; }
  .cut { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 80px; }
  .scroller { height: 120px; overflow: auto; border: 1px solid #999; }
  .scroller div { height: 600px; }
  .tiny { width: 20px; height: 20px; padding: 0; }
  .wide { width: 2000px; height: 10px; background: #eee; }
  .band { background: lab(15 0 0); color: rgb(255, 255, 255); padding: 4px; }
  .faint { color: oklch(0.704 0.04 256.788); }
  .drawer { position: fixed; left: 0; top: 0; width: 295px; transform: translateX(-100%); }
</style></head><body><main>
  <h1>Call Rate</h1>
  <button aria-expanded="false" type="button" onclick="this.setAttribute('aria-expanded','true');document.getElementById('panel').hidden=false">Advanced filters</button>
  <div id="panel" hidden>Coverage band</div>
  <table><thead><tr><th>Rep</th><th>Coverage</th></tr></thead><tbody>
    <tr><td>${FAKE.name}</td><td>87.5%</td></tr>
    <tr><td>${FAKE.hrId}</td><td>${FAKE.phone}</td></tr>
    <tr><td>${FAKE.email}</td><td title="${FAKE.name}">${FAKE.arabic}</td></tr>
    <tr><td>${FAKE.nationalId}</td><td><input value="${FAKE.name}" aria-label="${FAKE.hrId}"></td></tr>
  </tbody></table>
  <div class="rounded">Coverage</div>
  <div class="cut">${FAKE.name} ${FAKE.name}</div>
  <div class="scroller"><div>${FAKE.name} inside a scroller</div></div>
  <button class="tiny" type="button" aria-label="Weekly">.</button>
  <img alt="${FAKE.name}" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <a href="/api/crm/kpis-export?month=2026-08" download>Export XLSX</a>
  <div class="phone-cards" style="display:none"><a href="/fixture/rep/Z-9043?month=2026-08&amp;card=1">${FAKE.name}</a></div>
  <a href="/fixture/rep/Z-9043?month=2026-08">${FAKE.name}</a>
  <form id="f" method="post" action="/api/form"><input name="x" value="1"></form>
  <div class="wide"></div>
  <h2 id="band" class="band">Standing out</h2>
  <p id="faint" class="faint">Coverage</p>
  <nav class="drawer" inert aria-hidden="true"><a id="drawer-link" class="tiny" href="/fixture">.</a></nav>
  <p>Write to hr@example.com</p>
</main>
<script>
  fetch("/api/write", { method: "POST", body: "x" }).catch(() => {});
  const x = new XMLHttpRequest(); x.open("POST", "/api/xhr"); x.send("x");
  fetch("https://example.org/track").catch(() => {});
  addEventListener("pagehide", () => navigator.sendBeacon("/api/beacon", "bye"));
  setTimeout(() => { const p = document.createElement("p"); p.textContent = "Late Name 555"; document.querySelector("main").append(p); }, 300);
  setTimeout(() => document.getElementById("f").submit(), 600);
  setTimeout(() => { location.href = "/api/crm/kpis-export?month=2026-08"; }, 700);
</script></body></html>`;

const counts = { nonGet: 0, exportGets: 0 };
const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") counts.nonGet += 1;
  const url = new URL(request.url, "http://x");
  if (url.pathname.startsWith("/api/crm/kpis-export")) counts.exportGets += 1;
  if (url.pathname === "/broken") return request.socket.destroy();
  if (url.pathname === "/fixture" || url.pathname.startsWith("/fixture/rep/")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(FIXTURE);
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not here");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = assertTargetOrigin(`http://127.0.0.1:${server.address().port}`, { allowLoopback: true });

const KEEP = ["Call Rate", "Advanced filters", "Coverage band", "Rep", "Coverage", "Weekly", "Export XLSX", "inside a scroller"];
const persona = { id: "fixture", role: "Fixture", shell: "admin" };
const neverTouch = [
  { selector: 'a[href*="/api/crm/kpis-export"]', reason: "export" },
  { selector: "a[download]", reason: "download" },
];
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const pngWidth = (file) => readFileSync(file).readUInt32BE(16);

const browser = await launchBrowser();
let shot = 0;
const capture = (state, viewport, keep = KEEP) =>
  captureOne(browser, {
    origin,
    persona,
    state,
    viewport,
    address: state.address,
    outDir,
    shotId: `${String(++shot).padStart(2, "0")}-${state.id}-${viewport}`,
    keepList: keep,
    sourceIndexLookup: () => [],
    neverTouch,
    storageState: null,
  });

try {
  // 1. The fixture at desktop: captured, masked, every write stopped.
  const desktop = (await capture({ id: "fixture", label: "fixture", address: "/fixture" }, "desktop")).entry;
  check("desktop capture succeeds", desktop.outcome === "captured", desktop.error ?? desktop.outcome);
  const image = desktop.image ? path.join(outDir, desktop.image) : null;
  check("the screenshot file exists", Boolean(image && existsSync(image)));
  check("desktop baseline is 1440 px wide", Boolean(image && existsSync(image) && pngWidth(image) === 1440), image && existsSync(image) ? String(pngWidth(image)) : "no file");
  const aria = desktop.aria ? readFileSync(path.join(outDir, desktop.aria), "utf8") : "";
  const leaked = Object.entries(FAKE).filter(([, value]) => aria.includes(value)).map(([key]) => key);
  check("no fake personal value survives in the accessibility snapshot", aria.length > 0 && leaked.length === 0, leaked.join(", ") || `${aria.length} chars`);
  check("the kept literal survives", aria.includes("Call Rate"));
  check("text added after masking is masked too", !aria.includes("Late Name") && !aria.includes("555"));
  check("no digit other than 0 survives outside kept text", !/[1-9]/.test(aria.replace(/Call Rate|Coverage band|Advanced filters/g, "").replace(/\[level=\d\]/g, "")));
  check("pictures are hidden", desktop.redaction?.hiddenMedia >= 1, String(desktop.redaction?.hiddenMedia));
  const stopped = desktop.writesStopped.map((item) => `${item.layer} ${item.method} ${item.url} ${item.reason}`);
  const stoppedHas = (pattern) => stopped.some((line) => pattern.test(line));
  check("the POST fetch was stopped", stoppedHas(/POST \/api\/write/), stopped.join(" | "));
  check("the XHR POST was stopped", stoppedHas(/POST \/api\/xhr/));
  check("the form post was stopped", stoppedHas(/POST \/api\/form/));
  check("the request to another origin was stopped", stoppedHas(/example\.org.*off-origin/));
  check("a navigation to a never-touch address is cancelled and the page stays", stoppedHas(/GET \/api\/crm\/kpis-export\S* never-touch-path/) && desktop.outcome === "captured");
  check("logged addresses carry no ids", !stopped.some((line) => line.includes("Z-9043")));
  check("measured: horizontal overflow", desktop.measurements?.horizontalOverflowPx > 0, String(desktop.measurements?.horizontalOverflowPx));
  check("measured: rounded corners", desktop.measurements?.roundedElements >= 1, String(desktop.measurements?.roundedElements));
  check("measured: ellipsis cut", desktop.measurements?.ellipsisCuts >= 1, String(desktop.measurements?.ellipsisCuts));
  check("measured: internal scroller", desktop.measurements?.internalScrollers >= 1);
  const contrastPaths = (desktop.measurementDetail?.contrast?.samples ?? []).map((sample) => sample.path);
  check("measured: faint oklch() text on white is low contrast", contrastPaths.some((p) => p.includes("p#faint")), contrastPaths.join(" | "));
  check("white text on a dark lab() band is NOT low contrast", !contrastPaths.some((p) => p.includes("h2#band")), contrastPaths.join(" | "));
  check("the internal scroller was captured expanded", desktop.scrollers?.length >= 1 && existsSync(path.join(outDir, desktop.scrollers[0].file)));

  // 2. Mobile: baseline width, tap targets.
  const mobile = (await capture({ id: "fixture", label: "fixture", address: "/fixture" }, "mobile")).entry;
  const mobileImage = mobile.image ? path.join(outDir, mobile.image) : null;
  check("mobile capture succeeds", mobile.outcome === "captured", mobile.error ?? mobile.outcome);
  check("mobile baseline is 390 px wide", Boolean(mobileImage && pngWidth(mobileImage) === 390), mobileImage ? String(pngWidth(mobileImage)) : "no file");
  check("measured: small tap targets on mobile", mobile.measurements?.smallTapTargets >= 1, String(mobile.measurements?.smallTapTargets));
  const tapPaths = (mobile.measurementDetail?.tapTargets?.samples ?? []).map((sample) => sample.path);
  check("a closed (inert, off-screen) drawer's link is not a tap target", !tapPaths.some((p) => p.includes("drawer-link")), tapPaths.join(" | "));

  // 3. A vetted click opens the panel; a refused control is never clicked.
  const opened = (await capture({ id: "click", label: "click", address: "/fixture", click: { selector: 'button[aria-expanded="false"]', nameIncludes: "Advanced filters" } }, "desktop")).entry;
  check("an allowed click is made and captured", opened.outcome === "captured" && opened.steps.some((step) => step.startsWith("click")), opened.error ?? "");
  const exportClick = (await capture({ id: "export", label: "export", address: "/fixture", click: { selector: "a" , nameIncludes: "Export" } }, "desktop")).entry;
  check("the Export link is refused, not clicked", exportClick.outcome === "not-present" && exportClick.steps.some((step) => /never-touch|refused/.test(step)), exportClick.steps.join(" | "));

  // 4. Following the page's own link keeps the id out of the record.
  const followed = (await capture({ id: "follow", label: "follow", address: "/fixture", followFirst: 'a[href*="/fixture/rep/"]' }, "desktop")).entry;
  check("a drill-down follows the first VISIBLE link, past a hidden phone-card copy", followed.outcome === "captured", followed.error ?? "");
  check("the drill-down's id is masked in the record", !JSON.stringify(followed).includes("Z-9043"));

  // 5. Navigation failure is an outcome, not a crash, and leaves no picture.
  const broken = (await capture({ id: "broken", label: "broken", address: "/broken" }, "desktop")).entry;
  check("a failed navigation is recorded", broken.outcome === "navigation-failed" && broken.image === null, `${broken.outcome}: ${broken.error ?? ""}`);

  // 6. A shot whose kept text carries a sensitive pattern is deleted.
  const leaky = (await capture({ id: "leak", label: "leak", address: "/fixture" }, "desktop", [...KEEP, "Write to hr@example.com"])).entry;
  check("a privacy-check failure deletes the shot", leaky.outcome === "deleted-privacy-check-failed" && leaky.image === null && !existsSync(path.join(outDir, "shots", `${String(shot).padStart(2, "0")}-leak-desktop.png`)), `${leaky.outcome} ${JSON.stringify(leaky.redaction?.leakKinds)}`);

  // 7. A refused address never leaves.
  const refused = (await capture({ id: "export-address", label: "export", address: "/api/crm/kpis-export?month=2026-08" }, "desktop")).entry;
  check("an address the fence refuses is never requested", refused.outcome === "refused", refused.error ?? refused.outcome);
} finally {
  await browser.close().catch(() => {});
}
check("the server received no request other than GET", counts.nonGet === 0, String(counts.nonGet));
check("the export address was never requested", counts.exportGets === 0, String(counts.exportGets));
server.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
// The same results as a file, so a report can cite them without a screen copy.
writeFileSync(
  path.join(outDir, "report.json"),
  `${JSON.stringify({ finishedAt: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2)}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
