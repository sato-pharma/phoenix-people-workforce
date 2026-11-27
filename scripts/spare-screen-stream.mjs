#!/usr/bin/env node
// Streams ~/.claude/logs/spare-screen-mirror.log (written by hooks/spare-screen-mirror.mjs) to the spare laptop, where
// the viewer on its screen (tty8, Alt+F8, "PHOENIX ADMINISTRATOR - live console") shows it. Owner, 2026-11-27:
// "the coding i do here in claude code desktop app appears on spares screen".
// Runs for ever from the task "Phoenix Spare Screen Mirror" (at logon, windowless: conhost --headless node <this>).
//  - ONE ssh connection ("cat >> ~/phoenix/admin-live.log"); new lines are sent every 0.5 s.
//  - Spare away (home/work Wi-Fi change, asleep): retries every 30 s; what was written while away is skipped, so
//    the screen never floods with an old backlog when it comes back.
//  - The local log is emptied once it passes 5 MB and everything was sent; the spare keeps its last 3,000 lines.
//  - Single instance (a lock port, 127.0.0.1:47391). Its own log: ~/.claude/logs/spare-screen-stream.log
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync, truncateSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const SRC = join(HOME, '.claude', 'logs', 'spare-screen-mirror.log');
const OWN = join(HOME, '.claude', 'logs', 'spare-screen-stream.log');
const KEY = join(HOME, '.ssh', 'phoenix_spare_ed25519');
const say = (m) => { try { appendFileSync(OWN, `${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })} ${m}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spareAddress() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-File', join(HOME, '.claude', 'scripts', 'spare-address.ps1')],
      { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/).pop();
  } catch (e) { return ''; } // exit 1 = not found
}

function spareUser() {
  try { return readFileSync(join(HOME, '.claude', 'scripts', 'spare-user.txt'), 'utf8').trim().split(/\s+/)[0] || 'phoenix'; } catch { return 'phoenix'; }
}

const lock = createServer();
lock.once('error', () => { process.exit(0); }); // another copy runs
lock.listen(47391, '127.0.0.1', run);

async function run() {
  if (!existsSync(SRC)) writeFileSync(SRC, '');
  say('stream started');
  const user = spareUser();
  for (;;) {
    const addr = spareAddress();
    if (!addr || !/^\d+\.\d+\.\d+\.\d+$/.test(addr)) { await sleep(30000); continue; }
    const remote = 'L=$HOME/phoenix/admin-live.log; touch $L; n=$(wc -l < $L); if [ "$n" -gt 3000 ]; then tail -n 2000 $L > $L.tmp && mv $L.tmp $L; fi; exec cat >> $L';
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'LogLevel=ERROR', ...(existsSync(KEY) ? ['-i', KEY] : []), `${user}@${addr}`, remote];
    const ssh = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    let alive = true;
    ssh.on('exit', () => { alive = false; });
    ssh.stdin.on('error', () => { alive = false; });
    let pos = statSync(SRC).size; // skip what was written while the spare was away
    say(`connected to ${addr}`);
    while (alive) {
      let size = 0;
      try { size = statSync(SRC).size; } catch { writeFileSync(SRC, ''); }
      if (size < pos) pos = 0; // emptied
      if (size > pos) {
        const fd = openSync(SRC, 'r'); const buf = Buffer.alloc(Math.min(size - pos, 256 * 1024));
        const n = readSync(fd, buf, 0, buf.length, pos); closeSync(fd);
        pos += n; ssh.stdin.write(buf.subarray(0, n));
      } else if (size > 5e6) { try { truncateSync(SRC, 0); pos = 0; } catch {} }
      await sleep(500);
    }
    say(`connection to ${addr} ended; retrying in 30 s`);
    await sleep(30000);
  }
}
