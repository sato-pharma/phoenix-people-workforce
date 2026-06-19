import assert from "node:assert/strict";

import {
  createWorldRoomRealtimeSessionRequest,
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
}
