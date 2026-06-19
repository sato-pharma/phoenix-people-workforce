import assert from "node:assert/strict";

import {
  createWorldRoomRealtimeSessionRequest,
  extractWorldRoomRealtimeClientSecret,
  worldRoomInstructions,
  worldRoomRealtimeModel,
  worldRoomRealtimeVoice,
  worldRoomTranscriptionModel,
} from "../src/lib/world-room/realtime-session.ts";

export function runWorldRoomRealtimeTests() {
  const request = createWorldRoomRealtimeSessionRequest();

  assert.equal(request.session.type, "realtime", "World Room must create a Realtime session");
  assert.equal(request.session.model, worldRoomRealtimeModel, "World Room must use the current Realtime voice model");
  assert.equal(request.session.model, "gpt-realtime-2", "World Room should default to gpt-realtime-2");
  assert.deepEqual(request.session.output_modalities, ["audio"], "World Room must use audio output");
  assert.equal(request.session.audio.output.voice, worldRoomRealtimeVoice, "World Room should use the configured voice");
  assert.equal(request.session.audio.output.voice, "marin", "World Room should use a current recommended voice");
  assert.equal(
    request.session.audio.input.transcription.model,
    worldRoomTranscriptionModel,
    "World Room should request realtime input transcription",
  );
  assert.equal(
    request.session.audio.input.turn_detection.type,
    "semantic_vad",
    "World Room should use semantic VAD for low-latency spoken turn-taking",
  );
  assert.equal(
    request.session.audio.input.turn_detection.interrupt_response,
    true,
    "World Room should allow barge-in during assistant speech",
  );
  assert.match(worldRoomInstructions, /settings, cultures, characters, conflicts/, "instructions must target worldbuilding");
  assert.doesNotMatch(JSON.stringify(request), /OPENAI_API_KEY|sk-/, "session payload must never include server secrets");

  assert.deepEqual(
    extractWorldRoomRealtimeClientSecret({ expires_at: 123, value: "ek_current_shape" }),
    { expiresAt: 123, value: "ek_current_shape" },
    "World Room should accept the top-level ephemeral token shape returned by the WebRTC guide",
  );
  assert.deepEqual(
    extractWorldRoomRealtimeClientSecret({ client_secret: { expires_at: 456, value: "ek_reference_shape" } }),
    { expiresAt: 456, value: "ek_reference_shape" },
    "World Room should accept the nested client_secret shape documented in the API reference",
  );
  assert.deepEqual(
    extractWorldRoomRealtimeClientSecret({ session: { client_secret: { value: "ek_wrapped_shape" } } }),
    { expiresAt: null, value: "ek_wrapped_shape" },
    "World Room should tolerate wrapped session payloads without leaking parsing details to the client",
  );
  assert.equal(extractWorldRoomRealtimeClientSecret({ client_secret: {} }), null, "World Room should reject malformed secrets");
}
