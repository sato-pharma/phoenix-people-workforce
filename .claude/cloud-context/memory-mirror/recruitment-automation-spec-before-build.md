---
name: recruitment-automation-spec-before-build
description: "Recruitment cycle automation, owner answers 2026-10-16 — seat empties → requisition auto-OPENS (no approval, owner Yomna Gamal HR-011, hiring manager = seat manager, parked seats skipped, no notice); seat filled/cancelled → requisition auto-closes; every CV screened+matched with ATTACH or KEEP only (NEVER recommend reject); area from WhatsApp screening answers first, CV governorate fallback; one-click Attach/Keep/Reject for Super Admin and Talent Acquisition only."
metadata:
  node_type: memory
  type: project
  originSessionId: 45481b57-a4b4-49ee-ab85-bb409924b3f5
  modified: 2026-10-16T01:39:25.957Z
---

Owner's answers, 2026-10-16 ~04:45–05:00 Cairo ("i want all this process to be automated opening requistion and th end end cycle i dont want manual work in the recruitment").

- **Opening:** a seat that becomes empty (any door: resignation, declined offer, new organogram seat) raises AND opens its requisition at once. **No approval at all.** Backfill the ~35 empty seats with no requisition. Parked seats (Cairo Pedia DM+reps; Anti Infective Menoufia 1) always skipped.
- **Owner of an auto-opened requisition:** Yomna Gamal (HR-011, Talent Acquisition). Hiring manager = the seat's manager.
- **No notice** when a requisition opens itself — her notification center stays at three notices.
- **Closing:** seat filled → requisition `req_filled`; seat cancelled → `req_cancelled`. Backfill the 3 open requisitions on filled seats.
- **Screening:** system screens + matches every CV to an open requisition and RECOMMENDS **Attach** or **Keep shortlisted** only — **never recommend Reject** (his answer). Reject stays a human click.
- **Area source:** primary = the WhatsApp screening answers (preferred area/region); fallback = governorate from the CV.
- **Decision:** one click — Attach to requisition / Keep shortlisted / Reject — by **Admin (Super Admin) or Talent Acquisition** only. A rejection sends no notice (standing rule).
- Not in scope unless he asks: auto-drafted/sent offers, candidate self-booking of interviews.

**Why:** he wants no manual work in recruitment, but every decision about a person stays a human click.
**How to apply:** build as ONE PR; migrations staging then production, bulk backfills announced with a pre-image. Related: [[talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day]], [[a-dm-never-receives-a-dm-cv]].
