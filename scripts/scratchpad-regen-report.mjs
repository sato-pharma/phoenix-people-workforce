#!/usr/bin/env node
/**
 * scratchpad-regen-report.mjs — one readable account of the lost-document recovery: every lost XLSX /
 * XLSM / PDF / DOCX / DOC / CSV and what happened to it (copy found elsewhere, rebuilt, rebuild failed
 * and why, refused and why, never existed). Writes <ARCHIVE>/_recovery-report.json and prints a summary.
 */
import fs from 'fs';
import path from 'path';
import { ARCHIVE } from './scratchpad-archive.mjs';

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')); } catch { return d; } };
const plan = read('_regen-plan.json', { files: [] });
const results = read('_regen-results.json', []);
const found = read('_found-elsewhere.json', []);

const foundByLost = new Map();
for (const f of found) for (const o of f.lostOriginals ?? []) {
  const k = o.toLowerCase();
  if (!foundByLost.has(k)) foundByLost.set(k, []);
  foundByLost.get(k).push(f.foundAt);
}
const lastResult = new Map();
for (const r of results) lastResult.set(r.path.toLowerCase(), r);

function failureReason(tail = '') {
  const m = tail.match(/ModuleNotFoundError: No module named '([^']+)'/) || tail.match(/Cannot find (?:module|package) '([^']+)'/);
  if (m) return `missing library: ${m[1]}`;
  if (/FileNotFoundError|No such file|ENOENT|cannot find the path|does not exist/i.test(tail)) return 'an input file no longer exists';
  if (/401|403|JWT|permission denied|invalid api key/i.test(tail)) return 'access refused by a service';
  if (/SyntaxError|IndentationError/i.test(tail)) return 'script text incomplete';
  if (/KeyError|IndexError|TypeError|ValueError|AttributeError/.test(tail)) return 'data has changed shape since';
  return 'script ran but did not produce this file';
}

const rows = [];
for (const f of plan.files) {
  const k = f.path.toLowerCase();
  const r = lastResult.get(k);
  let outcome, detail = '';
  if (r?.status === 'regenerated') { outcome = 'rebuilt'; detail = r.archivedAs; }
  else if (foundByLost.has(k)) { outcome = 'copy found elsewhere'; detail = foundByLost.get(k)[0]; }
  else if (r?.status === 'invalid-path') { outcome = 'not a real file (bad name in a log)'; }
  else if (!f.generator && !f.createdEvidence) { outcome = 'no sign it ever existed'; }
  else if (!f.generator) { outcome = 'existed, no code left to rebuild it'; }
  else if (r?.status === 'refused') { outcome = 'rebuild refused (unsafe)'; detail = r.reason; }
  else if (r?.status === 'not-produced') { outcome = 'rebuild failed'; detail = r.error === 'ETIMEDOUT' ? 'took longer than 3 minutes' : failureReason(r.outputTail); }
  else { outcome = 'not attempted'; }
  rows.push({ file: path.basename(f.path), ext: f.ext, outcome, detail, sentToUser: f.sentToUser, path: f.path });
}

const count = (key) => rows.reduce((a, r) => { const k = key(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
const report = {
  generatedAt: new Date().toISOString(),
  total: rows.length,
  byOutcome: count((r) => r.outcome),
  byOutcomeAndType: count((r) => `${r.outcome} | ${r.ext}`),
  failedWhy: count((r) => (r.outcome === 'rebuild failed' ? r.detail : null)),
  refusedWhy: count((r) => (r.outcome === 'rebuild refused (unsafe)' ? r.detail.replace(/:.*/, '') : null)),
  sentToYouAndStillMissing: rows.filter((r) => r.sentToUser && !['rebuilt', 'copy found elsewhere'].includes(r.outcome)).length,
  rebuilt: rows.filter((r) => r.outcome === 'rebuilt').map((r) => r.file),
  rows,
};
delete report.failedWhy.null;
delete report.refusedWhy.null;
fs.writeFileSync(path.join(ARCHIVE, '_recovery-report.json'), JSON.stringify(report, null, 2));
const { rows: _omit, ...printed } = report;
console.log(JSON.stringify(printed, null, 2));
