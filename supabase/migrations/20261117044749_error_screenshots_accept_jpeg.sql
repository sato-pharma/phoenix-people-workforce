-- error_screenshots_accept_jpeg
--
-- WHAT THIS CHANGES:
--   The private `error-screenshots` bucket accepts a JPEG beside a WebP: its allowed_mime_types goes
--   from {image/webp} to {image/webp, image/jpeg}. Nothing else about the bucket changes — it stays
--   private, 2 MB a file (migration 20261023180801_app_error_events_screenshot).
--
-- WHY (17 Nov 2026, the error-screenshot deep audit):
--   No crash screenshot had ever been stored from an iPhone, an iPad or Safari on a Mac. The browser
--   draws the picture and asks for WebP; WebKit cannot encode WebP and silently hands back a PNG, which
--   /api/errors/client/screenshot refused as not-WebP. Production, 24 Oct – 17 Nov 2026: 593 iPhone/iPad
--   and 228 Mac Safari signed-in crash reports, 0 pictures (Chromium: 49 of 426). The browser now falls
--   back to JPEG when it cannot encode WebP (src/lib/error-monitor/capture-screenshot.ts), and the route
--   accepts either by its own magic bytes and stores a JPEG as `.jpg` with this type — which this
--   bucket's allow-list refused until now. The route's sniff stays the first gate; this is the second.
--
-- ROLLBACK:
--   update storage.buckets set allowed_mime_types = array['image/webp'] where id = 'error-screenshots';
--   The allow-list is checked when a file is uploaded, so JPEGs already stored stay readable; crash
--   pictures from Apple devices stop being stored again.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one bucket row's allow-list, and running it twice changes nothing.

begin;
set local lock_timeout = '5s';

update storage.buckets
   set allowed_mime_types = array['image/webp', 'image/jpeg']
 where id = 'error-screenshots';

commit;
