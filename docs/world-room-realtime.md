# World Room Realtime Audio App

World Room is a public local demo route at `/world-room`. It uses OpenAI Realtime over WebRTC for low-latency speech-to-speech worldbuilding.

## Architecture

- Browser responsibilities:
  - Ask for microphone permission through `navigator.mediaDevices.getUserMedia`.
  - Create the `RTCPeerConnection`.
  - Play model audio from the remote WebRTC track.
  - Send the browser SDP offer to `https://api.openai.com/v1/realtime/calls` with an ephemeral client secret.
  - Listen to Realtime data-channel events for session state and transcript deltas.

- Server responsibilities:
  - Keep `OPENAI_API_KEY` server-only.
  - Create a short-lived client secret through `POST https://api.openai.com/v1/realtime/client_secrets`.
  - Configure the Realtime session with `gpt-realtime-2`, `marin`, speech output, input transcription, and semantic VAD.
  - Return only the ephemeral client secret and non-sensitive session metadata to the browser.

## Setup

1. Add the server-only API key to `.env.local`:

   ```bash
   OPENAI_API_KEY=sk-...
   ```

2. Optional: add a privacy-preserving safety identifier if the app is tied to a known user:

   ```bash
   OPENAI_REALTIME_SAFETY_IDENTIFIER=hashed-user-id
   ```

3. Start local development:

   ```bash
   npm run dev
   ```

4. Open:

   ```text
   http://localhost:3000/world-room
   ```

Microphone capture works on `localhost` or HTTPS. Plain HTTP on a non-local host will normally fail browser permission checks.

## Developer Notes

- Latency:
  - The browser uses WebRTC directly to OpenAI after receiving a one-minute client secret.
  - The session uses semantic VAD so the model can respond when the user has finished speaking without requiring a manual submit button.
  - Keep assistant turns short. Long spoken responses increase perceived latency and make interruption less comfortable.

- Session lifecycle:
  - A client secret is minted per room start and is not cached.
  - The token expires quickly, so the browser must create the WebRTC call immediately after receiving it.
  - Ending the room closes the data channel, peer connection, remote audio, local tracks, and microphone meter.
  - Reconnect creates a fresh client secret and a fresh peer connection.

- Permissions:
  - `OPENAI_API_KEY` must never be sent to the browser.
  - `/api/world-room/realtime-session` is a same-origin POST token broker.
  - The endpoint performs no Phoenix HR data access and does not use Supabase service role.
  - If World Room becomes authenticated, replace the optional static safety identifier with a hashed stable internal user ID.

- Error recovery:
  - Missing `OPENAI_API_KEY` returns a clear 503 from the server route.
  - OpenAI token creation failures return a 502 with the safe API error message.
  - Browser microphone denial, missing microphone, WebRTC failure, and data-channel parse errors are surfaced in the UI.
  - The Reconnect button always starts a fresh Realtime session.

## Validation Checklist

- Audio permissions:
  - Open `/world-room` on `localhost`.
  - Click `Start room`.
  - Confirm the browser asks for microphone access.
  - Deny access once and verify the UI shows the microphone-permission error.
  - Allow access and verify the mic meter moves when speaking.

- Realtime connection:
  - Confirm the session status moves from token creation to microphone request to listening.
  - Confirm the model greets the user with audio.
  - Speak a short worldbuilding idea and confirm the companion responds with audio.
  - Confirm transcript rows appear for companion responses and, when available, user speech.

- Turn-taking quality:
  - Interrupt the companion while it is speaking and confirm it stops or adapts quickly.
  - Pause mid-sentence and confirm semantic VAD does not cut in too aggressively.
  - Test a noisy room and headset microphone separately.

- Recovery:
  - Click `End room` and confirm microphone capture stops.
  - Click `Reconnect` after an error and confirm a fresh session starts.
  - Temporarily remove `OPENAI_API_KEY` locally and confirm the server error is clear.

## OpenAI References Used

- Realtime overview: `https://developers.openai.com/api/docs/guides/realtime`
- WebRTC connection pattern: `https://developers.openai.com/api/docs/guides/realtime-webrtc`
- Voice agents: `https://developers.openai.com/api/docs/guides/voice-agents`
- Models: `https://developers.openai.com/api/docs/models`
