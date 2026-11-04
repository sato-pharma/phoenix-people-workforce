#!/usr/bin/env node
/**
 * scratchpad-recover.mjs — rebuild scratchpad files that were DELETED, from the session transcripts.
 *
 * Companion to scratchpad-archive.mjs (owner instruction 2026-09-14: recover the deleted ones).
 * A transcript (~/.claude/projects/**\/*.jsonl) keeps:
 *   - the full text of every Write, and every Edit after it  -> HTML / SVG / CSV rebuilt by replay
 *   - the pixels of every image a session Read back           -> PNG / JPG / PDF as the session saw it
 *   - every browser/desktop screenshot a tool returned        -> PNG / JPG (only with --screenshots)
 * Anything produced by a script (a generated PDF, XLSX, DOCX) never had its bytes in a transcript,
 * so it cannot be rebuilt here — it is listed as lost instead, never silently dropped.
 *
 *   node scratchpad-recover.mjs                 # report only
 *   node scratchpad-recover.mjs --write         # write recovered files into the archive
 *   node scratchpad-recover.mjs --write --screenshots
 *
 * Recovered files go to <ARCHIVE>/<ext>/_recovered/<project>/<session>/<path>; nothing is overwritten.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ARCHIVE, EXTENSIONS, projectLabel, copyNoClobber } from './scratchpad-archive.mjs';

const WRITE = process.argv.includes('--write');
const SHOTS = process.argv.includes('--screenshots');
const PROJECTS = 'C:/Users/satoh/.claude/projects';
const SCRATCH_RE = /(appdata[\\/]+local[\\/]+temp[\\/]+claude|scratch-workspaces)[\\/]/i;
const PATH_IN_TEXT = /[A-Za-z]:(?:\\\\|\\|\/)[^"'<>|\n\r*?]*?(?:Temp(?:\\\\|\\|\/)claude|scratch-workspaces)(?:\\\\|\\|\/)[^"'<>|\n\r*?]*?\.(?:html?|pdf|xlsx|xlsm|xls|csv|docx?|svg|png|jpe?g|webp|gif|bmp)\b/gi;
const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

const norm = (p) => path.resolve(p.replace(/\\\\/g, '\\')).toLowerCase();
const extOf = (p) => path.extname(p).slice(1).toLowerCase();

/** <ext>/_recovered/<project>/<session>/<rest> for an original scratchpad path. */
function recoveredDest(original, ext = extOf(original)) {
  const parts = path.resolve(original).split(path.sep);
  let i = parts.findIndex((s, k) => s.toLowerCase() === 'claude' && parts[k - 1]?.toLowerCase() === 'temp');
  if (i < 0) i = parts.findIndex((s) => s.toLowerCase() === 'scratch-workspaces');
  const rel = parts.slice(i + 1);
  const project = rel.length > 1 ? projectLabel(rel.shift()) : '_root';
  let session = rel.length > 1 ? rel.shift() : '_root';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(session)) session = session.slice(0, 8);
  if (rel[0] === 'scratchpad' && rel.length > 1) rel.shift();
  const file = rel.join(path.sep);
  const withExt = extOf(file) === ext ? file : `${file}.${ext}`;
  return path.join(ARCHIVE, ext, '_recovered', project, session, withExt);
}

function listJsonl(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const ops = new Map();        // normPath -> [{ts, kind, original, content|old|new|all, data, media}]
const mentioned = new Map();  // normPath -> original spelling
const artifacts = new Map();  // normPath -> {original, url} for pages published from a scratchpad file
const shots = [];             // {ts, session, tool, media, file, line}
let shotBytes = 0;

function addOp(original, op) {
  const k = norm(original);
  if (!ops.has(k)) ops.set(k, []);
  ops.get(k).push({ ...op, original });
}

async function scan(file) {
  const pending = new Map(); // tool_use_id -> {name, input}
  const session = path.basename(file, '.jsonl').slice(0, 8);
  const project = projectLabel(path.relative(PROJECTS, file).split(path.sep)[0]);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line) continue;
    if (/Temp[\\/]+claude|scratch-workspaces/i.test(line)) {
      for (const m of line.matchAll(PATH_IN_TEXT)) {
        const p = m[0].replace(/\\\\/g, '\\');
        if (!/[\\/]\.\.[\\/]/.test(p)) mentioned.set(norm(p), p);
      }
    }
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(rec.timestamp ?? '') || 0;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use') pending.set(c.id, { name: c.name, input: c.input ?? {} });
      if (c.type !== 'tool_result') continue;
      const use = pending.get(c.tool_use_id);
      if (!use) continue;
      pending.delete(c.tool_use_id);
      const { name, input } = use;
      const fp = input.file_path;
      const ok = !c.is_error;
      if (ok && name === 'Artifact' && fp && SCRATCH_RE.test(fp)) {
        const text = JSON.stringify(c.content ?? '');
        const url = text.match(/https:\/\/[^\s"'\\]*claude\.ai\/[^\s"'\\]+/)?.[0];
        if (url) artifacts.set(norm(fp), { original: fp, url });
      }
      if (ok && fp && SCRATCH_RE.test(fp) && EXTENSIONS.includes(extOf(fp))) {
        if (name === 'Write' && typeof input.content === 'string') addOp(fp, { ts, kind: 'write', content: input.content });
        if (name === 'Edit' && typeof input.old_string === 'string') addOp(fp, { ts, kind: 'edit', old: input.old_string, new: input.new_string ?? '', all: !!input.replace_all });
      }
      const blocks = Array.isArray(c.content) ? c.content : [];
      for (const b of blocks) {
        const src = b?.source;
        if (!src || src.type !== 'base64' || !src.data) continue;
        const media = src.media_type;
        if (!MEDIA_EXT[media]) continue;
        if (name === 'Read' && fp && SCRATCH_RE.test(fp)) {
          addOp(fp, { ts, kind: 'bytes', data: src.data, media });
        } else if (/screenshot|computer|zoom|preview/i.test(name) || /screenshot|zoom/i.test(String(input.action ?? ''))) {
          shotBytes += Math.floor(src.data.length * 0.75);
          shots.push({ ts, project, session, tool: name.replace(/^mcp__/, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40), media, data: SHOTS && WRITE ? src.data : null });
        }
      }
    }
  }
}

function replay(list) {
  list.sort((a, b) => a.ts - b.ts);
  let text = null, bytes = null, media = null, partial = 0;
  for (const op of list) {
    if (op.kind === 'write') { text = op.content; bytes = null; }
    else if (op.kind === 'edit') {
      if (text === null || !text.includes(op.old)) { partial++; continue; }
      text = op.all ? text.split(op.old).join(op.new) : text.replace(op.old, () => op.new);
    } else if (op.kind === 'bytes') {
      // A Read shows the file as it was then; only use it when no text history exists.
      if (text === null) { bytes = op.data; media = op.media; }
    }
  }
  return { text, bytes, media, partial };
}

function writeOnce(dest, buf, ts) {
  if (fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  const t = ts ? new Date(ts) : new Date();
  try { fs.utimesSync(tmp, t, t); } catch {}
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o444); } catch {}
  return true;
}

const files = listJsonl(PROJECTS);
let n = 0;
for (const f of files) {
  n++;
  try { await scan(f); } catch (e) { console.error(`scan failed ${f}: ${e.message}`); }
  if (n % 200 === 0) console.error(`scanned ${n}/${files.length}`);
}

const report = { transcripts: files.length, recoveredText: 0, recoveredImage: 0, partialEdits: 0, alreadyExists: 0, lost: [], screenshots: shots.length, screenshotMB: +(shotBytes / 1048576).toFixed(1), written: 0 };
for (const [k, list] of ops) {
  const original = list[0].original;
  if (fs.existsSync(original)) { report.alreadyExists++; continue; }
  const r = replay(list);
  if (r.partial) report.partialEdits++;
  if (r.text !== null) {
    report.recoveredText++;
    if (WRITE && writeOnce(recoveredDest(original), Buffer.from(r.text, 'utf8'), list.at(-1).ts)) report.written++;
  } else if (r.bytes) {
    report.recoveredImage++;
    if (WRITE && writeOnce(recoveredDest(original, MEDIA_EXT[r.media]), Buffer.from(r.bytes, 'base64'), list.at(-1).ts)) report.written++;
  }
}
for (const [k, original] of mentioned) {
  if (ops.has(k) || fs.existsSync(original)) continue;
  report.lost.push(original);
}
if (WRITE && SHOTS) {
  const pad = (x) => String(x).padStart(2, '0');
  for (const [i, s] of shots.entries()) {
    const d = new Date(s.ts || 0);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const ext = MEDIA_EXT[s.media];
    const dest = path.join(ARCHIVE, ext, '_screenshots-from-transcripts', s.project, s.session, `${stamp}-${String(i).padStart(5, '0')}-${s.tool}.${ext}`);
    if (writeOnce(dest, Buffer.from(s.data, 'base64'), s.ts)) report.written++;
  }
}

const lostFile = path.join(ARCHIVE, '_lost-cannot-recover.txt');
if (WRITE) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  fs.writeFileSync(lostFile, `Scratchpad files named in a transcript that no longer exist and whose bytes no transcript holds.\nGenerated ${new Date().toISOString()}\n\n${report.lost.sort().join('\n')}\n`);
}
// Lost HTML that was published as an Artifact can still be read back from the artifact itself.
const lostSet = new Set(report.lost.map(norm));
const fromArtifacts = [...artifacts].filter(([k]) => lostSet.has(k) || (!fs.existsSync(artifacts.get(k).original) && !ops.has(k))).map(([, v]) => v);
report.lostButPublished = fromArtifacts.length;
if (WRITE) {
  fs.writeFileSync(path.join(ARCHIVE, '_lost-but-published-as-artifact.json'), JSON.stringify(fromArtifacts.map((v) => ({ ...v, dest: recoveredDest(v.original) })), null, 2));
}
const lostByExt = {};
for (const p of report.lost) lostByExt[extOf(p)] = (lostByExt[extOf(p)] ?? 0) + 1;
console.log(JSON.stringify({ ...report, lost: report.lost.length, lostByExt }, null, 2));
