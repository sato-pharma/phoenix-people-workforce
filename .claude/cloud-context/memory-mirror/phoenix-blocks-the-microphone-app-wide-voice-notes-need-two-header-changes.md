---
name: phoenix-blocks-the-microphone-app-wide-voice-notes-need-two-header-changes
description: Building voice notes or dictation in Phoenix (copied from the FTP Portal visit form) fails until next.config.ts allows the microphone and lets audio from Supabase play
metadata: 
  node_type: memory
  type: project
  originSessionId: 01f4c16f-77d8-4eb9-9158-6542f7d87a53
  modified: 2026-09-12T21:56:56.143Z
---

On 2026-09-13 the owner said Phoenix will later get a voice-note and dictation feature modelled on the FTP Portal visit form (repo `F:\FTP 2026\FTP PORTAL`, files `src/lib/recorder.ts`, `src/lib/dictation.ts`, `src/app/(intern)/visit/voice-note.tsx`, `visit-form.tsx`, `src/lib/pending-upload.ts`, `src/lib/use-form-draft.ts`, `src/lib/net.ts`, `src/lib/client-token.ts`).

Two Phoenix blockers, verified on origin/main:
- `next.config.ts` sends `Permissions-Policy: camera=(), microphone=(), ...` on every route (since 2026-05-12). `microphone=()` kills both MediaRecorder and Web Speech dictation before any prompt.
- CSP `media-src 'self' blob:` blocks `<audio>` from a signed Supabase URL, and also blocks a same-origin route that 302-redirects to one.

What FTP got wrong in production (do not copy): its bucket had no audio MIME types, so 0 voice notes out of 3,701 visits; a storage refusal was shown as "No signal" and retried for 3 days; a visit queued offline waited forever behind a note that could never upload.

**Why:** the FTP code looks complete and was shipped, but the feature never worked live. A port that copies it and skips these checks will fail silently the same way.

**How to apply:** at the start of that build, change the header and CSP first. Create the bucket with `audio/webm`, `audio/mp4`, `audio/ogg`, `audio/aac`, `audio/mpeg` in the same migration. Upload a real Android recording (`audio/webm;codecs=opus`) and a real iPhone recording (`audio/mp4`) on staging. Treat only network errors as retryable. Put the owner-folder and 24-hour checks behind `assertPermission`, because Phoenix uses the service role and not row-level security. Also decide whether dictation may send audio to Google's speech servers, which is how Chrome processes it.
