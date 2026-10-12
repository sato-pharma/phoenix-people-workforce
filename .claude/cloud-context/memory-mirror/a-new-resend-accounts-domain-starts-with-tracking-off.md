---
name: a-new-resend-accounts-domain-starts-with-tracking-off
description: "Resend open/click tracking is off by default per domain and a PATCH of open_tracking/click_tracking answers 200 and changes NOTHING without a tracking_subdomain + a verified CNAME — send2/send3 read 0 opens of 98 delivered against 46% on send until fixed 2026-10-10 (links.send2 / links.send3 CNAME to links2.resend-dns.com, DNS only, in Cloudflare)."
metadata:
  node_type: memory
  type: project
  originSessionId: 4e0278e4-9f54-4765-978c-d781ac70eb31
  modified: 2026-10-10T17:33:36.293Z
---

Measured 2026-10-10 (Cairo), last 3 days, distinct Resend messages: `send.satopharma.com` 200 delivered / 91 opened (46%); `send2` 81 delivered / 0 opened; `send3` 17 delivered / 0 opened. Tracking is a per-DOMAIN setting inside each Resend account, off by default, and a delivered message with tracking off can never produce an `opened` event — a blind spot, not proof nobody read it.

**The trap:** `PATCH /domains/<id>` with only `open_tracking`/`click_tracking` returns 200 and the read-back stays false. Resend applies the flags only when a `tracking_subdomain` is configured AND its Tracking CNAME is verified. The working sequence (done 2026-10-10 for send2 and send3): PATCH `{tracking_subdomain:"links", open_tracking:true, click_tracking:true}`, add the returned Tracking CNAME in Cloudflare as **DNS only** (`links.send2` and `links.send3` -> `links2.resend-dns.com`), `POST /domains/<id>/verify`, read back. The domain briefly shows `partially_verified` (DKIM/SPF re-checking) for about two minutes and settles to `verified`; sending stayed enabled throughout. A tracking subdomain can be changed but never removed.

**DNS:** satopharma.com is on Cloudflare (ainsley/jacob). A zone-scoped Edit-DNS token lives in the primary's `.env.local` as `CLOUDFLARE_API_TOKEN` (added by him 2026-10-10); read it from the file in a script, never print it.

**Why it matters:** the failover chain (`resend → resend-2 → resend-3 → brevo`, `src/lib/email/email-providers.ts`) hands a message down on `reached_daily_quota` (Resend accepts with a 200, then marks it failed), so by late afternoon accounts 2 and 3 carry most of the mail. When a further Resend account is added, do the full sequence the same day. Read domain settings with `railway run --service phoenix-people-workforce --environment production node <script>`, never by printing a key. Only mail sent after 2026-10-10 can show opens; whether the old 0% was spam or just no tracking is answered by the next day's open rate.

Related: [[resend-daily-100-cap-429-outage]]
