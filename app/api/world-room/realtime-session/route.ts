import { NextResponse, type NextRequest } from "next/server";

import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createWorldRoomRealtimeSessionRequest,
  extractWorldRoomRealtimeClientSecret,
  resolveWorldRoomSafetyIdentifier,
  worldRoomRealtimeModel,
  worldRoomRealtimeVoice,
} from "@/lib/world-room/realtime-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

export async function POST(request: NextRequest) {
  const csrfError = assertSameOriginMutation(request);
  if (csrfError) return csrfError;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "openai_api_key_missing",
        message: "OPENAI_API_KEY is required on the server before World Room can start an audio session.",
        success: false,
      },
      { status: 503 },
    );
  }

  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
  const safetyIdentifier = resolveWorldRoomSafetyIdentifier();
  if (safetyIdentifier) {
    headers.set("OpenAI-Safety-Identifier", safetyIdentifier);
  }

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    body: JSON.stringify(createWorldRoomRealtimeSessionRequest()),
    cache: "no-store",
    headers,
    method: "POST",
  });

  const payload = await readJson(response);
  if (!response.ok) {
    return NextResponse.json(
      {
        error: "openai_realtime_session_failed",
        message: getErrorMessage(payload) ?? "OpenAI could not create the Realtime client secret.",
        openaiStatus: response.status,
        success: false,
      },
      { status: 502 },
    );
  }

  const clientSecret = extractWorldRoomRealtimeClientSecret(payload);
  if (!clientSecret) {
    return NextResponse.json(
      {
        error: "openai_realtime_session_malformed",
        message: "OpenAI returned a Realtime session response without a client secret.",
        success: false,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      clientSecret: {
        expiresAt: clientSecret.expiresAt,
        value: clientSecret.value,
      },
      model: worldRoomRealtimeModel,
      success: true,
      voice: worldRoomRealtimeVoice,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
