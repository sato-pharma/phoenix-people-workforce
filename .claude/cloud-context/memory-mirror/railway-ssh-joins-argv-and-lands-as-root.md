---
name: railway-ssh-joins-argv-and-lands-as-root
description: "railway ssh <cmd> silently mangles quoted commands, hangs on a GUI host-key dialog, lands as root not the app user, and needs a key registered with Railway (none on 2026-09-16) — railway logs --dns/--network answer egress questions read-only"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e8179fb6-f234-45e9-83b3-ba674f03c4ab
  modified: 2026-09-15T22:44:32.563Z
---

Running a command inside the live Railway container has three traps, all silent. Verified against
production `phoenix-people-workforce` on 2026-08-22.

**1. It joins argv with spaces and hands the result to one remote shell.** Your local shell strips
one layer of quotes, then Railway flattens what is left. So `railway ssh ... sh -c 'a; b; c'`
arrives as `sh -c a; b; c` — `sh -c` takes only `a`, and `b; c` run in the outer shell. The failure
is **silent and exit 0**: you get partial output and no error. Symptoms seen: `node --version`
printed nothing (`sh -c node` ran node with no script, read EOF, exited); `echo $B64 | base64 -d >
/tmp/p.js` wrote an **empty** file, so the probe "ran" and printed nothing.

**Pass the whole remote command as ONE local argument**, with the quotes the remote shell needs
written literally inside it:

```bash
railway ssh -e production -s <svc> "cd /app; node -e 'CODE_WITH_NO_QUOTES' 2>&1"
```

Keep the JS quote-free (`require(process.env.M)` with `M=sharp` set inline) so neither quoting layer
can eat it. For a nested `su`, escape the inner double quotes: `"su -s /bin/sh nextjs -c \"...\""`.

**2. First connection hangs forever on a GUI dialog you cannot see.** With no TTY, `ssh` falls back
to Git for Windows' askpass and pops a *Windows* window asking to accept the host key. The terminal
shows only `Using SSH key from file ...` and waits. Fix: pin the key first
(`ssh-keyscan -t ed25519 ssh.railway.com >> ~/.ssh/known_hosts`) and export
`SSH_ASKPASS_REQUIRE=never` so a future prompt errors instead of hanging. Railway does **not**
publish its host-key fingerprint in its docs — corroborate out of band before pinning.

**3. The session lands as `root`, not the app user.** `id` → `uid=0(root)`. Any "it works" proved
this way is worthless for a permissions question — the server runs as `nextjs` (uid 1001, gid 65533
nogroup). Use `su -s /bin/sh nextjs -c ...`; the account's shell is `/bin/false` so `-s` is required,
and `su` resets `PATH`, so call node by absolute path `/usr/local/bin/node`.

**And `su` keeps the caller's cwd (`/app`)** — which is why a `NODE_PATH=/nonexistent` negative
control still *passed*: node resolved `sharp` by walking up from `/app`. A control has to `cd /tmp`
first to be real. See [[prove-it-fails-verify-which-assertion-fired]].

`ps` in this session sees no application processes — different PID namespace. The filesystem is
shared, so file checks are valid; process checks are not. Read the running commit from
`printenv RAILWAY_GIT_COMMIT_SHA` inside the container, or `/api/healthz`.

**It needs a key registered with Railway, and on 2026-09-16 the account had none**
(`railway ssh keys list` → "No SSH keys registered with Railway."). Registering one
(`railway ssh keys add`) changes account settings, so ask the owner first. For a read-only egress
question, such as whether an outside host is reachable from production, the logs answer without a
shell: `railway logs --dns --filter "@qname:<host>" --json` gives each lookup and its `rcode`, and
`railway logs --network --filter "@dst:<address>" --json` gives each flow's `byteCount`,
`packetCount` and `dropCause`. A filter on `@host:` answers "Problem processing request"; use the
address from the DNS answer. The logs never show an HTTP status: a Google Calendar fetch on
2026-09-16 read as about 9 KB within a second, then a 132-byte close about 4 s after it.

Related: [[next-standalone-trace-misses-a-native-librarys-so-dependency]],
[[sharp-is-a-devdependency-that-two-production-paths-import]].
