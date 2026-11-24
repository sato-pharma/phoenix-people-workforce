---
name: zoom-account-settings-override-the-interview-meeting
description: "A Phoenix Zoom interview's per-meeting \"join before host / no waiting room\" is overridden by a locked Zoom account, group or host-user setting; the app cannot read or change those."
metadata:
  node_type: memory
  type: project
  originSessionId: f45b825a-a708-4c3d-859f-063af6d43b9b
  modified: 2026-11-24T17:30:00.000Z
---

On 15 Nov 2026, Phoenix interview meetings were created with `join_before_host: true`, `jbh_time: 0` and `waiting_room: false` (PR #448, live 16:08 Cairo). Zoom's API returned those settings on the 20:30 meeting, but someone who opened the link early was still held. The cause was the Zoom account's own settings, which override the meeting when locked. The owner changed them himself in the Zoom web portal (account settings, groups, and the host user's settings: Waiting Room off, Allow participants to join before host on, anytime, unlocked). He confirmed: "I changed the Zoom settings, the 20:30 link opens straight in".

**Why:** Phoenix's Zoom server-to-server app has no `user:read:settings` or `account:read:settings` scopes (Zoom answered 4711 on both). A correct `GET /meetings/{id}` therefore proves nothing about what a joiner sees.

**How to apply:** If a candidate waits again, do not touch `src/lib/zoom/meetings.ts` first. Hand him the three portal links (zoom.us/account/setting?tab=meeting, zoom.us/account/group/list, zoom.us/profile/setting?tab=meeting) to check that nothing was re-locked. Related: [[recruitment-interviews]].

**24 Nov 2026 — it came back, and the real cause was the passcode.** Every interview meeting was stored with `waiting_room: true` although Phoenix sent false. The Zoom account forces "Require that all meetings are secured with one security option" (on and greyed out, it cannot be switched off). Account "Meeting Passcode" was OFF and LOCKED, so no meeting had a passcode (no interview link held `pwd=`). Zoom then turned the waiting room on by itself as the one security option. A `password` sent in the API body was silently dropped while that setting was locked off. Fix (owner chose "You do it in my Chrome"): account settings → Security → Meeting Passcode ON (locked), with "Require a passcode for meetings which have already been scheduled" UNTICKED, because ticking it would break every link already sent. "Embed passcode in invite link for one-click join" was already on. Proven on a throwaway meeting: `waiting_room: false`, the link carries `pwd=`, and a move keeps the same link. No code change was needed.

**How to apply:** if the waiting room returns, first check that Meeting Passcode is still ON at zoom.us/account/setting?tab=meeting, then read `settings.waiting_room` and `password` on a meeting through the API (`railway run`, production service).
