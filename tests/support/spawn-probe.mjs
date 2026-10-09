// spawn-probe.mjs — a preload that RECORDS every subprocess and network call made by the process it
// is loaded into, then lets each call go through unchanged. Tests load it in front of a hook:
//
//   node --import <file URL of this file> .claude/hooks/<hook>.mjs      (env SPAWN_PROBE_OUT=<file>)
//
// Each call appends one JSON line {kind, what} to SPAWN_PROBE_OUT; an empty file means the hook
// started nothing and touched no network.
//
// WHY (2026-10-09, hook speed fixes): blocking hooks that start a process on an ordinary call cost
// every Phoenix session time on every Read, Write and session start — git on every Write/Edit, six
// git processes per start for a memory drift report, powershell.exe for a session count — and no
// test failed, because "it still works, just slower" is invisible to a test that only reads output.
// tests/hook-hot-path.test.ts uses this to refuse that shape.
//
// child_process is patched on the CommonJS object. A hook's `import { execFileSync } from
// 'node:child_process'` binds after this preload has run, so the ESM facade node builds then already
// carries the recording version (checked: the probe hears it with or without the sync below).
// module.syncBuiltinESMExports() is the safeguard for the other order — a facade some earlier preload
// built before this one ran — and costs nothing. tests/hook-hot-path.test.ts `probeSeesSpawns` proves
// the probe hears a named-import spawn, so its silence elsewhere means something.
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const OUT = process.env.SPAWN_PROBE_OUT;

if (OUT) {
  const note = (kind, what) => {
    try {
      fs.appendFileSync(OUT, JSON.stringify({ kind, what: String(what ?? '').slice(0, 200) }) + '\n');
    } catch {
      // a probe that cannot write must never break the hook it watches
    }
  };
  const wrap = (obj, name, kind, describe) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function probed(...args) {
      note(kind, describe(args));
      return orig.apply(this, args);
    };
  };
  const cp = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    wrap(cp, fn, `child_process.${fn}`, (a) => [a[0], ...(Array.isArray(a[1]) ? a[1] : [])].join(' '));
  }
  const net = require('node:net');
  for (const fn of ['connect', 'createConnection']) wrap(net, fn, `net.${fn}`, (a) => JSON.stringify(a[0]));
  for (const mod of ['node:http', 'node:https']) {
    const m = require(mod);
    for (const fn of ['request', 'get']) wrap(m, fn, `${mod.slice(5)}.${fn}`, (a) => (typeof a[0] === 'string' ? a[0] : a[0]?.host));
  }
  const dns = require('node:dns');
  wrap(dns, 'lookup', 'dns.lookup', (a) => a[0]);
  if (typeof globalThis.fetch === 'function') {
    const f = globalThis.fetch;
    globalThis.fetch = (...a) => {
      note('fetch', typeof a[0] === 'string' ? a[0] : a[0]?.url);
      return f(...a);
    };
  }
  syncBuiltinESMExports();
}
