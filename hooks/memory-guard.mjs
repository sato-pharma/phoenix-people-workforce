// SessionStart hook. Two jobs:
//  1) Warn a new session when this machine is genuinely close to its ceiling.
//  2) Stamp the session's start time so the statusline can show its age — sessions here run
//     6.5h median and have hit 8.9 days, which guarantees context compaction.
// Quiet when the machine is healthy.
//
// Node rewrite of memory-guard.ps1 (was ~1701ms): powershell start ~297ms + Get-CimInstance
// ~371ms + Get-Process/.Path ~77ms + prune I/O. The session count needs a subprocess, so it is
// cached and hard-timed-out — tasklist was measured at 7.2s under load, which must never be
// allowed to block startup. Commit now rides along in that same call, so it costs no extra spawn.
// Since 2026-10-09 that call runs ONLY in `memory-guard.mjs refresh`, an async SessionStart entry:
// the blocking run reads the cache and starts nothing (see cachedStats()).
//
// --- 2026-08-25: this hook measured the WRONG THING for months ---------------------------
// It warned on os.freemem() (free PHYSICAL RAM) below 2.5 GB, or more than 4 Claude sessions.
// Both were wrong by then:
//   * Free RAM stays low through ordinary file caching even when there is tens of GB of commit
//     headroom, so the warning fired constantly while nothing was wrong — and a guard that cries
//     wolf every session is worse than no guard, because sessions learn to ignore it.
//   * The real ceiling is the Windows COMMIT charge (RAM + pagefile). The pagefile was raised to
//     a fixed 16 GB on 2026-08-25, taking the limit from ~19.79 GB to 31.79 GB, which made the
//     hardcoded "4 sessions" rule roughly 12 GB too conservative. AGENTS.md §5 was corrected in
//     PR #2409; this file is the other half of that correction.
// Hitting the commit limit is a TOTAL hard freeze with no bugcheck and no minidump, so an empty
// C:\Windows\Minidump never rules memory out. The threshold is 85%, matching statusline.mjs
// deliberately — one number, not two. It is 85 and not 100 because the freeze happens during an
// allocation SPIKE: by the time it reads 100% the box is already wedged.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.USERPROFILE || os.homedir();
// Deliberately NOT statusline.mjs's 'claude-statusline-commit.json'. The two hooks keep separate
// cache files on purpose: this one used to write a commit-less {at,n} record, which blanked the
// statusline's commit segment for 20s after every SessionStart. Same shape now, still separate.
const CACHE = path.join(os.tmpdir(), 'claude-statusline-sessions.json');
// 2026-10-09 (hook speed fixes): was CACHE_TTL_MS = 20_000, after which the BLOCKING run started
// powershell.exe itself. See `refresh` below for why it no longer does.
const CACHE_MAX_AGE_MS = 60 * 60_000; // the blocking run trusts a reading this old and never refreshes it
const REFRESH_MIN_AGE_MS = 60_000; // `refresh` skips PowerShell when the reading is younger than this
const REFRESH_TIMEOUT_MS = 8000; // `refresh` runs async, so it can wait; its settings entry allows 10 s
const COMMIT_WARN_PCT = 85;
// `FALLBACK_LOW_FREE_RAM_GB = 1.0` stood here until 2026-10-06. It gated a branch that was dead by
// arithmetic — see the note at the end of decideMessage — and nothing else read it.

// Deliberately contains NO double quotes: it is passed as a single argv entry to powershell.exe,
// and mixing JS + PS quoting here is how this breaks silently. Returns "n|usedGB|limitGB".
const PS_STATS =
  "$n=@(Get-Process claude -EA SilentlyContinue | Where-Object { $_.Path -like '*claude-code*' }).Count; " +
  '$o=Get-CimInstance Win32_OperatingSystem; ' +
  '($n,[math]::Round(($o.TotalVirtualMemorySize-$o.FreeVirtualMemory)/1MB,1),' +
  "[math]::Round($o.TotalVirtualMemorySize/1MB,1)) -join '|'";

// MODE: `node ~/.claude/hooks/memory-guard.mjs selftest` runs the decision table and the session
// stamping against the REAL hook and prints `0 failed` - 19 cases as of 2026-10-06, COUNTED by the
// runner rather than written here, because a hand-kept total is the one number CI ratchets on. It sits HERE,
// above the stdin read, deliberately: the read below is `readFileSync(0)`, which BLOCKS when
// nothing is piped in, so a selftest placed any lower could never be invoked by hand.
//
// Added 2026-10-06 because this file lives OUTSIDE any repository \u2014 it is a global SessionStart
// hook \u2014 so no CI job and no repo test could ever see it weaken, and it is the thing that tells a
// session not to start a build on a saturated 16 GB box. It fails open and silent by design
// (every block is wrapped, and it always exits 0), which means a regression here produces no error
// and no output: the only symptom is a session being told nothing while the machine is at its
// ceiling. Nothing about that is visible by reading it.
if (process.argv[2] === 'selftest') {
  const { execFileSync } = await import('node:child_process');
  const GB = 1073741824;
  const MB = 1048576;
  let failed = 0;
  // Counted, never hand-written. A literal total is exactly what the CI ratchet reads, so a
  // hand-maintained one can disagree with the cases actually run — this printed "16" for 18 of
  // them the first time it ran, which would have let two cases be deleted without the count moving.
  let ran = 0;
  const pass = (label) => console.log(`  pass  ${label}`);
  const fail = (label, detail) => {
    failed++;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  };
  const check = (label, cond, detail) => {
    ran++;
    return cond ? pass(label) : fail(label, detail);
  };

  console.log('SELFTEST memory-guard:');

  // --- the decision table. Pure inputs, so the branch taken does not depend on this machine.
  const decide = (o) => decideMessage({ pct: null, used: null, lim: null, freeBytes: 8 * GB, count: 3, ...o });

  check(
    'commit at exactly 85 warns (the threshold is >=, not >)',
    /^MEMORY GUARD: commit charge at 85%/.test(decide({ pct: 85, used: 27, lim: 31.8 }) || ''),
    'at 85 the box is already spiking; 86 would be too late',
  );
  check(
    'commit at 84 with healthy RAM says NOTHING',
    decide({ pct: 84, used: 26, lim: 31.8 }) === null,
    'a guard that fires every session is worse than none \u2014 that is why the old freemem rule was replaced',
  );
  check(
    'commit wins over low RAM when BOTH are bad',
    /commit charge at 92%/.test(decide({ pct: 92, used: 29, lim: 31.8, freeBytes: 300 * MB }) || ''),
    'the precedence is commit, then RAM, then the unreadable-commit fallback',
  );
  check(
    'low RAM warns when commit is healthy',
    /^MEMORY GUARD: only 1799 MB of physical RAM/.test(decide({ pct: 40, used: 12, lim: 31.8, freeBytes: 1799 * MB }) || ''),
    'the 2026-09-11 bluescreens had commit at a harmless 33-35% and RAM at 43-921 MB',
  );
  check(
    'RAM at exactly 1800 MB says NOTHING (the floor is <, not <=)',
    decide({ pct: 40, used: 12, lim: 31.8, freeBytes: 1800 * MB }) === null,
    "1,800 MB is mem-watchdog.ps1's floor and must match it exactly",
  );
  check(
    'the RAM message prints the SAME figure that chose the branch',
    (decide({ pct: 40, used: 12, lim: 31.8, freeBytes: 1234 * MB }) || '').includes('only 1234 MB'),
    'it used to call os.freemem() twice \u2014 once to decide, once to print',
  );
  check(
    'an unreadable session count renders as words, never as null',
    (decide({ pct: 90, used: 28, lim: 31.8, count: 'an unknown number of' }) || '').includes(
      'with an unknown number of Claude Code sessions',
    ),
    'the count comes from a cache that can be missing or over an hour old, so it is allowed to be unknown',
  );
  check(
    'a healthy machine is SILENT',
    decide({ pct: 35, used: 11, lim: 31.8, freeBytes: 9 * GB }) === null,
    'quiet when healthy is the whole design',
  );
  check(
    'low RAM with an UNREADABLE commit charge says so, and names how to read it',
    (() => {
      const m = decide({ pct: null, freeBytes: 921 * MB }) || '';
      return /only 921 MB of physical RAM/.test(m) && /RAM-ONLY reading/.test(m) && /TotalVirtualMemorySize/.test(m);
    })(),
    'until 2026-10-06 this fact had nowhere to go: the branch meant to carry it was dead by arithmetic, ' +
      'so a session read a RAM-only warning never knowing the usually binding half was unavailable',
  );
  check(
    'low RAM with a READ commit charge does NOT claim it was unreadable',
    !/RAM-ONLY reading/.test(decide({ pct: 40, used: 12, lim: 31.8, freeBytes: 921 * MB }) || ''),
    'the clause is conditional \u2014 appending it always would make the common case say something false',
  );
  check(
    'an unreadable commit charge on a HEALTHY machine stays SILENT',
    decide({ pct: null, freeBytes: 8 * GB }) === null,
    'deliberately not restored: nothing is wrong, and a guard that speaks when nothing is wrong is the ' +
      'failure the 2026-08-25 rewrite existed to end',
  );
  check(
    'every message is prefixed MEMORY GUARD: so a reader can grep one line',
    [
      decide({ pct: 90, used: 28, lim: 31.8 }),
      decide({ pct: 40, used: 12, lim: 31.8, freeBytes: 900 * MB }),
    ].every((m) => typeof m === 'string' && m.startsWith('MEMORY GUARD: ')),
  );

  // --- the session stamping and the output contract, against the real hook as a CHILD PROCESS.
  // Never an import: the body below reads fd 0 and calls process.exit, so importing it would
  // swallow this runner's own stdin and kill the suite partway through, reporting a prefix of it
  // as the whole. USERPROFILE is redirected so the stamps and the 30-day prune land in a temp
  // folder and never touch the owner's live ~/.claude/.session-starts while he is working.
  const HOME_T = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-selftest-'));
  const STAMPS = path.join(HOME_T, '.claude', '.session-starts');
  const run = (payload) =>
    execFileSync(process.execPath, [process.argv[1]], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: HOME_T, HOME: HOME_T },
    });

  const out1 = run({ session_id: 'sess-aaa', source: 'startup' });
  check('a session_id is stamped on first run', fs.existsSync(path.join(STAMPS, 'sess-aaa.txt')));

  const first = fs.readFileSync(path.join(STAMPS, 'sess-aaa.txt'), 'utf8');
  fs.utimesSync(path.join(STAMPS, 'sess-aaa.txt'), new Date(), new Date());
  run({ session_id: 'sess-aaa', source: 'resume' });
  check(
    'a resume keeps the ORIGINAL start time, never a fresh one',
    fs.readFileSync(path.join(STAMPS, 'sess-aaa.txt'), 'utf8') === first,
    'sessions here run 6.5h median and have hit 8.9 days \u2014 restamping would reset the age the statusline shows',
  );

  const old = path.join(STAMPS, 'sess-ancient.txt');
  fs.writeFileSync(old, new Date(Date.now() - 40 * 86400000).toISOString());
  fs.utimesSync(old, new Date(Date.now() - 40 * 86400000), new Date(Date.now() - 40 * 86400000));
  run({ session_id: 'sess-bbb' });
  check('a stamp older than 30 days is pruned', !fs.existsSync(old));
  check('a fresh stamp survives the prune', fs.existsSync(path.join(STAMPS, 'sess-bbb.txt')));

  check(
    'output, when there is any, is a valid SessionStart additionalContext envelope',
    (() => {
      for (const o of [out1, run({ session_id: 'sess-ccc' })]) {
        if (o.trim() === '') continue;
        let j;
        try {
          j = JSON.parse(o);
        } catch {
          return false;
        }
        if (j?.hookSpecificOutput?.hookEventName !== 'SessionStart') return false;
        if (typeof j?.hookSpecificOutput?.additionalContext !== 'string') return false;
      }
      return true;
    })(),
    'a malformed envelope is dropped by the harness in silence, which looks exactly like a healthy machine',
  );

  check(
    'garbage on stdin does not crash it \u2014 it fails OPEN',
    (() => {
      try {
        run('not json at all');
        return true;
      } catch {
        return false;
      }
    })(),
    'this runs at the start of EVERY session; a throw here would be a startup failure on the whole machine',
  );

  // --- 2026-10-09: the blocking run starts NOTHING; PowerShell lives only in the async `refresh`.
  // spawn-probe.mjs (next to this file) records every child_process call the hook makes. TEMP is
  // redirected, so the cache here is a fixture and the live one is never read or written.
  const { pathToFileURL } = await import('node:url');
  const TMP_T = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-selftest-tmp-'));
  const PROBE = pathToFileURL(path.join(path.dirname(process.argv[1]), 'spawn-probe.mjs')).href;
  const CACHE_T = path.join(TMP_T, 'claude-statusline-sessions.json');
  const probed = (args, cache) => {
    const log = path.join(TMP_T, 'probe.jsonl');
    fs.writeFileSync(log, '');
    if (cache === null) fs.rmSync(CACHE_T, { force: true });
    else fs.writeFileSync(CACHE_T, JSON.stringify(cache));
    const stdout = execFileSync(process.execPath, ['--import', PROBE, process.argv[1], ...args], {
      input: JSON.stringify({ session_id: 'sess-probe', source: 'startup' }),
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: HOME_T, HOME: HOME_T, TEMP: TMP_T, TMP: TMP_T, SPAWN_PROBE_OUT: log },
    });
    const spawned = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).what);
    let after = null;
    try {
      after = JSON.parse(fs.readFileSync(CACHE_T, 'utf8'));
    } catch {}
    return { stdout, spawned, after };
  };
  const ago = (ms) => Date.now() - ms;

  check(
    'a session start with NO cache starts no process',
    probed([], null).spawned.length === 0,
    'until 2026-10-09 it started powershell.exe here: 1.0 s alone, 3.15 s median inside real starts',
  );
  check(
    'a session start with a 15-minute-old cache starts no process',
    probed([], { at: ago(15 * 60_000), n: 6, used: 20.8, lim: 79.8 }).spawned.length === 0,
    'the old 20-second cache made nearly every start pay for PowerShell',
  );
  check(
    'a cached reading IS used: 72 of 80 GB in the cache warns at 90%',
    /commit charge at 90%/.test(probed([], { at: ago(5 * 60_000), n: 6, used: 72, lim: 80 }).stdout),
    'proves the blocking run still reads commit, now from the cache instead of its own PowerShell',
  );
  check(
    'a reading over an hour old is NOT trusted for commit',
    (() => {
      const { stdout } = probed([], { at: ago(61 * 60_000), n: 6, used: 72, lim: 80 });
      // 🔴 The assertion is the PERCENTAGE, never the bare words "commit charge". It was
      // !/commit charge/ until 2026-10-09, which measured the MACHINE as much as the code: when
      // available RAM is under the 1,800 MB floor the low-RAM branch fires and its `unreadable`
      // clause says "The commit charge could not be read at all this time" — the CORRECT answer for
      // a stale cache, and the same substring. So this case FAILED at 1.27 GB available and PASSED
      // at 2.94 GB with not one line of the guard changed, which is a selftest reporting the
      // weather. What the case means is that no commit PERCENTAGE may be printed from a reading
      // past CACHE_MAX_AGE_MS, and that is now what it asserts.
      if (/commit charge at \d+%/.test(stdout)) return false;
      // Second half, free: whatever it DOES say must admit commit was unreadable rather than
      // quietly leaving it out. Empty is the healthy machine (no message at all); non-empty is the
      // low-RAM branch, which must carry the clause. Both states are now a pass for the right reason.
      return stdout.trim() === '' || /could not be read at all/.test(stdout);
    })(),
    'CACHE_MAX_AGE_MS is 60 minutes; past it, commit is unknown rather than stale',
  );
  check(
    '`refresh` skips PowerShell when the reading is under a minute old',
    (() => {
      const at = ago(10_000);
      const r = probed(['refresh'], { at, n: 6, used: 20.8, lim: 79.8 });
      return r.spawned.length === 0 && r.after?.at === at;
    })(),
    'a burst of session starts must run PowerShell once, not once per session',
  );
  check(
    '`refresh` with a stale reading DOES start PowerShell (the only place left that reads commit)',
    probed(['refresh'], { at: ago(2 * 3600_000), n: 6, used: 20.8, lim: 79.8 }).spawned.some((w) => /powershell/i.test(w)),
    'if refresh stopped running, the blocking run would go blind to commit and count without a sound',
  );
  try {
    fs.rmSync(TMP_T, { recursive: true, force: true });
  } catch {}

  check(
    "the owner's live ~/.claude/.session-starts was not touched by this run",
    !fs.existsSync(path.join(HOME_T, '.claude', '.next-step')) &&
      fs.readdirSync(STAMPS).every((f) => /^sess-/.test(f)),
    'if USERPROFILE redirection ever stops working, this suite would prune his real stamps',
  );

  try {
    fs.rmSync(HOME_T, { recursive: true, force: true });
  } catch {}

  console.log(`\n${ran} cases, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// MODE: `memory-guard.mjs refresh` — the ONLY place this file starts PowerShell (2026-10-09).
// Wired as its own SessionStart entry with "async": true, so no session waits for it: it refreshes
// the cache the blocking run reads, for the NEXT start. Above the stdin read on purpose — it needs
// no input, and readFileSync(0) would block a hand run. Skips when another start refreshed the
// reading under a minute ago, so a burst of starts runs PowerShell once.
if (process.argv[2] === 'refresh') {
  try {
    let fresh = false;
    try {
      fresh = Date.now() - JSON.parse(fs.readFileSync(CACHE, 'utf8')).at < REFRESH_MIN_AGE_MS;
    } catch {}
    if (!fresh) {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_STATS], {
        encoding: 'utf8',
        timeout: REFRESH_TIMEOUT_MS,
        windowsHide: true,
      });
      const [n, used, lim] = out.trim().split('|').map((v) => parseFloat(v));
      if (Number.isFinite(n)) {
        fs.writeFileSync(
          CACHE,
          JSON.stringify({ at: Date.now(), n, used: Number.isFinite(used) ? used : null, lim: Number.isFinite(lim) ? lim : null }),
        );
      }
    }
  } catch {}
  process.exit(0);
}

let input = null;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
} catch {}

// --- 1. stamp session start (first time only, so a resume keeps the original clock)
try {
  const sid = input?.session_id;
  if (sid) {
    const dir = path.join(HOME, '.claude', '.session-starts');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${sid}.txt`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, new Date().toISOString(), 'utf8');
    // prune stamps older than 30 days so the folder cannot grow forever
    const cutoff = Date.now() - 30 * 86_400_000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  }
} catch {}

// --- 2. saturation warning
// Counts Claude CODE engines only (PS_STATS, run by `refresh`). Claude Desktop ships as
// WindowsApps\Claude.exe and runs ~14 processes of its own; counting those would report ~21
// "sessions" and panic the reader.
//
// 2026-10-09 (hook speed fixes): this read the cache for 20 s and then started powershell.exe
// itself — 1.0 s alone, a median 3.15 s inside real session starts where a dozen hooks start at
// once — on nearly every start, and every session waited for it. The blocking run now only READS:
// count and commit come from a reading up to CACHE_MAX_AGE_MS old, else they are unknown (the
// message already says so). What stays live is the limit that bites, free RAM, read below with
// os.freemem(). Commit near its ~80 GB limit moves slowly (20.8 of 79.8 GB on 9 Oct): a reading an
// hour old still catches a climb to 85%.
function cachedStats() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - c.at < CACHE_MAX_AGE_MS) return { n: c.n ?? null, used: c.used ?? null, lim: c.lim ?? null };
  } catch {}
  return { n: null, used: null, lim: null };
}

// --- 2026-10-06: the message CHOICE is extracted so it can be tested -----------------------
// It used to read `os.freemem()` inline inside its own if/else chain, which meant nothing could
// drive the decision: the branch taken depended on the machine the test happened to run on, so
// the table below — three messages, one silence, in a strict precedence — was unverifiable. This
// function is PURE: every input arrives as an argument and nothing here touches the machine. The
// branch order, the thresholds and the message text are verbatim from what it replaced.
//
// One genuine difference, and it is a fix: the old code called `os.freemem()` TWICE on the RAM
// branch — once to decide and once to print — so the number in the message was not necessarily
// the number that chose the branch. `freeBytes` is read once by the caller and used for both.
function decideMessage({ pct, used, lim, freeBytes, count }) {
  if (pct !== null && pct >= COMMIT_WARN_PCT) {
    return (
      `MEMORY GUARD: commit charge at ${pct}% (${used} of ${lim} GB) with ${count} Claude Code ` +
      `sessions running. The binding limit here is COMMIT (RAM + pagefile), not RAM — at 100% the ` +
      `machine hard-freezes with no crash dump and loses every unsaved session. Prefer a cloud ` +
      `session for this task; do not start dev servers, builds, or typechecks while saturated; ` +
      `suggest the owner close an idle session before heavy local work.`
    );
  }
  if (freeBytes / 1048576 < 1800) {
    // Added 2026-09-11. Commit stopped being the ceiling that bites once the pagefile let commit reach
    // ~80 GB: both bluescreens that night came with commit at 33-35% while PHYSICAL RAM fell to 43-921 MB.
    // 1,800 MB is mem-watchdog.ps1's floor, where Windows starts evicting working sets. On Windows
    // os.freemem() is AVAILABLE memory (standby cache included), so file caching does not trip this.
    const freeMB = Math.round(freeBytes / 1048576);
    // 2026-10-06: say so when the commit charge is MISSING rather than merely healthy. Until today
    // that fact had nowhere to go — see the note below this function — so a session read a RAM-only
    // warning without knowing that the other, usually binding, half of the picture was unavailable.
    const unreadable =
      pct === null
        ? ' The commit charge could not be read at all this time, so this is a RAM-ONLY reading and the' +
          ' usually binding limit is unknown: check it before judging headroom —' +
          ' Win32_OperatingSystem.TotalVirtualMemorySize is the limit and FreeVirtualMemory the' +
          ' headroom, both in KB.'
        : '';
    return (
      `MEMORY GUARD: only ${freeMB} MB of physical RAM is available with ${count} Claude Code sessions ` +
      `running (floor 1,800 MB). On 2026-09-11 this 16 GB laptop bluescreened twice when heavy node jobs ` +
      `piled up under 1 GB, while commit read a harmless 33-35%. Do not start a dev server, typecheck, ` +
      `build or test run from this session now. The heavy-job gate and its queue were REMOVED on ` +
      `2026-09-17 (owner instruction) because they burned 33 h of waiting in under 3 days and ran ` +
      `nothing for 20 h of it, so nothing will stop you - this is a judgement call, not a gate. Prefer ` +
      `pushing the branch and letting CI answer, or a cloud session, and tell the owner which idle ` +
      `sessions or windows are worth closing.${unreadable}`
    );
  }
  // 🔴 REMOVED 2026-10-06: a third branch used to sit here, for "commit unreadable AND free RAM under
  // 1.0 GB". It was DEAD CODE from the moment the RAM branch above it was added on 2026-09-11: any
  // machine with under 1.0 GB free is also under that branch's 1800 MB floor, so the RAM branch
  // always returned first and this one could never be reached. It was not a dormant edge case — it
  // was unreachable by arithmetic, and the one thing it existed to say (commit is unavailable, treat
  // free RAM as a poor proxy, go read it yourself) therefore never reached anybody. That sentence is
  // now the `unreadable` clause above, where it is reachable on exactly the inputs it was written for.
  // Its `FALLBACK_LOW_FREE_RAM_GB` constant went with it; nothing else referenced it.
  //
  // What is deliberately NOT restored: a warning for an unreadable commit charge on a machine with
  // HEALTHY free RAM. Nothing is wrong in that case, and a guard that speaks when nothing is wrong is
  // the exact failure this hook was rewritten to end on 2026-08-25 — sessions learn to ignore it.
  return null;
}

try {
  const { n, used, lim } = cachedStats();
  const pct = used !== null && lim ? Math.round((used / lim) * 100) : null;
  const count = n === null ? 'an unknown number of' : n;
  // Read free memory ONCE and hand it to the pure decision above, so the figure in the message is
  // always the figure that chose the branch.
  const msg = decideMessage({ pct, used, lim, freeBytes: os.freemem(), count });

  if (msg) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
      }),
    );
  }
} catch {}

process.exit(0);
