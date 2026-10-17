"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { captureClientErrorInSentry } from "@/lib/observability/sentry-client";

type Props = {
  browserDsnPresent: boolean;
  /** Why the server side is off on this deployment, or null when it is on. */
  serverReason: string | null;
};

export function SentryCheckPanel({ browserDsnPresent, serverReason }: Props) {
  const [serverBusy, setServerBusy] = useState(false);
  const serverOn = serverReason === null;
  const browserOn = serverOn && browserDsnPresent;

  function sendBrowserError() {
    // The same entry point every real browser failure uses; it no-ops anywhere but the production host.
    captureClientErrorInSentry({
      context: "sentry-check page",
      error: new Error("Sentry Check: deliberate browser test error"),
      route: "/admin/sentry-check",
    });
    toast.success("Browser test error sent. It reaches Sentry within a minute.");
  }

  async function sendServerError() {
    setServerBusy(true);
    try {
      const response = await fetch("/api/admin/sentry-check", { method: "POST" });
      // A 500 is the SUCCESS case: the route threw on purpose and the server's own error hook reported it.
      if (response.status === 500) {
        toast.success("Server test error thrown. It reaches Sentry within a minute.");
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      toast.error(body?.message ?? `The server did not throw (${response.status}).`);
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setServerBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="border border-border bg-background p-4 text-sm">
        <p className="font-medium">Status on this deployment</p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>Server: {serverOn ? "on" : `off, ${serverReason}`}</li>
          <li>Browser: {browserOn ? "on" : serverOn ? "off, NEXT_PUBLIC_SENTRY_DSN is missing or not a valid DSN" : "off, the server side is off"}</li>
        </ul>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 border border-border bg-background p-4">
          <p className="text-sm font-medium">Browser error</p>
          <p className="text-sm text-muted-foreground">
            Throws a test error through the reporter every real browser failure uses.
          </p>
          <Button disabled={!browserOn} onClick={sendBrowserError} type="button" variant="outline">
            Send browser test error
          </Button>
        </div>
        <div className="space-y-3 border border-border bg-background p-4">
          <p className="text-sm font-medium">Server error</p>
          <p className="text-sm text-muted-foreground">
            Makes the server throw on purpose. The request answers 500, which is the expected result here.
          </p>
          <Button disabled={!serverOn || serverBusy} onClick={sendServerError} type="button" variant="outline">
            {serverBusy ? "Sending" : "Send server test error"}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        A new Sentry issue also reaches the admin Telegram through the alert webhook, and the server test error is
        recorded in the system error log as well. Both are expected.
      </p>
    </div>
  );
}
