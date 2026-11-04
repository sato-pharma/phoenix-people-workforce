#!/usr/bin/env node
// One-command account check. Run it in a NEW Code session right after switching accounts.
//
//   node ~/.claude/scripts/account-check.mjs
//
// It answers one question: does every local component agree about which account this
// session is running as? Reads only. Writes nothing. Never opens .credentials.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.USERPROFILE || os.homedir();
const R = await import(path.join(HOME, '.claude', 'hooks', 'relay-lib.mjs').replace(/\\/g, '/').replace(/^/, 'file:///'));

const cairo = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Cairo' });
const pad = (s) => String(s).padEnd(22);

const r = R.resolveCurrentClaudeAccount();
const cfg = R.fromConfig();

console.log('ACCOUNT CHECK');
console.log('=============');
console.log(`${pad('RESOLVED ACCOUNT')}: ${r.email ?? '(unknown)'}`);
console.log(`${pad('account id')}: ${r.accountId ?? '-'}`);
console.log(`${pad('org id')}: ${r.orgId ?? '-'}`);
console.log(`${pad('SOURCE')}: ${r.source}`);
console.log(`${pad('confidence')}: ${r.confidence}`);
console.log(`${pad('evidence')}: ${r.evidence}`);
console.log(`${pad('resolved at')}: ${cairo(r.timestamp)}`);
console.log();
console.log(`${pad('~/.claude.json says')}: ${cfg?.accountId ? (R.loadAccounts().accounts?.[cfg.accountId]?.email ?? cfg.accountId) : '(none)'}`);
console.log(
  `${pad('config agrees?')}: ${cfg?.accountId === r.accountId ? 'yes' : 'NO — and that is fine, it is ignored inside the app'}`,
);
console.log();

// Where the next usage record will actually land.
const usageFile = r.accountId
  ? path.join(HOME, '.claude', 'relay', 'usage', `${r.accountId}.ndjson`)
  : null;
let usageNote = 'nothing will be written — identity is UNKNOWN';
if (usageFile) {
  try {
    const st = fs.statSync(usageFile);
    usageNote = `${path.basename(usageFile).slice(0, 8)}...ndjson  (${st.size} bytes, last written ${cairo(st.mtimeMs)})`;
  } catch {
    usageNote = `${path.basename(usageFile).slice(0, 8)}...ndjson  (new file — first write pending)`;
  }
}
console.log(`${pad('telemetry goes to')}: ${usageNote}`);

// The baton is keyed by PROJECT, never by account — Phoenix continuity must not split.
const slug = R.projectSlug(process.cwd());
const batonFile = path.join(HOME, '.claude', 'relay', 'batons', `${slug}.json`);
let batonNote = 'none yet for this folder';
try {
  const b = JSON.parse(fs.readFileSync(batonFile, 'utf8'));
  batonNote = `${slug}  (account: ${b.account?.email ?? 'unknown'}, written ${cairo(b.writtenAt)})`;
} catch {
  /* no baton */
}
console.log(`${pad('baton (project-keyed)')}: ${batonNote}`);
console.log();

const ok = r.accountId && (r.confidence === 'high' || r.confidence === 'medium');
console.log(ok ? 'PASS — every component will attribute this session correctly.' : 'CHECK THIS — identity is weak or unknown; see confidence above.');
process.exit(ok ? 0 : 1);
