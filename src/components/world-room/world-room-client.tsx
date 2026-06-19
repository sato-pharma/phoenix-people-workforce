"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Globe2,
  Loader2,
  MessageCircle,
  Mic,
  MicOff,
  Power,
  Radio,
  RefreshCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";

type SessionPhase =
  | "idle"
  | "starting"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "assistant-speaking"
  | "reconnecting"
  | "closed"
  | "error";

type TranscriptEntry = {
  final: boolean;
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  time: string;
};

type RealtimeEvent = {
  type?: string;
  [key: string]: unknown;
};

type SessionTokenResponse = {
  clientSecret?: {
    expiresAt?: number | null;
    value?: string;
  };
  error?: string;
  message?: string;
  model?: string;
  success?: boolean;
  voice?: string;
};

const sparkPrompts = [
  {
    label: "Setting",
    text: "Invent a strange but playable fantasy setting. Give me one landmark, one rule of the world, and one immediate scene hook.",
  },
  {
    label: "Character",
    text: "Create a character who belongs in this world. Give me their public face, private need, and a secret they would protect.",
  },
  {
    label: "Conflict",
    text: "Escalate the central conflict. Give me two factions, what each wants, and the cost if nobody acts.",
  },
  {
    label: "Scene hook",
    text: "Pitch a scene hook I can start playing or writing immediately. Keep it vivid and actionable.",
  },
] as const;

function nowLabel() {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function valueAsString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function eventKey(event: RealtimeEvent, fallback: string) {
  const responseId = valueAsString(event.response_id);
  const itemId = valueAsString(event.item_id);
  const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
  const contentIndex = typeof event.content_index === "number" ? event.content_index : 0;
  return [responseId || itemId || fallback, outputIndex, contentIndex].join(":");
}

function friendlyError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Microphone permission was denied. Allow microphone access and try again.";
    if (error.name === "NotFoundError") return "No microphone was found on this device.";
  }
  if (error instanceof Error) return error.message;
  return "World Room could not start the audio session.";
}

export function WorldRoomClient() {
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [statusText, setStatusText] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isDataChannelOpen, setIsDataChannelOpen] = useState(false);
  const [meter, setMeter] = useState(0);
  const [metadata, setMetadata] = useState({ model: "gpt-realtime-2", voice: "marin" });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const isActive = phase !== "idle" && phase !== "closed" && phase !== "error";
  const canSend = isDataChannelOpen;

  const appendTranscriptDelta = useCallback((role: TranscriptEntry["role"], id: string, delta: string) => {
    if (!delta) return;
    setTranscript((current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return [
          ...current,
          {
            final: false,
            id,
            role,
            text: delta,
            time: nowLabel(),
          },
        ];
      }

      const next = [...current];
      next[index] = {
        ...next[index],
        final: false,
        text: `${next[index].text}${delta}`,
      };
      return next;
    });
  }, []);

  const finalizeTranscript = useCallback((role: TranscriptEntry["role"], id: string, text?: string) => {
    setTranscript((current) => {
      const index = current.findIndex((entry) => entry.id === id);
      const cleaned = text?.trim();
      if (index === -1) {
        if (!cleaned) return current;
        return [
          ...current,
          {
            final: true,
            id,
            role,
            text: cleaned,
            time: nowLabel(),
          },
        ];
      }

      const next = [...current];
      next[index] = {
        ...next[index],
        final: true,
        text: cleaned || next[index].text,
      };
      return next;
    });
  }, []);

  const addSystemLine = useCallback((text: string) => {
    setTranscript((current) => [
      ...current,
      {
        final: true,
        id: `system:${Date.now()}`,
        role: "system",
        text,
        time: nowLabel(),
      },
    ]);
  }, []);

  const stopMeter = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setMeter(0);
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    stopMeter();
    if (!window.AudioContext) return;

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.fftSize = 256;
    source.connect(analyser);
    audioContextRef.current = context;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      setMeter(Math.min(1, average / 96));
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [stopMeter]);

  const disconnect = useCallback((nextPhase: SessionPhase = "closed", nextStatus = "Room closed") => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    setIsDataChannelOpen(false);
    peerRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    stopMeter();
    setIsMuted(false);
    setPhase(nextPhase);
    setStatusText(nextStatus);
  }, [stopMeter]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        setStatusText("Realtime session ready");
        return;
      case "input_audio_buffer.speech_started":
        setPhase("user-speaking");
        setStatusText("Listening to your turn");
        return;
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        setPhase("listening");
        setStatusText("Shaping the next beat");
        return;
      case "conversation.item.input_audio_transcription.delta":
        appendTranscriptDelta("user", eventKey(event, "user"), valueAsString(event.delta));
        return;
      case "conversation.item.input_audio_transcription.completed":
        finalizeTranscript("user", eventKey(event, "user"), valueAsString(event.transcript));
        return;
      case "response.created":
        setPhase("assistant-speaking");
        setStatusText("Companion is speaking");
        return;
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
        appendTranscriptDelta("assistant", eventKey(event, "assistant"), valueAsString(event.delta));
        return;
      case "response.output_audio_transcript.done":
      case "response.output_text.done":
        finalizeTranscript("assistant", eventKey(event, "assistant"), valueAsString(event.transcript) || valueAsString(event.text));
        return;
      case "response.done":
        setPhase("listening");
        setStatusText("Room is listening");
        return;
      case "error": {
        const detail = typeof event.error === "object" && event.error
          ? valueAsString((event.error as Record<string, unknown>).message)
          : "Realtime session error.";
        setError(detail || "Realtime session error.");
        setPhase("error");
        setStatusText("Needs recovery");
        return;
      }
      default:
        return;
    }
  }, [appendTranscriptDelta, finalizeTranscript]);

  const sendRealtimeEvent = useCallback((event: Record<string, unknown>) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      throw new Error("The Realtime data channel is not ready yet.");
    }
    channel.send(JSON.stringify(event));
  }, []);

  const startSession = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not expose microphone capture APIs.");
      setPhase("error");
      return;
    }

    disconnect("idle", "Preparing room");
    setError(null);
    setTranscript([]);
    setPhase("starting");
    setStatusText("Minting session token");

    try {
      const tokenResponse = await fetch("/api/world-room/realtime-session", {
        body: JSON.stringify({ intent: "start" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const tokenData = (await tokenResponse.json()) as SessionTokenResponse;
      if (!tokenResponse.ok || !tokenData.clientSecret?.value) {
        throw new Error(tokenData.message ?? "Could not create a Realtime session token.");
      }
      setMetadata({
        model: tokenData.model ?? "gpt-realtime-2",
        voice: tokenData.voice ?? "marin",
      });

      setPhase("connecting");
      setStatusText("Requesting microphone");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      streamRef.current = stream;
      startMeter(stream);

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      peer.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setPhase("listening");
          setStatusText("Room is listening");
        }
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          setPhase("error");
          setStatusText("Connection interrupted");
          setError("The audio connection was interrupted. Reconnect to continue the room.");
        }
        if (peer.connectionState === "closed") {
          setStatusText("Room closed");
        }
      };

      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.addEventListener("open", () => {
        setIsDataChannelOpen(true);
        setPhase("assistant-speaking");
        setStatusText("Companion is entering");
        addSystemLine("World Room opened.");
        sendRealtimeEvent({
          response: {
            instructions: "Greet the user in one spoken sentence, then ask what kind of world they want to build.",
          },
          type: "response.create",
        });
      });
      channel.addEventListener("close", () => {
        setIsDataChannelOpen(false);
        if (peerRef.current) {
          setStatusText("Event channel closed");
        }
      });
      channel.addEventListener("message", (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          setError("A Realtime event could not be parsed.");
        }
      });

      setStatusText("Opening audio bridge");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) {
        throw new Error("Browser could not create a WebRTC offer.");
      }

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${tokenData.clientSecret.value}`,
          "Content-Type": "application/sdp",
        },
        method: "POST",
      });
      const answerSdp = await sdpResponse.text();
      if (!sdpResponse.ok) {
        throw new Error(answerSdp || "OpenAI rejected the WebRTC offer.");
      }
      await peer.setRemoteDescription({ sdp: answerSdp, type: "answer" });
    } catch (sessionError) {
      disconnect("error", "Needs recovery");
      setError(friendlyError(sessionError));
    }
  }, [addSystemLine, disconnect, handleRealtimeEvent, sendRealtimeEvent, startMeter]);

  const reconnect = useCallback(() => {
    setPhase("reconnecting");
    setStatusText("Reconnecting");
    void startSession();
  }, [startSession]);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMuted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
    setStatusText(nextMuted ? "Microphone muted" : "Microphone live");
  }, [isMuted]);

  const sendSpark = useCallback((text: string, label: string) => {
    try {
      sendRealtimeEvent({
        item: {
          content: [{ text, type: "input_text" }],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      });
      sendRealtimeEvent({ type: "response.create" });
      finalizeTranscript("user", `spark:${Date.now()}`, label);
      setPhase("assistant-speaking");
      setStatusText("Companion is speaking");
    } catch (sparkError) {
      setError(friendlyError(sparkError));
      setPhase("error");
      setStatusText("Needs recovery");
    }
  }, [finalizeTranscript, sendRealtimeEvent]);

  useEffect(() => () => disconnect("closed", "Room closed"), [disconnect]);

  const statusTone = useMemo(() => {
    if (phase === "error") return "border-[#F26D5B] bg-[#F26D5B]/12 text-[#FFD8D2]";
    if (phase === "assistant-speaking") return "border-[#D6F567] bg-[#D6F567]/12 text-[#F2FFC1]";
    if (phase === "user-speaking" || phase === "listening") return "border-[#5EC9B7] bg-[#5EC9B7]/12 text-[#C9FFF5]";
    return "border-white/15 bg-white/8 text-[#F7F0DC]";
  }, [phase]);

  return (
    <main className="min-h-screen overflow-hidden bg-[#101211] text-[#F7F0DC]">
      <audio ref={audioRef} autoPlay playsInline />
      <div className="pointer-events-none fixed inset-0 opacity-45 [background-image:linear-gradient(rgba(94,201,183,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(214,245,103,0.05)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none fixed inset-0 [background:linear-gradient(125deg,rgba(57,48,74,0.82)_0%,rgba(16,18,17,0)_32%,rgba(94,201,183,0.12)_66%,rgba(242,109,91,0.1)_100%)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1500px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-white/12 pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 border border-[#D6F567]/35 bg-[#D6F567]/10 px-3 py-1 text-xs font-bold uppercase text-[#EFFF96]">
              <Globe2 className="h-4 w-4" />
              Live audio worldbuilding
            </div>
            <h1 className="mt-4 text-4xl font-black leading-none text-[#FFF9E8] sm:text-6xl lg:text-7xl">
              World Room
            </h1>
            <p className="mt-4 max-w-2xl text-base font-medium leading-7 text-[#D8D2BD] sm:text-lg">
              Speak with a realtime companion that turns stray ideas into places, people, pressure, and scene-ready sparks.
            </p>
          </div>

          <div className={`flex w-full max-w-sm items-center justify-between border px-4 py-3 ${statusTone}`}>
            <div>
              <p className="text-xs font-bold uppercase text-current/70">Session</p>
              <p className="mt-1 text-lg font-black">{statusText}</p>
            </div>
            {phase === "starting" || phase === "connecting" || phase === "reconnecting" ? (
              <Loader2 className="h-7 w-7 animate-spin" />
            ) : (
              <Radio className="h-7 w-7" />
            )}
          </div>
        </header>

        <section className="grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(290px,0.75fr)_minmax(360px,1fr)_minmax(320px,0.9fr)]">
          <div className="flex flex-col gap-5">
            <div className="border border-white/12 bg-[#181A18]/86 p-4 shadow-[0_24px_70px_rgba(0,0,0,0.28)]">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold uppercase text-[#D6F567]">Companion</p>
                  <p className="mt-1 text-2xl font-black text-[#FFF9E8]">The map answers back</p>
                </div>
                <Sparkles className="h-7 w-7 text-[#D6F567]" />
              </div>
              <div className="mt-5 grid gap-3 text-sm font-semibold text-[#D8D2BD]">
                <div className="flex items-center justify-between border border-white/10 bg-white/[0.04] px-3 py-3">
                  <span>Model</span>
                  <span className="text-[#FFF9E8]">{metadata.model}</span>
                </div>
                <div className="flex items-center justify-between border border-white/10 bg-white/[0.04] px-3 py-3">
                  <span>Voice</span>
                  <span className="text-[#FFF9E8]">{metadata.voice}</span>
                </div>
                <div className="flex items-center justify-between border border-white/10 bg-white/[0.04] px-3 py-3">
                  <span>Turn-taking</span>
                  <span className="text-[#5EC9B7]">Semantic VAD</span>
                </div>
              </div>
            </div>

            <div className="border border-white/12 bg-[#241F2D]/70 p-4">
              <div className="flex items-center gap-2 text-sm font-black uppercase text-[#F7F0DC]">
                <MessageCircle className="h-4 w-4 text-[#F26D5B]" />
                Sparks
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {sparkPrompts.map((prompt) => (
                  <button
                    className="flex min-h-12 items-center justify-center gap-2 border border-white/12 bg-[#101211] px-3 py-2 text-sm font-black text-[#F7F0DC] transition hover:border-[#D6F567]/70 hover:text-[#EFFF96] focus:outline-none focus:ring-2 focus:ring-[#D6F567]/70 disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={!canSend}
                    key={prompt.label}
                    onClick={() => sendSpark(prompt.text, prompt.label)}
                    type="button"
                  >
                    <Send className="h-4 w-4" />
                    {prompt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center border border-white/12 bg-[#151716]/92 p-5 shadow-[0_28px_90px_rgba(0,0,0,0.32)]">
            <div className="relative flex aspect-square w-full max-w-[460px] items-center justify-center">
              <div className="absolute inset-0 border border-[#D6F567]/20 [background:repeating-conic-gradient(from_0deg,rgba(214,245,103,0.18)_0deg,rgba(214,245,103,0.18)_1deg,transparent_1deg,transparent_14deg)]" />
              <div className="absolute inset-[9%] border border-[#5EC9B7]/35 [background:repeating-linear-gradient(135deg,rgba(94,201,183,0.1)_0_1px,transparent_1px_16px)]" />
              <div className="absolute inset-[18%] border border-[#F26D5B]/35 [background:linear-gradient(180deg,rgba(242,109,91,0.16),rgba(214,245,103,0.06))]" />
              <button
                className="relative z-10 flex h-40 w-40 flex-col items-center justify-center border border-[#D6F567] bg-[#101211] text-[#FFF9E8] shadow-[0_0_0_10px_rgba(214,245,103,0.05),0_22px_60px_rgba(0,0,0,0.45)] transition hover:bg-[#161A14] focus:outline-none focus:ring-2 focus:ring-[#D6F567] sm:h-48 sm:w-48"
                onClick={isActive ? () => disconnect("closed", "Room closed") : startSession}
                type="button"
              >
                {isActive ? <Square className="h-11 w-11 text-[#F26D5B]" /> : <Power className="h-12 w-12 text-[#D6F567]" />}
                <span className="mt-4 text-sm font-black uppercase">{isActive ? "End room" : "Start room"}</span>
              </button>
            </div>

            <div className="mt-5 flex h-16 w-full max-w-lg items-end justify-center gap-1 border border-white/10 bg-black/20 px-3 py-3" aria-label="Microphone level">
              {Array.from({ length: 28 }).map((_, index) => {
                const wave = Math.abs(Math.sin((index + 1) * 0.7));
                const height = isMuted ? 8 : 8 + Math.round((meter * 44 + (phase === "assistant-speaking" ? 18 : 0)) * wave);
                return (
                  <span
                    className="w-1 bg-[#5EC9B7] transition-[height,background-color] duration-150"
                    key={index}
                    style={{
                      height,
                      backgroundColor: isMuted ? "#706B61" : index % 5 === 0 ? "#D6F567" : "#5EC9B7",
                    }}
                  />
                );
              })}
            </div>

            <div className="mt-5 flex w-full flex-wrap items-center justify-center gap-2">
              <button
                className="inline-flex h-11 items-center gap-2 border border-white/12 bg-white/[0.06] px-4 text-sm font-black text-[#F7F0DC] transition hover:border-[#5EC9B7]/70 focus:outline-none focus:ring-2 focus:ring-[#5EC9B7]/70 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!isActive}
                onClick={toggleMute}
                title={isMuted ? "Unmute microphone" : "Mute microphone"}
                type="button"
              >
                {isMuted ? <MicOff className="h-5 w-5 text-[#F26D5B]" /> : <Mic className="h-5 w-5 text-[#5EC9B7]" />}
                {isMuted ? "Unmute" : "Mute"}
              </button>
              <button
                className="inline-flex h-11 items-center gap-2 border border-white/12 bg-white/[0.06] px-4 text-sm font-black text-[#F7F0DC] transition hover:border-[#D6F567]/70 focus:outline-none focus:ring-2 focus:ring-[#D6F567]/70 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={phase !== "error" && phase !== "closed"}
                onClick={reconnect}
                type="button"
              >
                <RefreshCcw className="h-5 w-5" />
                Reconnect
              </button>
              <button
                className="inline-flex h-11 items-center gap-2 border border-white/12 bg-white/[0.06] px-4 text-sm font-black text-[#F7F0DC] transition hover:border-[#F26D5B]/70 focus:outline-none focus:ring-2 focus:ring-[#F26D5B]/70"
                onClick={() => setTranscript([])}
                type="button"
              >
                <Trash2 className="h-5 w-5" />
                Clear
              </button>
            </div>

            {error && (
              <div className="mt-5 flex w-full max-w-lg items-start gap-3 border border-[#F26D5B]/55 bg-[#F26D5B]/12 px-4 py-3 text-sm font-semibold leading-6 text-[#FFD8D2]">
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
          </div>

          <div className="flex min-h-[520px] flex-col border border-white/12 bg-[#F7F0DC] text-[#101211] shadow-[0_24px_70px_rgba(0,0,0,0.22)]">
            <div className="flex items-center justify-between border-b border-[#101211]/15 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-black uppercase">
                <Volume2 className="h-4 w-4 text-[#F26D5B]" />
                Transcript
              </div>
              <span className="text-xs font-bold text-[#5F5B50]">{transcript.length} marks</span>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {transcript.length === 0 ? (
                <div className="border border-dashed border-[#101211]/25 px-4 py-10 text-center">
                  <p className="text-sm font-black uppercase text-[#5F5B50]">No marks yet</p>
                  <p className="mt-2 text-sm font-semibold leading-6 text-[#6B6659]">Start the room and speak the first fragment.</p>
                </div>
              ) : (
                transcript.map((entry) => (
                  <article
                    className={`border px-3 py-3 ${
                      entry.role === "assistant"
                        ? "border-[#5EC9B7]/55 bg-[#5EC9B7]/12"
                        : entry.role === "user"
                          ? "border-[#39304A]/30 bg-white"
                          : "border-[#D6F567]/55 bg-[#D6F567]/20"
                    }`}
                    key={entry.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-black uppercase text-[#39304A]">
                        {entry.role === "assistant" ? "Companion" : entry.role === "user" ? "You" : "System"}
                      </p>
                      <p className="text-[11px] font-bold text-[#6B6659]">{entry.time}</p>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-[#171511]">
                      {entry.text}
                      {!entry.final && <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-[#F26D5B]" />}
                    </p>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
