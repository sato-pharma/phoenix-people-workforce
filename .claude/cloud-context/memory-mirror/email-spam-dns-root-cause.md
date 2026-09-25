---
name: email-spam-dns-root-cause
description: "Phoenix emails go to spam (even same-domain @satopharma.com) because the sending domain mail.satopharma.com fails SPF+DKIM under a strict p=reject DMARC. Fix = verify a clean send.satopharma.com in Resend."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3c84680b-4af2-4a55-b109-ced9c75b0f43
---

**Symptom:** every Phoenix email lands in spam/junk, even to `@satopharma.com` recipients.

**Root cause (diagnosed via live DNS lookups, 2026-06-09):**
- Prod sends as `hr@mail.satopharma.com` (Resend, via Amazon SES).
- `mail.satopharma.com` is a **CNAME to `cpanel356.turbify.biz`** (Turbify/Yahoo webmail) with SPF `v=spf1 a mx ip4:172.203.250.63 include:relay.mailchannels.net -all` — authorizes MailChannels, **NOT Amazon SES** → SPF fails.
- `resend._domainkey.mail.satopharma.com` does **not exist** → DKIM fails.
- `_dmarc.satopharma.com` = `p=reject; sp=reject; pct=100; adkim=r; aspf=r` (Cloudflare-managed; rua → dmarc-reports.cloudflare.net) → auth failures are rejected/junked. Resend reports "delivered" because the receiver accepts-then-junks.
- Apex `satopharma.com` SPF = `v=spf1 include:amazonses.com include:_spf.mail.yahoo.com -all` (already trusts SES + Yahoo).

**Chosen fix (user picked):** verify a clean dedicated subdomain **`send.satopharma.com`** in Resend (NOT mail.satopharma.com — it's CNAME'd to Turbify and can't be cleanly fixed). Add Resend's 3 DKIM CNAMEs (DNS-only / grey cloud at Cloudflare) + SPF TXT + return-path MX, Verify in Resend, then set Vercel `NOTIFICATION_EMAIL_FROM=Phoenix Workforce <phoenix@send.satopharma.com>`. The strict DMARC then PASSES (DKIM aligned) → inbox. No DMARC change needed.

**My role:** I can't log into Resend/Cloudflare/Vercel or change DNS (credential + security-setting limits) — I verify DNS propagation live via Resolve-DnsName as the user adds records, and confirm received headers show spf/dkim/dmarc=pass after the test send. See docs/email-deliverability-and-rollout.md.
