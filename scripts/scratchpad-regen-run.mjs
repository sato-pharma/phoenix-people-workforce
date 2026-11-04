#!/usr/bin/env node
/**
 * scratchpad-regen-run.mjs — REBUILD lost scratchpad XLSX / PDF / DOCX / CSV by re-running the code that
 * originally built them (plan: <ARCHIVE>/_regen-plan.json from scratchpad-regen-plan.mjs).
 *
 * Owner instruction 2026-09-14: "recover all xlsx and pdf and docx — must recover".
 *
 * A rebuilt file is NOT the original: a generator that reads live data produces TODAY's numbers. Every
 * output lands in <ARCHIVE>/<ext>/_regenerated/... and is listed in _regen-results.json as regenerated.
 *
 * SAFETY — a generator runs only if ALL hold:
 *   - no database write / email / message / git / deploy / delete / network verb in its code
 *   - it writes nothing outside the scratchpads, imports no repo module, and every absolute input exists
 *   - it runs with cwd = its own scratchpad folder (never a repo checkout), one at a time, 180s cap,
 *     and waits while free RAM is under 2.2 GB
 *
 *   node scratchpad-regen-run.mjs            # dry run: prints what would run and what is refused, and why
 *   node scratchpad-regen-run.mjs --run
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync, execFileSync } from 'child_process';
import { ARCHIVE, copyNoClobber } from './scratchpad-archive.mjs';

const RUN = process.argv.includes('--run');
const PLAN = JSON.parse(fs.readFileSync(path.join(ARCHIVE, '_regen-plan.json'), 'utf8'));
const RESULTS = path.join(ARCHIVE, '_regen-results.json');
const LOG = path.join(ARCHIVE, '_regen', 'run.log');
const TEMP_CLAUDE = 'C:/Users/satoh/AppData/Local/Temp/claude';
const REPO_NODE_MODULES = 'F:/Phoenix Workforce/phoenix-workforce/node_modules';
const SOFFICE = 'C:/Program Files/LibreOffice/program/soffice.exe';

const DANGER = /\b(git|gh|railway|supabase\s+(db|migration|functions)|Remove-Item|rmdir|rimraf|Move-Item|curl|wget|Invoke-RestMethod|Invoke-WebRequest|schtasks|Register-ScheduledTask|Stop-Process|taskkill|shutdown|pnpm|npm|npx|pip\s+install|winget|choco)\b|\brm\s+-|\bdel\s+|unlinkSync|rmSync|os\.remove|shutil\.rmtree|\.unlink\(/i;
const log = (s) => { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()}  ${s}\n`); console.log(s); };
const freeMb = () => Math.round(os.freemem() / 1048576);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Group the lost files by the generator that built them.
const groups = new Map();
for (const f of PLAN.files) {
  if (!f.generator) continue;
  const k = f.generator.codeFile.toLowerCase();
  if (!groups.has(k)) groups.set(k, { gen: f.generator, files: [] });
  groups.get(k).files.push(f);
}

function refusal(g) {
  const code = fs.readFileSync(g.codeFile, 'utf8');
  if (g.sideEffects) return `database/message verb in code: ${g.sideEffects}`;
  if (DANGER.test(code)) return `dangerous command in code: ${code.match(DANGER)[0]}`;
  if (g.writesOutsideScratch) return 'writes outside the scratchpads';
  if (g.importsRepo) return 'imports repository code';
  if (g.network) return 'uses the internet';
  if (g.missingInputs.length) return `missing input: ${g.missingInputs[0]}`;
  if (g.runtime === 'tsx' || g.runtime === 'unknown') return `runtime ${g.runtime} not re-runnable standalone`;
  if (g.replayBroken) return 'script history incomplete (an edit could not be replayed)';
  return null;
}

/** The arguments the session passed after the script name, cut at the first shell separator. */
function argsAfter(runCommand, scriptPath) {
  if (!runCommand || !scriptPath) return [];
  const base = path.basename(scriptPath).toLowerCase();
  const i = runCommand.toLowerCase().indexOf(base);
  if (i < 0) return [];
  let rest = runCommand.slice(i + base.length).replace(/^["']/, '');
  rest = rest.split(/\r?\n|&&|\|\||;|\|/)[0].trim();
  if (/[<>`$]/.test(rest)) return null; // redirection or substitution: not safe to reproduce blindly
  return (rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ''));
}

function commandFor(g) {
  const shellOk = (s) => !DANGER.test(s);
  if (g.kind.startsWith('script') && g.scriptPath) {
    const args = argsAfter(g.runCommand, g.scriptPath);
    if (args === null) return { refuse: 'run command uses redirection or substitution' };
    const ext = path.extname(g.scriptPath).toLowerCase();
    if (ext === '.py') return { exe: 'python', args: [g.scriptPath, ...args] };
    if (['.mjs', '.cjs', '.js'].includes(ext)) return { exe: process.execPath, args: [g.scriptPath, ...args] };
    if (ext === '.ps1') return { exe: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', g.scriptPath, ...args] };
    if (ext === '.sh') return { exe: 'C:/Program Files/Git/bin/bash.exe', args: [g.scriptPath, ...args] };
    return { refuse: `script type ${ext} not re-runnable` };
  }
  // Inline: re-run the exact command text in its own shell, from the scratchpad folder.
  const cmd = String(g.runCommand ?? '');
  if (!shellOk(cmd)) return { refuse: `dangerous command: ${cmd.match(DANGER)[0]}` };
  if (/\bcd\s+["']?[A-Za-z]:[\\/](?!Users[\\/]satoh[\\/]AppData[\\/]Local[\\/]Temp[\\/]claude)/i.test(cmd) || /Set-Location|pushd/i.test(cmd)) return { refuse: 'command changes into a folder outside the scratchpads' };
  if (g.shell === 'PowerShell') return { exe: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd] };
  return { exe: 'C:/Program Files/Git/bin/bash.exe', args: ['-c', cmd] };
}

function regeneratedDest(original) {
  const parts = path.resolve(original).split(path.sep);
  const i = parts.findIndex((s, k) => s.toLowerCase() === 'claude' && parts[k - 1]?.toLowerCase() === 'temp');
  const rel = parts.slice(i + 1);
  const project = rel.shift();
  const session = (rel.shift() ?? '_root').slice(0, 8);
  if (rel[0] === 'scratchpad' && rel.length > 1) rel.shift();
  return path.join(ARCHIVE, path.extname(original).slice(1).toLowerCase(), '_regenerated', project.replace(/-phoenix-workforce--claude-worktrees-/i, '-wt-').slice(-60), session, ...rel);
}

// Keep only earlier successes; every other verdict is re-decided on this run (no duplicate rows).
let results = [];
try { results = JSON.parse(fs.readFileSync(RESULTS, 'utf8')).filter((r) => r.status === 'regenerated'); } catch {}
// A "lost path" scraped from a directory listing can carry the listing's next line with it.
// Either slash style is a real path; what marks a scraped one is a second drive path, a run of spaces,
// or a name that no longer ends in a document extension.
const validPath = (p) => /^[A-Za-z]:[\\/][^\r\n<>|"*?`→]+$/.test(p) && !/.[A-Za-z]:[\\/]/.test(p) && !/\s{2,}/.test(p)
  && /\.(xlsx|xlsm|xls|pdf|docx|doc|csv)$/i.test(p);
const done = new Set(results.filter((r) => r.status === 'regenerated').map((r) => r.path.toLowerCase()));

// node_modules for standalone node generators: a TEMPORARY junction, removed with cmd's non-recursive rmdir.
const junction = `${TEMP_CLAUDE}/node_modules`;
let madeJunction = false;
if (RUN && !fs.existsSync(junction)) {
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction.replace(/\//g, '\\'), REPO_NODE_MODULES.replace(/\//g, '\\')], { stdio: 'ignore', windowsHide: true });
  madeJunction = true;
}

const summary = { generators: groups.size, ran: 0, refused: 0, filesRegenerated: 0, filesNotProduced: 0 };
try {
  let n = 0;
  for (const { gen: g, files } of groups.values()) {
    n++;
    for (const f of files) if (!validPath(f.path)) results.push({ path: f.path, status: 'invalid-path' });
    const pending = files.filter((f) => validPath(f.path) && !done.has(f.path.toLowerCase()) && !fs.existsSync(f.path));
    if (!pending.length) continue;
    const why = refusal(g);
    const cmd = why ? null : commandFor(g);
    if (why || cmd.refuse) {
      summary.refused++;
      for (const f of pending) results.push({ path: f.path, status: 'refused', reason: why ?? cmd.refuse, codeFile: g.codeFile });
      if (!RUN) console.log(`REFUSE [${why ?? cmd.refuse}]  ${path.basename(g.codeFile)}  (${pending.length} files)`);
      continue;
    }
    if (!RUN) { console.log(`RUN    ${path.basename(g.codeFile)}  (${pending.length} files)`); summary.ran++; continue; }

    while (freeMb() < 2200) { log(`waiting: free RAM ${freeMb()} MB`); sleep(30000); }
    // Recreate the script (if deleted) and every output folder, then run from the scratchpad folder.
    if (g.scriptPath && !fs.existsSync(g.scriptPath)) {
      fs.mkdirSync(path.dirname(g.scriptPath), { recursive: true });
      fs.copyFileSync(g.codeFile, g.scriptPath);
    }
    for (const f of pending) {
      try { fs.mkdirSync(path.dirname(f.path), { recursive: true }); }
      catch (e) { log(`  cannot create folder for ${f.path}: ${e.code}`); }
    }
    const cwd = g.scriptPath ? path.dirname(g.scriptPath) : path.dirname(pending[0].path);
    const started = Date.now();
    const r = spawnSync(cmd.exe, cmd.args, { cwd, timeout: 180000, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    summary.ran++;
    // A timeout kills only the direct child; take down its whole tree (e.g. bash -> python).
    // The child is already dead by then, so walk its orphans by their recorded parent id — never by
    // name or start time, which would catch other sessions' processes.
    if (r.error?.code === 'ETIMEDOUT' && r.pid) {
      try {
        const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $kill = @(); $q = @(${r.pid}); ` +
          `while ($q.Count) { $p = $q[0]; $q = @($q | Select-Object -Skip 1); foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p -and $_.ProcessId -ne $PID })) { $kill += $c.ProcessId; $q += $c.ProcessId } }; ` +
          `foreach ($k in $kill) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue }; $kill -join ','`;
        const killed = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
        if (killed) log(`  killed orphaned children of timed-out run: ${killed}`);
      } catch {}
    }
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().slice(-600).replace(/\s+/g, ' ');
    log(`[${n}/${groups.size}] exit=${r.status}${r.error ? ` err=${r.error.code}` : ''} ${Math.round((Date.now() - started) / 1000)}s ${path.basename(g.codeFile)}`);
    for (const f of pending) {
      if (fs.existsSync(f.path) && fs.statSync(f.path).mtimeMs >= started - 2000) {
        const dest = regeneratedDest(f.path);
        if (!fs.existsSync(dest)) copyNoClobber(f.path, dest, fs.statSync(f.path));
        results.push({ path: f.path, status: 'regenerated', archivedAs: dest, codeFile: g.codeFile, readsLiveData: !!g.readsSupabase });
        summary.filesRegenerated++;
      } else {
        results.push({ path: f.path, status: 'not-produced', exit: r.status, error: r.error?.code ?? null, outputTail: tail, codeFile: g.codeFile });
        summary.filesNotProduced++;
      }
    }
    fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  }
} finally {
  if (madeJunction) { try { execFileSync('cmd.exe', ['/c', 'rmdir', junction.replace(/\//g, '\\')], { stdio: 'ignore', windowsHide: true }); } catch (e) { log(`could not remove junction: ${e.message}`); } }
  if (RUN) fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(summary, null, 2));
