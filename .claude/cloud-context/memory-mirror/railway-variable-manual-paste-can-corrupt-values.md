---
name: railway-variable-manual-paste-can-corrupt-values
description: "A manual multi-line Railway variable paste can silently glue one KEY=VALUE onto the end of the previous variable's value; nothing in the repo's own tooling catches it."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7e239d18-ce53-4fcf-87e3-26a49b58f76b
  modified: 2026-08-09T08:59:07.673Z
---

**RESOLVED — re-verified live 2026-08-09.** Both variables are now clean on Railway production:
`CLOUDFLARE_API_TOKEN` is 53 chars and `NOTIFICATION_WEBHOOK_SECRET` 43 chars, neither containing a
newline, space, `=` or any embedded `[A-Z_]+=` fragment. The Cloudflare token was additionally
checked functionally against `GET /client/v4/user/tokens/verify` — `success=true`,
`status=active`. So do NOT "fix" these again; there is nothing to repair, and the memory below is
kept for the detection technique and the still-open password rotation.

**Still open from this incident:** the Supabase pooler DB password was sitting inside the corrupted
`CLOUDFLARE_API_TOKEN` value. Cleaning the variable does not un-expose it — rotate that password if
it has not been done.

Discovered 2026-08-08 during a full secrets/env audit, unresolved as of that date. Two Railway
production variables on `phoenix-people-workforce` hold corrupted values: `CLOUDFLARE_API_TOKEN`'s
value runs straight into `SUPABASE_DB_URL=postgresql://postgres.ozucdzovmcqvepbozvqf:<password>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`
with zero separator, and `NOTIFICATION_WEBHOOK_SECRET`'s value runs straight into
`IREPORTS360_BASE_URL=https://hmaxhmax-001-site7.rtempurl.com`. Both `SUPABASE_DB_URL` and
`IREPORTS360_BASE_URL` already exist correctly as their OWN separate Railway variables elsewhere —
this isn't a missing variable, it's stray text glued onto an unrelated one, consistent with a
multi-line paste losing a newline during a manual `railway variable set` / clipboard operation.
`CLOUDFLARE_API_TOKEN` isn't touched by `scripts/sync-railway-production-secrets.mjs` at all (not in
its variable list), so its corruption is Railway-only. `NOTIFICATION_WEBHOOK_SECRET` IS in that
script's list — if the corruption actually lives in the GitHub secret of the same name (not
verifiable, `gh secret list` never reveals values), the next sync run will keep re-applying it.
Six other secrets were rotated the same evening (Aug 7, ~18:00 Cairo: RESEND_API_KEY,
RESEND_WEBHOOK_SECRET, OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, ONESIGNAL_REST_API_KEY, RAILWAY_TOKEN,
plus CLOUDFLARE_API_TOKEN and NOTIFICATION_WEBHOOK_SECRET themselves) — that rotation session is the
likely moment of corruption.

**Why:** `scripts/validate-railway-production-secrets.mjs` only checks that required variables are
non-empty, plus a handful of shape/regex checks on exactly 4 variable names (`APP_URL`,
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`/
`SUPABASE_SERVICE_ROLE_KEY` length). A corrupted-but-non-empty value sails through undetected, and
`CLOUDFLARE_API_TOKEN` isn't even in its checklist. Gitleaks (`security-scan.yml`, restored
2026-08-08) can't catch this either — it scans the git tree, not Railway's variable store; the two
systems have no overlap.

**Blast radius so far is those two.** Checked 2026-08-08 (later that evening): `OPENAI_API_KEY`,
rotated in the same Aug 7 session, is **intact** — 164 chars, matches `^sk-[A-Za-z0-9_-]+$`, no
embedded `KEY=`. A safe way to check any variable without printing the secret:

```
railway variables --kv | grep "^NAME=" | sed 's/^NAME=//' | awk '{ printf "length=%d well_formed=%s has_stray_KEY=%s\n", length($0), ($0 ~ /^sk-[A-Za-z0-9_-]+$/ ? "yes" : "NO"), ($0 ~ /[A-Z_]+=/ ? "YES-CORRUPT" : "no") }'
```

**How to apply:** Don't trust "the variable exists and validate-railway-production-secrets.mjs is
green" as proof Railway env is healthy. Periodically run `railway variables` and actually read
values for anything that looks longer than its type should be (a webhook secret or API token should
be one short opaque string, not something that wraps across 4+ lines in the CLI table). If asked to
fix this: re-set both variables directly on Railway to their correct standalone value, check whether
the GitHub secret `NOTIFICATION_WEBHOOK_SECRET` is itself the corrupted source before assuming a
Railway-only fix will stick, and rotate the exposed pooler DB password since it sat somewhere it
shouldn't have.
