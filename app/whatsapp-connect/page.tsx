"use client";

import { AlertCircle, CheckCircle2, Loader2, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  WHATSAPP_EMBEDDED_SIGNUP_APP_ID,
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
  WHATSAPP_EMBEDDED_SIGNUP_FEATURE_TYPE,
  WHATSAPP_EMBEDDED_SIGNUP_SDK_VERSION,
} from "@/lib/recruitment/inbound/whatsapp-embedded-signup";

// Minimal typing for just the two Facebook JS SDK calls this page makes — narrower than pulling in a
// full @types package, and enough to keep the file free of `any`.
type FacebookLoginResponse = {
  authResponse: { code?: string } | null;
  status: string;
};

type FacebookLoginOptions = {
  config_id: string;
  response_type: "code";
  override_default_response_type: boolean;
  extras: {
    setup: Record<string, never>;
    featureType: string;
    sessionInfoVersion: string;
  };
};

type FacebookSdk = {
  init: (params: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (callback: (response: FacebookLoginResponse) => void, options: FacebookLoginOptions) => void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

type ConnectStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "exchanging" }
  | { kind: "done" }
  | { kind: "error"; message: string };

const PHONE_STEPS = [
  "When the WhatsApp window opens, choose the number that runs on this phone and continue.",
  "WhatsApp sends a code to that number — open WhatsApp, then come back and enter it.",
  'Tap "Connect", then "Confirm" to sync recent chats.',
  "Wait for the green tick on this page — that's it, you're done.",
];

export default function WhatsAppConnectPage() {
  const [status, setStatus] = useState<ConnectStatus>({ kind: "idle" });
  // The WABA the handset joins is reported through a postMessage during the dialog; capture it in a
  // ref (not state) so a late message never triggers a re-render mid-flow.
  const wabaIdRef = useRef<string | null>(null);
  // Set true once FB.init has run. A ref, so the SDK-ready signal never calls setState from the
  // effect (a lint error in this repo) — the button just checks it at click time.
  const fbReadyRef = useRef(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "https://www.facebook.com" && event.origin !== "https://web.facebook.com") {
        return;
      }
      let data: unknown = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== "object") {
        return;
      }
      const parsed = data as { type?: string; data?: { waba_id?: string } };
      if (parsed.type === "WA_EMBEDDED_SIGNUP" && parsed.data?.waba_id) {
        wabaIdRef.current = parsed.data.waba_id;
      }
    };
    window.addEventListener("message", onMessage);

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: WHATSAPP_EMBEDDED_SIGNUP_APP_ID,
        autoLogAppEvents: true,
        xfbml: false,
        version: WHATSAPP_EMBEDDED_SIGNUP_SDK_VERSION,
      });
      fbReadyRef.current = true;
    };

    if (!document.getElementById("facebook-jssdk")) {
      const script = document.createElement("script");
      script.id = "facebook-jssdk";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      document.body.appendChild(script);
    }

    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const exchange = useCallback(async (code: string) => {
    setStatus({ kind: "exchanging" });
    try {
      const response = await fetch("/api/whatsapp/embedded-signup/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, wabaId: wabaIdRef.current }),
      });
      if (!response.ok) {
        setStatus({
          kind: "error",
          message: "The connection could not be completed. Please try again in a moment.",
        });
        return;
      }
      setStatus({ kind: "done" });
    } catch {
      setStatus({
        kind: "error",
        message: "Network problem while finishing the connection. Please try again.",
      });
    }
  }, []);

  const launch = useCallback(() => {
    const sdk = window.FB;
    if (!sdk || !fbReadyRef.current) {
      setStatus({ kind: "error", message: "Still loading — give it a second, then tap Connect again." });
      return;
    }
    wabaIdRef.current = null;
    setStatus({ kind: "connecting" });
    sdk.login(
      (response) => {
        const code = response?.authResponse?.code;
        if (!code) {
          setStatus({
            kind: "error",
            message: "The WhatsApp window closed before it finished. You can tap Connect to try again.",
          });
          return;
        }
        void exchange(code);
      },
      {
        config_id: WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: WHATSAPP_EMBEDDED_SIGNUP_FEATURE_TYPE,
          sessionInfoVersion: "3",
        },
      },
    );
  }, [exchange]);

  const busy = status.kind === "connecting" || status.kind === "exchanging";
  const done = status.kind === "done";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-card-foreground shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessageCircle className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="text-lg font-semibold">Connect your WhatsApp Business app</h1>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          This links the WhatsApp Business app on this phone to Phoenix HR, so CVs sent to this number
          arrive in the recruitment inbox automatically. Your WhatsApp keeps working on the phone as
          normal — nothing is moved or signed out.
        </p>

        <ol className="mt-5 space-y-2 text-sm text-muted-foreground">
          {PHONE_STEPS.map((step, index) => (
            <li key={step} className="flex gap-3">
              <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <div className="mt-6">
          <Button size="lg" className="w-full" onClick={launch} disabled={busy || done}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <MessageCircle className="h-4 w-4" aria-hidden />
            )}
            {status.kind === "connecting"
              ? "Opening WhatsApp…"
              : status.kind === "exchanging"
                ? "Finishing…"
                : done
                  ? "Connected"
                  : "Connect WhatsApp Business app"}
          </Button>
        </div>

        {done ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="text-foreground">
              Connected. CVs sent to this number will now appear in the recruitment inbox. You can close
              this page.
            </span>
          </div>
        ) : null}

        {status.kind === "error" ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-destructive" aria-hidden />
            <span className="text-destructive">{status.message}</span>
          </div>
        ) : null}
      </div>
    </main>
  );
}
