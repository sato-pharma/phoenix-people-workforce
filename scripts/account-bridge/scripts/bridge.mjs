#!/usr/bin/env node
// account-bridge: make the owner's two accounts see the same chats, memory and access.
//   node bridge.mjs status
//   node bridge.mjs sync [--apply] [--chat <text>] [--newer] [--from oag|phx]
// Dry run unless --apply. Copies only; never deletes, never overwrites without --newer (and then backs up).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const HOME = os.homedir()
const SESS = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions')
const PKG = path.join(process.env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')
const LABELS = { oag: 'oagaweesh', phx: 'phoenixx.oag' }
const args = process.argv.slice(2)
const cmd = args[0] || 'status'
const flag = (n) => args.includes(n)
const opt = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : null }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const cairo = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false })

function accounts() {
  const reg = readJson(path.join(HOME, '.claude', 'relay', 'accounts.json')).accounts
  const out = {}
  for (const [key, needle] of Object.entries(LABELS)) {
    const hit = Object.entries(reg).find(([, v]) => (v.email || '').startsWith(needle))
    if (!hit) throw new Error(`account ${key} (${needle}) not in relay/accounts.json`)
    const uuid = hit[0]
    const base = path.join(SESS, uuid)
    const orgs = fs.existsSync(base) ? fs.readdirSync(base).map((o) => ({ o, n: fs.readdirSync(path.join(base, o)).length })) : []
    orgs.sort((a, b) => b.n - a.n)
    if (!orgs.length) throw new Error(`no session folder for ${key}`)
    out[key] = { key, email: hit[1].email, uuid, org: orgs[0].o, dir: path.join(base, orgs[0].o), pkgDir: path.join(PKG, uuid, orgs[0].o) }
  }
  return out
}

function records(dir) {
  const m = new Map()
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('local_') || !f.endsWith('.json')) continue
    try { m.set(f, readJson(path.join(dir, f))) } catch { /* unreadable record: skipped, counted below */ }
  }
  return m
}

const transcriptIds = (() => {
  const s = new Set(); const root = path.join(HOME, '.claude', 'projects')
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d); if (!fs.statSync(p).isDirectory()) continue
    for (const f of fs.readdirSync(p)) if (f.endsWith('.jsonl')) s.add(f.slice(0, -6))
  }
  return s
})()

function plan(A, B, ra, rb) {
  const chat = (opt('--chat') || '').toLowerCase()
  const want = ([f, r]) => !chat || f.toLowerCase().includes(chat) || (r.cliSessionId || '').includes(chat) || (r.title || '').toLowerCase().includes(chat)
  const jobs = []
  for (const [from, to, rf, rt] of [[A, B, ra, rb], [B, A, rb, ra]]) {
    if (opt('--from') && opt('--from') !== from.key) continue
    for (const e of rf) {
      if (!want(e)) continue
      const [f, r] = e
      const t = rt.get(f)
      if (!t) jobs.push({ from, to, f, r, kind: 'missing' })
      else if (flag('--newer') && (r.lastActivityAt || 0) > (t.lastActivityAt || 0)) jobs.push({ from, to, f, r, kind: 'newer' })
    }
  }
  return jobs
}

function status(A, B, ra, rb) {
  console.log('CHATS (desktop sidebar records, main org of each account)')
  for (const a of [A, B]) {
    const r = a.key === 'oag' ? ra : rb
    const live = [...r.values()]
    console.log(`  ${a.key.toUpperCase()} ${a.email}\n    ${a.dir}\n    ${r.size} records, ${live.filter((x) => !x.isArchived).length} active, newest ${cairo(Math.max(...live.map((x) => x.lastActivityAt || 0)))} Cairo`)
  }
  const jobs = plan(A, B, ra, rb)
  const miss = (to) => jobs.filter((j) => j.to.key === to && j.kind === 'missing').length
  console.log(`  missing on OAG: ${miss('oag')}   missing on PHX: ${miss('phx')}`)
  const both = [...ra.keys()].filter((f) => rb.has(f))
  console.log(`  shared by both: ${both.length}`)
  const lacking = jobs.filter((j) => j.kind === 'missing' && j.r.cliSessionId && !transcriptIds.has(j.r.cliSessionId)).length
  console.log(`  of the missing, transcript not on this disk: ${lacking}`)
  console.log('\nMEMORY (one store for both accounts)')
  const mem = path.join(HOME, '.claude', 'projects'); let notes = 0
  for (const d of fs.readdirSync(mem)) { const m = path.join(mem, d, 'memory'); if (fs.existsSync(m)) notes += fs.readdirSync(m).filter((x) => x.endsWith('.md')).length }
  console.log(`  ${notes} memory notes under ${mem}\<project>\memory — keyed by project folder, so both accounts read the same files`)
  console.log(`  ${transcriptIds.size} conversation transcripts under ${mem}\<project>\*.jsonl — also project-keyed`)
  console.log('\nACCESS')
  const cj = readJson(path.join(HOME, '.claude.json'))
  console.log(`  live account now: ${cj.oauthAccount?.emailAddress} — /login swaps only the token; settings.json, hooks, permissions and local MCP servers (${Object.keys(cj.mcpServers || {}).join(', ') || 'none'}) are one file for both`)
  const gone = (r) => [...r.values()].filter((x) => x.cwd && !fs.existsSync(x.cwd)).length
  console.log(`  records whose folder no longer exists (chat opens, folder missing): OAG ${gone(ra)}, PHX ${gone(rb)}`)
  console.log('  server-side, cannot be copied: claude.ai connectors (UUID-named MCP servers), extra usage / fast mode, usage window — reconnect per account at claude.ai')
}

function applyJobs(jobs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(HOME, '.claude', 'backups', 'account-bridge', stamp)
  let ok = 0, bad = 0
  for (const j of jobs) {
    const src = path.join(j.from.dir, j.f), dst = path.join(j.to.dir, j.f), tmp = dst + '.bridge-tmp'
    if (j.kind === 'newer') { fs.mkdirSync(bak, { recursive: true }); fs.copyFileSync(dst, path.join(bak, `${j.to.key}__${j.f}`)) }
    fs.copyFileSync(src, tmp); fs.renameSync(tmp, dst)
    const st = fs.statSync(src); fs.utimesSync(dst, st.atime, st.mtime)
    const pk = path.join(j.to.pkgDir, j.f)
    if (sha(src) === sha(dst) && (!fs.existsSync(path.join(j.to.pkgDir)) || (fs.existsSync(pk) && sha(pk) === sha(src)))) ok++
    else { bad++; console.log(`  MISMATCH ${j.f}`) }
  }
  const log = path.join(HOME, '.claude', 'logs', 'account-bridge.log')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.appendFileSync(log, `${new Date().toISOString()} copied=${ok} mismatched=${bad} jobs=${jobs.map((j) => `${j.from.key}>${j.to.key}:${j.f}`).join(',').slice(0, 4000)}\n`)
  return { ok, bad, bak }
}

const acc = accounts()
const ra = records(acc.oag.dir), rb = records(acc.phx.dir)
if (cmd === 'status') status(acc.oag, acc.phx, ra, rb)
else if (cmd === 'sync') {
  const jobs = plan(acc.oag, acc.phx, ra, rb)
  const by = (k, f, t) => jobs.filter((j) => j.kind === k && j.from.key === f && j.to.key === t).length
  console.log(`plan: copy ${by('missing', 'oag', 'phx')} OAG->PHX, ${by('missing', 'phx', 'oag')} PHX->OAG; replace-with-newer ${jobs.filter((j) => j.kind === 'newer').length}`)
  if (jobs.length <= 12) for (const j of jobs) console.log(`  ${j.kind} ${j.from.key}->${j.to.key} ${j.f} "${j.r.title}"`)
  if (!flag('--apply')) console.log('dry run - add --apply to write')
  else {
    const r = applyJobs(jobs)
    console.log(`copied and hash-verified (roaming + packaged view): ${r.ok}, mismatched: ${r.bad}${fs.existsSync(r.bak) ? `, replaced originals saved in ${r.bak}` : ''}`)
    console.log('The desktop app reads its list at start-up: a chat appears in the other account after that account window is reopened.')
    process.exitCode = r.bad ? 1 : 0
  }
} else { console.error('usage: bridge.mjs status | sync [--apply] [--chat <text>] [--newer] [--from oag|phx]'); process.exitCode = 2 }
