#!/usr/bin/env node
/**
 * scratchpad-regen-plan.mjs — for every LOST scratchpad XLSX / XLSM / PDF / DOCX / DOC / CSV, find in
 * its own session transcript: (1) proof it was really created, (2) the code that built it, (3) whether
 * that code is fully recoverable, (4) whether re-running it could change anything outside the file
 * (database writes, emails, messages), and (5) which inputs it read that no longer exist.
 *
 * Owner instruction 2026-09-14: "recover all xlsx and pdf and docx — must recover". Their bytes are in
 * no transcript and the SSD's TRIM makes undelete impossible, so the only way back is to REBUILD them
 * by re-running their generator. This script plans that; it runs nothing.
 *
 *   node scratchpad-regen-plan.mjs     # writes <ARCHIVE>/_regen-plan.json and prints a summary
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ARCHIVE } from './scratchpad-archive.mjs';

const PROJECTS = 'C:/Users/satoh/.claude/projects';
const DOC_EXT = new Set(['xlsx', 'xlsm', 'xls', 'pdf', 'docx', 'doc', 'csv']);
const SCRIPT_EXT = /\.(py|mjs|cjs|js|ts|ps1|sh|sql)$/i;
const SIDE_EFFECT = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|upsert\(|\.insert\(|\.update\(|\.delete\(|\.rpc\(|apply_migration|execute_sql|sendMail|resend|nodemailer|smtp|telegram|sendMessage|whatsapp|requests\.(post|put|patch|delete)|method:\s*['"](POST|PUT|PATCH|DELETE)|gh\s+pr|git\s+push|railway\s)/i;
const INPUT_PATH = /[A-Za-z]:[\\/]+[^"'`\n\r<>|*?]+?\.(xlsx|xlsm|xls|csv|pdf|docx|json|txt|png|jpe?g)\b/gi;

const extOf = (p) => path.extname(p).slice(1).toLowerCase();
const lostAll = fs.readFileSync(path.join(ARCHIVE, '_lost-cannot-recover.txt'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Za-z]:/.test(l));
const lost = lostAll.filter((p) => DOC_EXT.has(extOf(p)));

// session id (first 8 of the uuid folder in the scratchpad path) -> lost files in it
const sessionOf = (p) => (p.match(/[\\/]([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]/i) || [])[1]?.toLowerCase();
const bySession = new Map();
for (const p of lost) {
  const s = sessionOf(p) ?? '_none';
  if (!bySession.has(s)) bySession.set(s, []);
  bySession.get(s).push({ path: p, base: path.basename(p).toLowerCase() });
}

const plan = new Map(); // lost path -> record
for (const p of lost) plan.set(p, { path: p, ext: extOf(p), session: sessionOf(p) ?? null, createdEvidence: null, sentToUser: false, generator: null, notes: [] });

function listJsonl(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out); else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
};

function replayScript(ops) {
  let text = null, broken = false;
  for (const op of ops) {
    if (op.kind === 'write') text = op.content;
    else if (text === null || !text.includes(op.old)) broken = true;
    else text = op.all ? text.split(op.old).join(op.new) : text.replace(op.old, () => op.new);
  }
  return { text, broken };
}

async function scanFile(file) {
  // Which session does this transcript belong to? Main: <uuid>.jsonl; subagent: <uuid>/subagents/*.jsonl
  const m = file.match(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const sid = m?.[1]?.toLowerCase();
  const targets = bySession.get(sid);
  if (!targets) return;
  const pending = new Map();
  const scripts = new Map(); // script path lower -> ops
  const commands = [];       // {ts, name, text, ok, result}
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(rec.timestamp ?? '') || 0;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use') pending.set(c.id, { name: c.name, input: c.input ?? {}, ts });
      if (c.type !== 'tool_result') continue;
      const use = pending.get(c.tool_use_id);
      if (!use) continue;
      pending.delete(c.tool_use_id);
      const ok = !c.is_error;
      const result = textOf(c.content).slice(0, 20000);
      const { name, input } = use;
      if (ok && (name === 'Write' || name === 'Edit') && SCRIPT_EXT.test(input.file_path ?? '')) {
        const k = input.file_path.toLowerCase();
        if (!scripts.has(k)) scripts.set(k, { path: input.file_path, ops: [] });
        scripts.get(k).ops.push(name === 'Write'
          ? { ts, kind: 'write', content: input.content ?? '' }
          : { ts, kind: 'edit', old: input.old_string ?? '', new: input.new_string ?? '', all: !!input.replace_all });
      }
      if (name === 'SendUserFile' && ok) {
        for (const f of input.files ?? []) for (const t of targets) if (path.basename(String(f)).toLowerCase() === t.base) plan.get(t.path).sentToUser = true;
      }
      const cmdText = typeof input.command === 'string' ? input.command : name === 'Write' ? String(input.content ?? '') : '';
      commands.push({ ts, name, cmd: cmdText, ok, result, filePath: input.file_path, cwd: rec.cwd ?? null });
    }
  }

  for (const t of targets) {
    const rec = plan.get(t.path);
    // (1) proof of creation: a successful tool result that names the file
    const evidence = commands.find((c) => c.ok && c.result.toLowerCase().includes(t.base));
    if (evidence && !rec.createdEvidence) {
      const i = evidence.result.toLowerCase().indexOf(t.base);
      rec.createdEvidence = evidence.result.slice(Math.max(0, i - 160), i + t.base.length + 80).replace(/\s+/g, ' ');
    }
    // (2) the generator: a script whose final content names the file, else an inline command that does
    let best = null;
    for (const s of scripts.values()) {
      const { text, broken } = replayScript(s.ops);
      if (!text || !text.toLowerCase().includes(t.base)) continue;
      const runner = commands.find((c) => c.ok && c.cmd.toLowerCase().includes(path.basename(s.path).toLowerCase()) && c.name !== 'Write' && c.name !== 'Edit');
      best = { kind: 'script', scriptPath: s.path, scriptStillOnDisk: fs.existsSync(s.path), replayBroken: broken, runCommand: runner?.cmd ?? null, runCwd: runner?.cwd ?? null, code: text };
    }
    if (!best) {
      const inline = commands.filter((c) => c.ok && (c.name === 'Bash' || c.name === 'PowerShell') && c.cmd.toLowerCase().includes(t.base) && /python|node|tsx|soffice|libreoffice|pandoc|openpyxl|exceljs|reportlab|docx|playwright|chrome|msedge|wkhtml|Export|ConvertTo|Excel/i.test(c.cmd));
      const pick = inline.at(-1);
      if (pick) best = { kind: 'inline', runCommand: pick.cmd, runCwd: pick.cwd, shell: pick.name, code: pick.cmd };
    }
    if (!best) {
      // Script built the name dynamically: any script run shortly BEFORE the evidence.
      if (evidence) {
        const prior = commands.filter((c) => c.ts <= evidence.ts && c.ok && (c.name === 'Bash' || c.name === 'PowerShell')).at(-1);
        if (prior) {
          const ref = [...scripts.values()].find((s) => prior.cmd.toLowerCase().includes(path.basename(s.path).toLowerCase()));
          const code = ref ? replayScript(ref.ops).text : prior.cmd;
          best = { kind: ref ? 'script-dynamic-name' : 'inline-dynamic-name', scriptPath: ref?.path ?? null, scriptStillOnDisk: ref ? fs.existsSync(ref.path) : null, runCommand: prior.cmd, runCwd: prior.cwd, shell: prior.name, code };
        }
      }
    }
    if (best && !rec.generator) {
      const code = best.code ?? '';
      const inputs = [...new Set([...code.matchAll(INPUT_PATH)].map((x) => x[0]))].filter((p) => path.basename(p).toLowerCase() !== t.base);
      best.sideEffects = SIDE_EFFECT.test(code) ? (code.match(SIDE_EFFECT) || [])[0] : null;
      best.readsSupabase = /supabase|SUPABASE_|postgres|psycopg|pg\b|createClient/i.test(code);
      best.missingInputs = inputs.filter((p) => !fs.existsSync(p));
      best.codeChars = code.length;
      // Stricter screen for an unattended re-run.
      const run = `${best.runCommand ?? ''}`;
      best.runtime = /python|\.py\b/i.test(run) ? 'python' : /tsx|\.ts\b/i.test(run) ? 'tsx' : /node|\.m?js\b/i.test(run) ? 'node' : /soffice|libreoffice/i.test(run) ? 'soffice' : best.shell === 'PowerShell' ? 'powershell' : best.shell === 'Bash' ? 'bash' : 'unknown';
      const cwd = String(best.runCwd ?? '');
      best.cwdKind = /temp[\\/]claude/i.test(cwd) ? 'scratch' : /[\\/]_wt-|claude[\\/]worktrees/i.test(cwd) ? 'worktree' : /phoenix-workforce$/i.test(cwd) ? 'repo-primary' : cwd ? 'other' : 'unknown';
      best.cwdExists = cwd ? fs.existsSync(cwd) : false;
      best.usesPnpm = /\b(pnpm|npx|npm)\b/i.test(run);
      best.importsRepo = /from\s+['"](@\/|\.\.?\/|src\/)|require\(\s*['"](@\/|\.\.?\/|src\/)|sys\.path\.(insert|append)/.test(code);
      best.network = /https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(code) || /\bfetch\(|requests\.|urllib|axios/.test(code);
      const WRITE_VERB = /writeFile|writeFileSync|createWriteStream|\.to_excel|\.to_csv|\.save\(|wb\.save|doc\.save|xlsx\.write|workbook\.xlsx\.writeFile|open\([^)]*['"][wax]b?['"]|Set-Content|Out-File|Copy-Item|Move-Item|copyFile|rename|shutil\.(copy|move)|>\s*["']?[A-Za-z]:/;
      const abs = [...new Set([...code.matchAll(/[A-Za-z]:[\\/]+[^"'`\n\r<>|*?]{2,}/g)].map((x) => x[0].trim()))];
      best.outsideScratchPaths = abs.filter((p) => !/temp[\\/]+claude/i.test(p)).slice(0, 12);
      best.writesOutsideScratch = WRITE_VERB.test(code) && best.outsideScratchPaths.some((p) => /phoenix-workforce|[\\/]_wt-|[\\/]xlsx[\\/]|PHX backup|FTP|satopharma/i.test(p) && !/\.env/i.test(p));
      // The code itself, for the runner and for review.
      const codeDir = path.join(ARCHIVE, '_regen', 'code', rec.session ?? '_none');
      fs.mkdirSync(codeDir, { recursive: true });
      const codeName = best.scriptPath ? path.basename(best.scriptPath) : `inline-${Buffer.from(run).toString('base64url').slice(0, 16)}.${best.shell === 'PowerShell' ? 'ps1' : 'sh'}`;
      best.codeFile = path.join(codeDir, codeName);
      if (!fs.existsSync(best.codeFile)) fs.writeFileSync(best.codeFile, code);
      delete best.code;
      rec.generator = best;
    }
  }
}

const files = listJsonl(PROJECTS);
for (const f of files) { try { await scanFile(f); } catch (e) { console.error(`${f}: ${e.message}`); } }

const recs = [...plan.values()];
const summary = { lostDocs: recs.length, byExt: {}, provenCreated: 0, sentToUser: 0, generatorFound: 0, generatorSafe: 0, generatorHasSideEffects: 0, generatorMissingInputs: 0, readsProductionData: 0, noGenerator: 0, noEvidenceAndNoGenerator: 0 };
for (const r of recs) {
  summary.byExt[r.ext] = (summary.byExt[r.ext] ?? 0) + 1;
  if (r.createdEvidence) summary.provenCreated++;
  if (r.sentToUser) summary.sentToUser++;
  if (r.generator) {
    summary.generatorFound++;
    if (r.generator.sideEffects) summary.generatorHasSideEffects++;
    if (r.generator.missingInputs.length) summary.generatorMissingInputs++;
    if (r.generator.readsSupabase) summary.readsProductionData++;
    if (!r.generator.sideEffects && !r.generator.missingInputs.length) summary.generatorSafe++;
  } else {
    summary.noGenerator++;
    if (!r.createdEvidence) summary.noEvidenceAndNoGenerator++;
  }
}
const gens = recs.filter((r) => r.generator).map((r) => r.generator);
const uniq = new Map(gens.map((g) => [g.codeFile.toLowerCase(), g]));
const tally = (f) => [...uniq.values()].reduce((a, g) => { const k = String(f(g)); a[k] = (a[k] ?? 0) + 1; return a; }, {});
summary.uniqueGenerators = uniq.size;
summary.gen_runtime = tally((g) => g.runtime);
summary.gen_cwdKind = tally((g) => `${g.cwdKind}${g.cwdExists ? '' : ':gone'}`);
summary.gen_usesPnpm = tally((g) => g.usesPnpm);
summary.gen_importsRepo = tally((g) => g.importsRepo);
summary.gen_network = tally((g) => g.network);
summary.gen_writesOutsideScratch = tally((g) => g.writesOutsideScratch);
summary.gen_sideEffects = tally((g) => !!g.sideEffects);
summary.gen_missingInputs = tally((g) => g.missingInputs.length > 0);
summary.gen_strictSafe = [...uniq.values()].filter((g) => !g.sideEffects && !g.missingInputs.length && !g.writesOutsideScratch && !g.usesPnpm && !g.network && g.runtime !== 'unknown').length;
fs.writeFileSync(path.join(ARCHIVE, '_regen-plan.json'), JSON.stringify({ summary, files: recs }, null, 2));
console.log(JSON.stringify(summary, null, 2));
