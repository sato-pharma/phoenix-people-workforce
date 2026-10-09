// spawn-probe.mjs — a preload that RECORDS every subprocess and network call a hook makes, then lets
// the call go through unchanged. Not a hook; it is loaded in front of one by a selftest:
//
//   SPAWN_PROBE_OUT=<file> node --import file:///C:/Users/satoh/.claude/hooks/spawn-probe.mjs <hook>
//
// Each call appends one JSON line {kind, what} to SPAWN_PROBE_OUT; an empty file means the hook
// started nothing and touched no network. Written 2026-10-09 (hook speed fixes): a blocking hook
// that starts powershell.exe on every session start cost 0.8-3 s a start for weeks, and nothing
// failed, because "it still works, just slower" is invisible to a selftest that only reads output.
//
// child_process is patched on the CommonJS object and then synced to the ESM named exports with
// module.syncBuiltinESMExports(), so `import { execFileSync } from 'node:child_process'` inside the
// hook, which binds after this preload runs, gets the recording version too.
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const OUT = process.env.SPAWN_PROBE_OUT;

if (OUT) {
  const note = (kind, what) => {
    try {
      fs.appendFileSync(OUT, JSON.stringify({ kind, what: String(what ?? '').slice(0, 200) }) + '\n');
    } catch {}
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
