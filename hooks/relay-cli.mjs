// `/relay` command implementation. Plain text out, Africa/Cairo times (owner rule).
//
//   node relay-cli.mjs status          both accounts, their windows, and which to switch to
//   node relay-cli.mjs limit           record that the CURRENT account just hit its limit
//   node relay-cli.mjs name <label>    give the current account a readable name
//   node relay-cli.mjs pickup [cwd]    print the handoff for a folder
//   node relay-cli.mjs accounts        raw ledger
import fs from 'node:fs';
import path from 'node:path';
import {
  BATONS,
  READY_RANK as RANK,
  WINDOW_MS,
  ago,
  cairo,
  clock,
  currentAccount,
  dur,
  label,
  labelOf,
  loadAccounts,
  pctOfObserved,
  projectSlug,
  readUsage,
  readiness,
  saveAccounts,
  tok,
  touchAccount,
  weekTotal,
} from './relay-lib.mjs';

const [, , cmd = 'status', ...rest] = process.argv;
const out = (s = '') => process.stdout.write(`${s}\n`);

const STATE_TEXT = {
  fresh: 'FRESH — no open window, full headroom',
  open: 'OPEN — window running, headroom left',
  hot: 'HOT — close to where this account limited before',
  limited: 'LIMITED — recorded limit hit, still cooling down',
};
function describe(uuid, db, isCurrent) {
  const r = readiness(uuid, db);
  const e = db.accounts[uuid] || {};
  const name = labelOf(uuid, db);
  const week = weekTotal(r.samples);
  const pct = pctOfObserved(r.win.total, e);

  const rows = [
    `${isCurrent ? '>' : ' '} ${name}  ${e.email || ''}${isCurrent ? '   <-- logged in now' : ''}`,
    `    ${STATE_TEXT[r.state]}`,
  ];
  if (r.win.start) {
    rows.push(
      `    5h window : ${tok(r.win.total)} tokens over ${r.win.turns} turns, opened ${clock(r.win.start)}` +
        (r.win.open
          ? `, resets ${clock(r.win.end)} (${dur(r.win.end - Date.now())} away)`
          : ` — expired, already reset`),
    );
  } else {
    rows.push('    5h window : nothing metered yet');
  }
  rows.push(`    last 7 days: ${tok(week)} tokens`);
  if (pct !== null) rows.push(`    ${pct}% of where this account hit its limit before (${tok(e.observedLimitTotal)})`);
  else rows.push('    no limit hit recorded yet, so there is no percentage to show');
  if (e.lastSeen) rows.push(`    last seen  : ${cairo(e.lastSeen)} (${ago(e.lastSeen)})`);
  return { rows, r, name };
}

function status() {
  const acct = currentAccount();
  const db = touchAccount(acct) ?? loadAccounts();
  const uuids = Object.keys(db.accounts || {});

  out('ACCOUNT RELAY');
  out('=============');
  out(`Now: ${cairo(Date.now())} Cairo`);
  out('');

  if (!uuids.length) {
    out('No accounts recorded yet.');
    out('Run this once while logged in on EACH account to register both.');
    return;
  }

  const described = uuids.map((u) => ({ uuid: u, ...describe(u, db, u === acct?.uuid) }));
  for (const d of described) {
    d.rows.forEach((r) => out(r));
    out('');
  }

  if (uuids.length === 1) {
    out('Only ONE account is registered. Log in with the other one and run /relay status there');
    out('so this can tell you which of the two has headroom.');
    out('');
  } else {
    const others = described
      .filter((d) => d.uuid !== acct?.uuid)
      .sort((a, b) => RANK[a.r.state] - RANK[b.r.state]);
    const best = others[0];
    if (best) {
      out(
        best.r.state === 'limited'
          ? `SWITCH TARGET: ${best.name} is still limited until ${clock(best.r.until)} Cairo (${dur(best.r.until - Date.now())} away).`
          : `SWITCH TARGET: ${best.name} — ${STATE_TEXT[best.r.state].split(' — ')[0]}.`,
      );
      out('');
    }
  }

  // Batons: what is mid-flight, and where.
  let batons = [];
  try {
    batons = fs
      .readdirSync(BATONS)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(BATONS, f), 'utf8')))
      .sort((a, b) => b.writtenAt - a.writtenAt);
  } catch {}

  if (batons.length) {
    out('WORK IN FLIGHT');
    out('--------------');
    for (const b of batons.slice(0, 6)) {
      out(`${path.basename(b.project.cwd)}  (${ago(b.writtenAt)}, by ${b.account?.label || '?'})`);
      if (b.git) out(`    branch ${b.git.branch} at ${b.git.head}`);
      if (b.nextStep) out(`    next: ${b.nextStep}`);
      out(`    pick up with: claude --resume ${b.session.id}`);
    }
    out('');
  }
  out('Switching accounts never loses history: transcripts are keyed by project folder,');
  out('not by account, so --resume works across a /login switch.');
}

function limit() {
  const acct = currentAccount();
  if (!acct) return out('Cannot read the current account from ~/.claude.json.');
  const db = touchAccount(acct);
  const samples = readUsage(acct.uuid);
  const r = readiness(acct.uuid, db);
  const now = Date.now();
  const windowStart = r.win.start ?? now;
  const windowEnd = windowStart + WINDOW_MS;

  const e = db.accounts[acct.uuid];
  e.limitHits = (e.limitHits || []).slice(-19);
  e.limitHits.push({ at: now, windowStart, windowEnd, total: r.win.total, turns: r.win.turns });
  // Calibrate on the LOWEST spend ever seen at a limit — the conservative estimate of the ceiling.
  if (r.win.total > 0)
    e.observedLimitTotal = e.observedLimitTotal
      ? Math.min(e.observedLimitTotal, r.win.total)
      : r.win.total;
  saveAccounts(db);

  out(`Recorded: ${label(acct, db)} hit its limit at ${cairo(now)} Cairo.`);
  out(`  window opened ${clock(windowStart)}, spend at the wall ${tok(r.win.total)} tokens over ${r.win.turns} turns`);
  out(`  this account is usable again at ${clock(windowEnd)} Cairo (${dur(windowEnd - now)} away)`);
  out(`  calibrated ceiling for future warnings: ${tok(e.observedLimitTotal)} tokens`);
  out('');

  const others = Object.keys(db.accounts)
    .filter((u) => u !== acct.uuid)
    .map((u) => ({ uuid: u, ...describe(u, db, false) }))
    .sort((a, b) => RANK[a.r.state] - RANK[b.r.state]);
  if (!others.length) {
    out('The other account is not registered yet — log in with it and run /relay status once.');
  } else {
    const best = others[0];
    out(`SWITCH TO: ${best.name} (${STATE_TEXT[best.r.state]})`);
    out('After /login, run /relay in the new session and it will hand you the work in flight.');
  }
  void samples;
}

function name(newLabel) {
  const acct = currentAccount();
  if (!acct) return out('Cannot read the current account.');
  if (!newLabel) return out('Usage: /relay name <label>');
  const db = touchAccount(acct);
  db.accounts[acct.uuid].label = newLabel;
  saveAccounts(db);
  out(`This account (${acct.email}) is now labelled "${newLabel}".`);
}

function pickup(cwd) {
  const file = path.join(BATONS, `${projectSlug(cwd || process.cwd())}.md`);
  try {
    out(fs.readFileSync(file, 'utf8'));
  } catch {
    out(`No handoff recorded for ${cwd || process.cwd()} yet.`);
    out('One is written automatically after the next reply in that folder.');
  }
}

try {
  if (cmd === 'status') status();
  else if (cmd === 'limit') limit();
  else if (cmd === 'name') name(rest.join(' ').trim());
  else if (cmd === 'pickup') pickup(rest.join(' ').trim());
  else if (cmd === 'accounts') out(JSON.stringify(loadAccounts(), null, 2));
  else out(`Unknown command "${cmd}". Use: status | limit | name <label> | pickup | accounts`);
} catch (err) {
  out(`relay failed: ${err?.message || err}`);
}
