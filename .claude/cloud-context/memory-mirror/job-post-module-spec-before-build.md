---
name: job-post-module-spec-before-build
description: "The job-post image module (recruitment, Super Admin + Talent Acquisition) as the owner specified it on 2026-10-15, before any code: title picker, saved duties/needs per title, 5 rendered templates, multi-area posts where one area = one rep, download = all-areas image AND one image per area, line name optional."
metadata:
  node_type: memory
  type: project
  originSessionId: dfa82d4c-dd68-4121-80ac-a345740c658c
  modified: 2026-10-15T19:27:58.361Z
---

On 2026-10-15 the owner asked for a recruitment module in which:
- He or Talent Acquisition picks a job title or adds a new one.
- They write "What you will do" and "What you need"; both are saved per title.
- They choose a template and download the job-post image.

The candidate templates were rendered before any build. They are in `F:\Hiring Posts\2026-10-15 Job Post Templates\`: Executive (the approved v7 look), Split, Editorial, Bold Blue and Night Blueprint. `build-templates.mjs` there renders all five from a single set of fields. Building waits until he picks templates.

His answers for multi-area posts (e.g. a Medical Rep post for Heliopolis, Nasr City and Cairo East):
- **One area is always one rep.** Never show a count per area.
- **Download gives BOTH** the all-areas image and a separate image per area.
- **The line name (CNS, Anti Infective, Pedia) is optional to show.**

**Why:** these answers decide the data model (areas are a plain list, no headcount) and the export (N+1 images).

**How to apply:**
- Build the data model and the export from these answers. Do not ask him them again.
- A long title must auto-shrink to fit its box; "Representative" clipped in Split before the fix.
- The Medical Rep duties in the samples were placeholder wording. Only the requirements are his own, from the 2026-09-25 vacancy.

Related: [[hiring-post-hr-section-head-is-a-leadership-seat]]
