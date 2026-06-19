export const worldRoomRealtimeModel = "gpt-realtime-2";
export const worldRoomRealtimeVoice = "marin";
export const worldRoomTranscriptionModel = "gpt-realtime-whisper";

export const worldRoomInstructions = `
You are World Room, a live worldbuilding companion for writers, game masters, and creative teams.

Work primarily through spoken conversation. Keep turns lively, short, and easy to interrupt.
Help the user invent settings, cultures, characters, conflicts, hidden pressures, and scene hooks.

Behavior:
- Start with one vivid question or one compact idea, then invite the user to steer.
- When the user speaks vaguely, offer two or three concrete creative directions.
- When the user has an idea, expand it with sensory detail, stakes, and a scene-ready hook.
- Track named places, characters, factions, threats, and unresolved questions during the session.
- Avoid long lectures. Speak like a playful creative partner at the table.
- If audio is unclear, ask a short clarifying question instead of guessing important names.
`.trim();

export type WorldRoomRealtimeSessionRequest = {
  session: {
    type: "realtime";
    model: typeof worldRoomRealtimeModel;
    instructions: string;
    max_output_tokens: number;
    output_modalities: ["audio"];
    audio: {
      input: {
        noise_reduction: {
          type: "near_field";
        };
        transcription: {
          model: typeof worldRoomTranscriptionModel;
        };
        turn_detection: {
          type: "semantic_vad";
          eagerness: "medium";
          create_response: true;
          interrupt_response: true;
        };
      };
      output: {
        voice: typeof worldRoomRealtimeVoice;
        speed: number;
      };
    };
  };
};

export function createWorldRoomRealtimeSessionRequest(): WorldRoomRealtimeSessionRequest {
  return {
    session: {
      type: "realtime",
      model: worldRoomRealtimeModel,
      instructions: worldRoomInstructions,
      output_modalities: ["audio"],
      max_output_tokens: 900,
      audio: {
        input: {
          noise_reduction: {
            type: "near_field",
          },
          transcription: {
            model: worldRoomTranscriptionModel,
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice: worldRoomRealtimeVoice,
          speed: 1.03,
        },
      },
    },
  };
}

export type WorldRoomRealtimeClientSecret = {
  expiresAt: number | null;
  value: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readClientSecret(value: unknown): WorldRoomRealtimeClientSecret | null {
  const record = asRecord(value);
  const secret = typeof record?.value === "string" ? record.value.trim() : "";
  if (!secret) return null;

  const expiresAt = typeof record?.expires_at === "number" ? record.expires_at : null;
  return {
    expiresAt,
    value: secret,
  };
}

export function extractWorldRoomRealtimeClientSecret(payload: unknown): WorldRoomRealtimeClientSecret | null {
  const directSecret = readClientSecret(payload);
  if (directSecret) return directSecret;

  const record = asRecord(payload);
  if (!record) return null;

  const nestedSecret = readClientSecret(record.client_secret);
  if (nestedSecret) return nestedSecret;

  const session = asRecord(record.session);
  return readClientSecret(session?.client_secret);
}

export function resolveWorldRoomSafetyIdentifier() {
  const configured = process.env.OPENAI_REALTIME_SAFETY_IDENTIFIER?.trim();
  return configured ? configured.slice(0, 128) : null;
}
