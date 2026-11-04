#!/usr/bin/env node
// /opt/phx-live/live-receiver.mjs — the ONLY thing the laptop's phx-live-sync.mjs can run on the box.
//
// It is phxlive's forced command in ~phxlive/.ssh/authorized_keys, so a connection as phxlive gets
// this and nothing else: no shell, no pty, no forwarding. It reads one JSON object per line on stdin
// and answers one JSON object per line on stdout.
//
//   {"op":"write","path":"src/x.ts","b64":"..."}    write a file inside the checkout
//   {"op":"delete","path":"src/x.ts"}                remove it (missing is fine)
//   {"op":"manifest","paths":["a","b"]}              -> {"op":"manifest","hashes":{"a":"<sha1>"|null}}
//   {"op":"commit"}                                  end of a batch: runs `pnpm install` when a manifest moved
//   {"op":"health"}                                  -> {"op":"health","code":200}
//   {"op":"ping"}                                    -> {"op":"pong","base":"<sha>"}
//
// 🔴 EVERY PATH IS CONFINED TO THE CHECKOUT. Absolute paths, `..`, and anything under `.git/`,
// `node_modules/`, `.next/` or named `.env*` are refused — the env file holds the production keys,
// and `.git/hooks` would run on the next checkout. The laptop is the source of truth for this tree:
// nobody edits /home/phxlive/live by hand.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ROOT = "/home/phxlive/live";
const PORT = 3100;
const MANIFESTS = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]);

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function safePath(rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) return null;
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (path.posix.isAbsolute(rel)) return null;
  const norm = path.posix.normalize(rel);
  if (norm.startsWith("../") || norm === ".." || norm === ".") return null;
  const parts = norm.split("/");
  if (parts.some((p) => p === ".." || p === ".git" || p === "node_modules" || p === ".next")) return null;
  if (parts.some((p) => /^\.env/i.test(p))) return null;
  const abs = path.join(ROOT, norm);
  if (!abs.startsWith(ROOT + "/")) return null;
  return { norm, abs };
}

function sha1(abs) {
  try {
    return createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function base() {
  const r = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

let manifestMoved = false;

function handle(msg) {
  switch (msg.op) {
    case "write": {
      const p = safePath(msg.path);
      if (!p) return reply({ op: "refused", path: msg.path });
      const buf = Buffer.from(msg.b64 ?? "", "base64");
      fs.mkdirSync(path.dirname(p.abs), { recursive: true });
      // A symlink at the target could point outside the checkout; replace it rather than follow it.
      try {
        if (fs.lstatSync(p.abs).isSymbolicLink()) fs.unlinkSync(p.abs);
      } catch {}
      const tmp = p.abs + ".phx-live-tmp";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, p.abs);
      if (MANIFESTS.has(p.norm)) manifestMoved = true;
      return reply({ op: "ok", path: p.norm });
    }
    case "delete": {
      const p = safePath(msg.path);
      if (!p) return reply({ op: "refused", path: msg.path });
      try {
        fs.rmSync(p.abs, { force: true });
      } catch {}
      if (MANIFESTS.has(p.norm)) manifestMoved = true;
      return reply({ op: "ok", path: p.norm });
    }
    case "manifest": {
      const hashes = {};
      for (const rel of msg.paths ?? []) {
        const p = safePath(rel);
        hashes[rel] = p ? sha1(p.abs) : null;
      }
      return reply({ op: "manifest", hashes });
    }
    case "commit": {
      if (manifestMoved) {
        manifestMoved = false;
        reply({ op: "installing" });
        const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: ROOT, encoding: "utf8" });
        return reply({ op: "installed", ok: r.status === 0, tail: (r.stdout + r.stderr).split("\n").slice(-8).join("\n") });
      }
      return reply({ op: "committed" });
    }
    case "health": {
      const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", `http://127.0.0.1:${PORT}/api/healthz`], { encoding: "utf8" });
      return reply({ op: "health", code: Number(r.stdout.trim() || 0) });
    }
    case "ping":
      return reply({ op: "pong", base: base() });
    default:
      return reply({ op: "error", message: "unknown op" });
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  if (!fs.existsSync(ROOT + "/.git")) {
    reply({ op: "error", message: "NO_CHECKOUT — run phx-live, which prepares /home/phxlive/live first" });
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return reply({ op: "error", message: "bad json" });
    }
    try {
      handle(msg);
    } catch (e) {
      reply({ op: "error", path: msg.path, message: String(e?.message ?? e) });
    }
  });
}
