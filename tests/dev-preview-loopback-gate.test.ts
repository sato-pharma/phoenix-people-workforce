// The dev-preview gate admits a request only when EVERY address it carries is this machine, and the
// dev server listens on this machine alone (audit point 1, owner-approved 2026-10-26).
//
// WHY THIS EXISTS. `/api/dev-auth` mints a session as any role against the database `.env.local`
// points at — PRODUCTION. Two holes let a caller on the same Wi-Fi reach it:
//   1. a bare `next dev` listens on every interface;
//   2. the gate accepted when ANY ONE of the URL host, `host` or `x-forwarded-host` was loopback, so
//      `Host: localhost` from 192.168.x passed. `src/lib/auth/server.ts` and the session heartbeat each
//      kept their own copy of that gate, so fixing one left two open.
// Now `scripts/dev-server.mjs` passes `-H 127.0.0.1` (opt-out PHOENIX_DEV_BIND_ALL=1), and the ONE
// gate, `isLoopbackDevRequestHeaders`, needs a loopback Host AND every forwarded host AND every
// forwarded-for entry loopback. Next fills an absent `x-forwarded-for` with the socket's real
// address, which is what refuses a LAN caller that sends no header at all.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A namespace import, so a build without the shared gate fails an ASSERTION below, not the import.
import * as devPreview from "../src/lib/auth/dev-preview.ts";
import { stripComments } from "./support/comment-strip.ts";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

function testTheHeaderGate() {
  const { isLoopbackDevRequestHeaders } = devPreview;
  assert.equal(typeof isLoopbackDevRequestHeaders, "function", "dev-preview.ts exports the one headers-only loopback gate");
  const admitted: Array<[string, Record<string, string>]> = [
    ["localhost with its port", { host: "localhost:3000" }],
    ["127.0.0.1, forwarded for itself", { host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:3000" }],
    ["IPv6 loopback in brackets", { host: "[::1]:3000", "x-forwarded-for": "::1" }],
    ["an IPv4-mapped loopback socket", { host: "localhost:3000", "x-forwarded-for": "::ffff:127.0.0.1" }],
    ["anywhere in 127.0.0.0/8", { host: "localhost:3000", "x-forwarded-for": "127.0.0.2" }],
    ["a chain that is loopback end to end", { host: "localhost:3000", "x-forwarded-for": "127.0.0.1, ::1" }],
  ];
  for (const [name, values] of admitted) {
    assert.equal(isLoopbackDevRequestHeaders(headers(values)), true, `a loopback request is admitted: ${name}`);
  }

  const refused: Array<[string, Record<string, string>]> = [
    ["no Host at all", {}],
    ["a public Host", { host: "phoenix-hr.satopharma.com" }],
    ["a DNS-rebinding Host", { host: "evil.example:3000", "x-forwarded-for": "127.0.0.1" }],
    ["a LAN caller claiming Host: localhost (Next filled its real address)", { host: "localhost:3000", "x-forwarded-for": "192.168.1.23" }],
    ["a LAN caller over IPv4-mapped IPv6", { host: "localhost:3000", "x-forwarded-for": "::ffff:192.168.1.23" }],
    ["a forwarded chain with ONE outside hop", { host: "localhost:3000", "x-forwarded-for": "127.0.0.1, 10.0.0.5" }],
    ["a forwarded host that is not loopback", { host: "localhost:3000", "x-forwarded-host": "phoenix-hr.satopharma.com" }],
    ["a loopback forwarded host over a public Host", { host: "phoenix-hr.satopharma.com", "x-forwarded-host": "localhost:3000" }],
    ["a look-alike name", { host: "localhost.evil.example:3000" }],
    ["a look-alike address", { host: "127.0.0.1.evil.example" }],
    ["an empty forwarded-for", { host: "localhost:3000", "x-forwarded-for": "" }],
  ];
  for (const [name, values] of refused) {
    assert.equal(isLoopbackDevRequestHeaders(headers(values)), false, `refused: ${name}`);
  }
}

function testTheRequestGate() {
  const env = process.env as Record<string, string | undefined>;
  const saved = env.NODE_ENV;
  // The URL says localhost; the Host says otherwise. The URL is never trusted — Next builds it from
  // the same Host header, and the old gate let the URL alone carry the request through.
  const lying = { headers: headers({ host: "evil.example:3000", "x-forwarded-for": "192.168.1.23" }), url: "http://localhost:3000/api/dev-auth" } as unknown as Request;
  const honest = { headers: headers({ host: "localhost:3000", "x-forwarded-for": "::1" }), url: "http://localhost:3000/api/dev-auth" } as unknown as Request;
  try {
    env.NODE_ENV = "development";
    assert.equal(devPreview.isLocalDevelopmentRequest(lying), false, "a localhost URL never outvotes a foreign Host and a LAN forwarded-for");
    assert.equal(devPreview.isLocalDevelopmentRequest(honest), true, "the same route from this machine still opens");
    env.NODE_ENV = "production";
    assert.equal(devPreview.isLocalDevelopmentRequest(honest), false, "outside development nothing opens, loopback or not");
  } finally {
    if (saved === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved;
  }
}

/** Every copy of the gate is gone: server.ts and the heartbeat both call the shared one. */
function testOneGateEverywhere() {
  const code = (file: string) => stripComments(readFileSync(resolve(file), "utf8"));

  const server = code("src/lib/auth/server.ts");
  const serverGate = server.match(/function isLocalDevelopmentRequest\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(serverGate, /return isLoopbackDevRequestHeaders\(headerStore\);/, "server.ts's dev-header and preview-cookie gate is the shared one");
  assert.doesNotMatch(server, /function isLocalHostname\(/, "server.ts keeps no either-or loopback copy of its own");

  const heartbeat = code("src/lib/auth/session-heartbeat.ts");
  assert.doesNotMatch(heartbeat, /function isLocalDevelopmentRequest\(/, "the heartbeat keeps no URL-only copy of its own");
  assert.match(heartbeat, /isLocalDevelopmentRequest,[\s\S]*?from "@\/lib\/auth\/dev-preview"/, "the heartbeat imports the shared gate");

  const devPreviewCode = code("src/lib/auth/dev-preview.ts");
  const requestGate = devPreviewCode.match(/export function isLocalDevelopmentRequest\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(requestGate, /request\.url/, "the URL host never decides it");
  assert.match(requestGate, /return isLoopbackDevRequestHeaders\(request\.headers\);/);
}

/** The real launcher beside a stand-in `next` that prints what it was handed — as in tests/dev-server-heap-cap.test.ts. */
function testTheLauncherBindsLoopback() {
  const root = mkdtempSync(join(tmpdir(), "phx-dev-bind-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["dev-server.mjs", "dev-server-heap-cap.mjs", "dev-server-exit-reason.mjs"]) {
      copyFileSync(resolve("scripts", file), join(root, "scripts", file));
    }
    const bin = join(root, "node_modules", "next", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "next"), "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');\n");
    const launcher = join(root, "scripts", "dev-server.mjs");

    const launch = (args: string[], extraEnv: Record<string, string> = {}) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS: "1" };
      for (const key of ["NODE_OPTIONS", "PHOENIX_DEV_BIND_ALL", "PHOENIX_DEV_BUNDLER"]) delete env[key];
      Object.assign(env, extraEnv);
      const run = spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 30000 });
      assert.equal(run.status, 0, `the launcher must hand over to Next.\n${run.stdout}\n${run.stderr}`);
      const lines = run.stdout.split(/\r?\n/);
      const report = lines.find((line) => line.startsWith('{"argv"'));
      assert.ok(report, `the stand-in for Next never ran.\n${run.stdout}\n${run.stderr}`);
      return { argv: (JSON.parse(report) as { argv: string[] }).argv, line: lines.find((line) => line.startsWith("[dev-server]")) ?? "" };
    };

    const plain = launch(["--port", "3999"]);
    assert.deepEqual(plain.argv, ["dev", "--webpack", "--port", "3999", "-H", "127.0.0.1"], "by default Next listens on 127.0.0.1 only, never every interface");
    assert.match(plain.line, /loopback only \(127\.0\.0\.1\)/, "the launcher says where it listens");

    const lan = launch(["--port", "3999"], { PHOENIX_DEV_BIND_ALL: "1" });
    assert.deepEqual(lan.argv, ["dev", "--webpack", "--port", "3999"], "PHOENIX_DEV_BIND_ALL=1 is the one deliberate way back to every interface");
    assert.match(lan.line, /EVERY interface \(PHOENIX_DEV_BIND_ALL=1\)/, "and it is said out loud");

    assert.deepEqual(launch(["-H", "0.0.0.0"]).argv, ["dev", "--webpack", "-H", "0.0.0.0"], "a host the caller passed is kept, never doubled");
    assert.deepEqual(launch(["--hostname", "::1"]).argv, ["dev", "--webpack", "--hostname", "::1"]);
    assert.deepEqual(launch([], { PHOENIX_DEV_BIND_ALL: "true" }).argv, ["dev", "--webpack", "-H", "127.0.0.1"], "only the exact value 1 opts out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runDevPreviewLoopbackGateTests() {
  testTheRequestGate();
  testTheHeaderGate();
  testOneGateEverywhere();
  testTheLauncherBindsLoopback();
}
