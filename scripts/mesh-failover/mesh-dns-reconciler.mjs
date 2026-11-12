// Keeps mesh.satopharma.com pointed at a tunnel that is actually up.
// Phone healthy -> phone (verified). Phone down -> laptop. Never exits silently.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const PHONE  = "c590305f-3a76-440f-8687-16fd9767f189";
const LAPTOP = "d9a7836b-4d64-4b2a-89e0-9c28d8117f4b";
const HOST   = "mesh.satopharma.com";
const DIR    = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const LOG    = path.join(DIR, "reconciler.log");

const POLL_SEC     = 30;
const DOWN_STRIKES = 2;    // ~1 min before failing back to the laptop
const UP_STRIKES   = 4;    // ~2 min healthy before trusting the phone
const API_MS       = 20000;
const BIG_MS       = 120000;
const ITER_MS      = 300000; // a single pass may never exceed 5 min

const log = (m) => {
  const line = new Date().toISOString() + "  " + m;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, LOG + ".1");
    fs.appendFileSync(LOG, line + "\n");
  } catch {}
};
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// every network call is bounded - node's fetch has NO default timeout and a hung
// request stalls the whole loop with no error at all (seen 2026-10-19 21:42Z)
const get = (url, ms, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

const creds = () => {
  const pem = fs.readFileSync("C:/Users/satoh/.cloudflared/cert.pem", "utf8");
  const b = pem.match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/);
  return JSON.parse(Buffer.from(b[1].replace(/\s/g, ""), "base64").toString("utf8"));
};
const api = async (tok, p, i = {}) => {
  const r = await get("https://api.cloudflare.com/client/v4" + p, API_MS, {
    ...i, headers: { Authorization: "Bearer " + tok.apiToken, "Content-Type": "application/json" },
  });
  return { status: r.status, body: await r.json() };
};
const tunnelStatus = async (tok, id) => {
  const r = await api(tok, `/accounts/${tok.accountID}/cfd_tunnel/${id}`);
  return r.body?.success ? r.body.result.status : "unknown";
};
const currentTarget = async (tok) => {
  const r = await api(tok, `/zones/${tok.zoneID}/dns_records?name=${HOST}`);
  const rec = (r.body?.result || []).find((x) => x.name === HOST && x.type === "CNAME");
  return rec ? { id: rec.id, tunnel: rec.content.split(".")[0] || "" } : null;
};
const pointAt = async (tok, id, label) => {
  const cur = await currentTarget(tok);
  if (!cur) { log("REFUSED: no single CNAME for " + HOST); return false; }
  if (cur.tunnel === id) return true;
  const u = await api(tok, `/zones/${tok.zoneID}/dns_records/${cur.id}`, {
    method: "PATCH",
    body: JSON.stringify({ type: "CNAME", name: HOST, content: id + ".cfargotunnel.com", proxied: true }),
  });
  log((u.body?.success ? "SWITCHED to " : "SWITCH FAILED to ") + label + " (" + u.status + ")");
  return !!u.body?.success;
};
const probe = async () => {
  const o = {};
  try {
    const r = await get("https://" + HOST + "/", API_MS, { redirect: "manual" });
    o.root = r.status;
    o.access = (r.headers.get("location") || "").includes("cloudflareaccess.com");
  } catch { o.root = "ERR"; o.access = false; }
  try {
    const r = await get("https://" + HOST + "/meshagents?id=4", BIG_MS);
    const b = Buffer.from(await r.arrayBuffer());
    o.bytes = b.length; o.mz = b.slice(0, 2).toString() === "MZ";
  } catch { o.bytes = 0; o.mz = false; }
  return o;
};
const good = (v) => v.root === 302 && v.access && v.bytes > 3_000_000 && v.mz;

// ---- laptop tunnel crash reports ----------------------------------------------
// The service restarts itself 10 s after a crash, so Cloudflare may never show it
// down. A new service PID is the reliable sign; each one gets a report holding the
// tunnel log's last lines and the Windows events, kept in crash-reports/.
const SERVICE   = "cloudflared-mesh";
const TUN_LOG   = "C:/Users/satoh/.cloudflared/mesh-tunnel-service.log";
const REPORTS   = path.join(DIR, "crash-reports");
const run = (cmd, args, ms) => new Promise((res) =>
  execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 4_000_000 }, (e, out) => res(e ? "" : String(out))));
const serviceState = async () => {
  const o = await run("sc.exe", ["queryex", SERVICE], 15000);
  const pid = Number((o.match(/PID\s*:\s*(\d+)/) || [])[1] || 0);
  const state = ((o.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1] || "UNKNOWN");
  return { pid, state };
};
const tail = (file, n) => {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-n).join("\n"); }
  catch (e) { return "(could not read " + file + ": " + e.message + ")"; }
};
const crashReport = async (was, now, minutes = 20, onlyIfCrashed = false) => {
  const ev = await run("powershell.exe", ["-NoProfile", "-Command",
    "$t=(Get-Date).AddMinutes(-" + minutes + ");" +
    "Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';StartTime=$t} -EA SilentlyContinue |" +
    " Where-Object { $_.Message -match 'Cloudflare tunnel' } | Format-List TimeCreated,Id,Message | Out-String -Width 300;" +
    "Get-WinEvent -FilterHashtable @{LogName='Application';Level=1,2;StartTime=$t} -EA SilentlyContinue |" +
    " Where-Object { $_.Message -match 'cloudflared' } | Format-List TimeCreated,ProviderName,Id,Message | Out-String -Width 300"], 60000);
  const crashed = /\b7034\b|\b7031\b|terminated unexpectedly/.test(ev);
  if (onlyIfCrashed && !crashed) return;
  // the reading: the error lines cloudflared wrote before it fell, newest last
  const logTail = tail(TUN_LOG, 400).split("\n");
  const lastStart = logTail.map((l) => l.includes('"Starting tunnel"')).lastIndexOf(true);
  const before = lastStart > 0 ? logTail.slice(0, lastStart) : logTail;
  const errs = before.filter((l) => /"level":"(error|fatal|panic)"|panic:|fatal error/i.test(l));
  const msg = (l) => { try { const j = JSON.parse(l); return (j.message || "") + (j.error ? ": " + j.error : ""); } catch { return l.slice(0, 200); } };
  const reasons = [...new Set(errs.slice(-40).map(msg))].slice(-8);
  const lastLine = before.filter(Boolean).slice(-1)[0] || "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(REPORTS, stamp + (crashed ? "-crash" : "-restart") + ".txt");
  try {
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.writeFileSync(file, [
      "laptop tunnel service " + SERVICE + ": pid " + was.pid + " (" + was.state + ") -> pid " + now.pid + " (" + now.state + ")",
      "written " + new Date().toISOString() + (crashed ? "  - Windows recorded a crash" : "  - no crash event: a planned restart or stop"),
      "", "==== what the tunnel logged before it fell ====",
      "errors (newest last): " + (reasons.length ? "\n  - " + reasons.join("\n  - ") : "none - it died without logging an error (a hard fault goes to stderr, not the log)"),
      "last line before the restart: " + (lastLine ? msg(lastLine) + "  [" + ((lastLine.match(/"time":"([^"]+)"/) || [])[1] || "?") + "]" : "(none)"),
      "", "==== Windows events, last " + minutes + " min ====", ev.trim() || "(none)",
      "", "==== " + TUN_LOG + ", last 150 lines ====", tail(TUN_LOG, 150), "",
    ].join("\n"));
  } catch (e) { log("crash report could not be written: " + e.message); }
  log((crashed ? "CRASH: laptop tunnel crashed" : "restart: laptop tunnel restarted") +
      " (pid " + was.pid + " -> " + now.pid + ", " + now.state + ") - " +
      (reasons.length ? "last error: " + reasons[reasons.length - 1] : "no error logged") + " - report " + file);
};
let svcWas = null;
const watchService = async () => {
  const now = await serviceState();
  if (now.state === "UNKNOWN") return;              // sc.exe failed this time; try next pass
  // every crash so far (4-12 Nov) came ~20 s after Windows started, before this watcher
  // was running: on its first pass, look back for one since boot.
  if (!svcWas) {
    const o = await run("powershell.exe", ["-NoProfile", "-Command",
      "[int]((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalMinutes"], 30000);
    const sinceBoot = Number(o.trim());
    if (o.trim() && sinceBoot >= 0 && sinceBoot <= 60) await crashReport({ pid: 0, state: "AT-BOOT" }, now, sinceBoot + 2, true);
  }
  // one report per fall: leaving RUNNING (new pid, or stopped). Coming back is one line.
  if (svcWas?.state === "RUNNING" && (now.pid !== svcWas.pid || now.state !== "RUNNING")) await crashReport(svcWas, now);
  else if (svcWas && svcWas.state !== "RUNNING" && now.state === "RUNNING") log("laptop tunnel service running again (pid " + now.pid + ")");
  svcWas = now;
};

let down = 0, up = 0, ticks = 0;
let backupWas = null; // last laptop tunnel status, so a dead backup is logged once, loudly

const pass = async () => {
  try { await watchService(); } catch (e) { log("service watch error: " + (e?.message || e)); }
  const tok = creds();
  const [ps, ls, cur] = await Promise.all([tunnelStatus(tok, PHONE), tunnelStatus(tok, LAPTOP), currentTarget(tok)]);
  // the laptop backup sat dead from 2 Nov to 13 Nov unseen: its service crashed and
  // nothing watched it. Say so the moment it goes down, and again when it is back.
  if (ls !== backupWas) {
    if (ls !== "healthy") log("BACKUP DOWN: laptop tunnel " + ls + " - a phone outage would leave the address dead");
    else if (backupWas !== null) log("backup back: laptop tunnel healthy");
    backupWas = ls;
  }
  const on = cur?.tunnel === PHONE ? "phone" : cur?.tunnel === LAPTOP ? "laptop" : "other";
  ticks++;
  if (ps === "healthy") { up++; down = 0; } else { down++; up = 0; }

  if (on === "phone" && down >= DOWN_STRIKES) {
    log("phone tunnel " + ps + " x" + down + " - failing back to the laptop");
    await pointAt(tok, LAPTOP, "laptop");
    await sleep(8);
    const lv = await probe();
    log("laptop verify: " + JSON.stringify(lv) + (good(lv) ? "" : " - FAILED, the backup is not serving"));
    down = 0;
  } else if (on !== "phone" && up >= UP_STRIKES) {
    log("phone healthy x" + up + " - moving the address to it");
    if (await pointAt(tok, PHONE, "phone")) {
      await sleep(10);
      const v = await probe();
      log("phone verify: " + JSON.stringify(v));
      if (!good(v)) { log("verify FAILED - back to the laptop"); await pointAt(tok, LAPTOP, "laptop"); }
    }
    up = 0;
  } else if (ticks % 20 === 0) {
    log("steady: address on " + on + ", phone tunnel " + ps + ", laptop tunnel " + ls);
  }
};

log("=== reconciler started (pid " + process.pid + ") ===");
for (;;) {
  try {
    // a stalled pass must never freeze the loop: it is abandoned and retried
    await Promise.race([
      pass(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("pass exceeded " + ITER_MS + "ms")), ITER_MS)),
    ]);
  } catch (e) {
    log("pass error: " + (e?.message || e));
  }
  await sleep(POLL_SEC);
}
