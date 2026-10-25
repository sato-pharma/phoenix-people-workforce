/**
 * HOW LONG A BROWSER MAY KEEP A PRIVATE FILE (cache audit, 2026-10-26).
 *
 * Supabase Storage answers a download with `Cache-Control: max-age=<this>`, the value given at upload.
 * Sick notes, leave attachments, hiring documents, car evidence and marketing evidence photos are
 * private files, opened through signed links that live five minutes; they were uploaded with one year
 * (31536000), so a shared phone or office PC kept a copy of someone else's document in its browser
 * cache for a year after the link had expired. Five minutes is the signed link's own life: no browser
 * needs a private file longer than the link that opened it.
 *
 * Supabase takes a number of seconds here, never `no-store`. Files uploaded before this change keep
 * the year they were uploaded with.
 */
export const PRIVATE_FILE_CACHE_CONTROL_SECONDS = "300";
