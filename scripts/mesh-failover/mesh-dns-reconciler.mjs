// Keeps mesh.satopharma.com pointed at a tunnel that is actually up.
// Phone healthy -> phone (verified). Phone down -> laptop. Never exits silently.
import fs from "node:fs";
import path from "node:path";

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

let down = 0, up = 0, ticks = 0;

const pass = async () => {
  const tok = creds();
  const [ps, cur] = await Promise.all([tunnelStatus(tok, PHONE), currentTarget(tok)]);
  const on = cur?.tunnel === PHONE ? "phone" : cur?.tunnel === LAPTOP ? "laptop" : "other";
  ticks++;
  if (ps === "healthy") { up++; down = 0; } else { down++; up = 0; }

  if (on === "phone" && down >= DOWN_STRIKES) {
    log("phone tunnel " + ps + " x" + down + " - failing back to the laptop");
    await pointAt(tok, LAPTOP, "laptop");
    await sleep(8);
    log("laptop verify: " + JSON.stringify(await probe()));
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
    log("steady: address on " + on + ", phone tunnel " + ps);
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
