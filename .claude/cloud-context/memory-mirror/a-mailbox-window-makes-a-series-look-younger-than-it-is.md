---
name: a-mailbox-window-makes-a-series-look-younger-than-it-is
description: the monthly closing series looked like it began April 2025 because omar.anwar's INBOX is a rolling 10,000-message window; the CEO mailbox Sent folder holds the real series back to July 2020 and sell-out data back to June 2015 — date a business series from the deepest mailbox, never the one you happen to be reading
metadata:
  type: project
---

**Measured 13 Oct 2026.** `omar.anwar@satopharma.com` keeps a **rolling 10,000-message INBOX that
stops at ~Jan 2024**, and 2021–2023 survives in **Sent only**. Reading it alone dated the monthly
sales closing series to **April 2025** and the oldest sales data to **May 2023** — both wrong, both
artifacts of the window.

`anwar.gaweesh@satopharma.com` (the CEO) keeps **9,246 Sent messages back to 15 June 2015** — its
INBOX is also a window (49,329 messages reaching only to Jan 2026), so **Sent is the deep archive in
both mailboxes.** From it: sell-out data from **6 June 2015** (Pharma Overseas), invoice-level
Egydrug sell-out for **January 2016** (70 files, 67,470 invoice lines), the first quarterly target
**2 Jan 2018**, the first monthly **"Closing" 11 Aug 2020** ("UCP Ph 7-2020 Closing Line1" — the CEO
answered "ok proceed"), and closings **by line** from **Sep 2021**; "Fighters" by name from April 2022.

**Why:** a mailbox's retention window is invisible in search results — a series simply has no older
rows, which reads exactly like a series that did not exist yet. Three audits of one mailbox agreed
with each other and were all wrong together.

**How to apply:** before dating any business series from mail, check how far the folder actually
reaches (oldest message by sequence 1, not by search), and check **Sent** rather than INBOX. Then
check the mailbox of whoever **received** the series, not whoever discusses it.

Two reader notes that cost time: the MCP mailbox bridge reads `MAILBOX_MCP_USER`/`PASSWORD` **once at
Claude Code startup**, so editing `.env.local` does not re-point it until a restart — a standalone
node script using the repo's `imapflow` reads the new mailbox immediately **and** escapes the MCP
search tool's 100-result cap. And a distributor price column can be corrupt on a fraction of rows
(0.11% here, max 829,584 against a median of 39.60): summing it blindly returned 48 billion EGP, so
value a month at each product's **median** invoice price and say it is an estimate.

Related: [[sos-monthly-closing-is-the-only-sales-truth]], [[verify-the-emitted-artifact-never-the-source]].
