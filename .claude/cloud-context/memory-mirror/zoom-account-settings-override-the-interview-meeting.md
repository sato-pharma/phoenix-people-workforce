---
name: zoom-account-settings-override-the-interview-meeting
description: "A Phoenix Zoom interview's per-meeting \"join before host / no waiting room\" is overridden by a locked Zoom account, group or host-user setting; the app cannot read or change those."
metadata:
  node_type: memory
  type: project
  originSessionId: f45b825a-a708-4c3d-859f-063af6d43b9b
  modified: 2026-11-15T15:05:47.382Z
---

On 15 Nov 2026, Phoenix interview meetings were created with `join_before_host: true`, `jbh_time: 0` and `waiting_room: false` (PR #448, live 16:08 Cairo). Zoom's API returned those settings on the 20:30 meeting, but someone who opened the link early was still held. The cause was the Zoom account's own settings, which override the meeting when locked. The owner changed them himself in the Zoom web portal (account settings, groups, and the host user's settings: Waiting Room off, Allow participants to join before host on, anytime, unlocked). He confirmed: "I changed the Zoom settings, the 20:30 link opens straight in".

**Why:** Phoenix's Zoom server-to-server app has no `user:read:settings` or `account:read:settings` scopes (Zoom answered 4711 on both). A correct `GET /meetings/{id}` therefore proves nothing about what a joiner sees.

**How to apply:** If a candidate waits again, do not touch `src/lib/zoom/meetings.ts` first. Hand him the three portal links (zoom.us/account/setting?tab=meeting, zoom.us/account/group/list, zoom.us/profile/setting?tab=meeting) to check that nothing was re-locked. Related: [[recruitment-interviews]].
