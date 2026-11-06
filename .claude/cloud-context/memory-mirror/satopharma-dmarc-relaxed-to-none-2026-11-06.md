---
name: satopharma-dmarc-relaxed-to-none-2026-11-06
description: "2026-11-06 company-wide \"every @satopharma.com email goes to junk\" — authentication PASSES (spf/dkim/dmarc=pass on junked mail); root cause is Phoenix's automated volume under satopharma.com names at Yahoo. DMARC was relaxed then RESTORED to p=reject the same day."
metadata:
  node_type: memory
  type: project
  originSessionId: 1b93efe4-6dbf-4308-8434-eb5bc83517ba
  modified: 2026-11-06T11:32:37.353Z
---

**Symptom (owner, 2026-11-06):** the whole company says every @satopharma.com email, sent or received, lands in junk.

**Proven from his own mailbox's headers** (read-only IMAP via `MAILBOX_MCP_*` in `.env.local` = omar.anwar@satopharma.com; scripts were in the session scratchpad):
- Junked colleague mail shows `spf=pass dkim=pass(d=yahoo.com s=s2048) dmarc=pass`, so **authentication is NOT the cause**. Turbify signs DKIM with d=yahoo.com, so it is never aligned; DMARC passes on SPF.
- Bulk held 751 messages (Yahoo keeps 30 days): 655 from Phoenix sending names (send2 315, send3 170, send4 104, people 38, sales 28). 609 arrived in the week of 10–16 Oct, when send2/3/4 Resend accounts were added to dodge free daily limits.
- Share of colleague (apex) mail junked by week: 3 Oct 1%, 10 Oct 4%, 17 Oct 10%, 24 Oct 6%, 31 Oct 14%.
- Production `email_delivery_events`, last 35 days: 8,124 sent, of which 8,030 went to @satopharma.com mailboxes. Apex-From job offers (`HR@satopharma.com` via Resend/SES): 112 sent, 0 opens.
- Outside replies quoting Sato threads are junked too.

**DNS:** relaxed to p=none / ~all at ~13:10 Cairo on a wrong theory, then RESTORED to `p=reject; sp=reject ... ` and `-all` the same day. The satopharma.com zone is in Cloudflare account **"Achieverrr303@gmail.com's Account"**, not the Pharos account his Chrome uses. The repo `CLOUDFLARE_API_TOKEN` can edit DNS but cannot read DMARC analytics.

**Owner decisions 2026-11-06:**
- Keep all three channels (email, Telegram, in-app).
- Do NOT pay for an extra domain.
- Job offers go through the real hr@ Turbify mailbox (env `JOB_OFFER_SMTP_APP_PASSWORD`; he must create the app password inside hr@).
- Strict DMARC restored.
- Stop the standing admin BCC; the Telegram mirror stays. Ships in the same PR as the offers change.
- One paid sending account (Resend Pro, ~$20/mo) to replace the free accounts taking turns: DEFERRED. His words: "maybe next month this month i have no money". Raise it again in December 2026, not before.

**How to apply:** never "fix" this with DNS again. The levers are Phoenix's sending pattern (fewer, steadier senders; apex From only through Turbify itself) and reputation recovery. See [[email-spam-dns-root-cause]] and [[turbify-cannot-issue-app-passwords-centrally-owner-stays]].
