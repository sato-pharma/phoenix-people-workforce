/**
 * /connector/authorize — where ChatGPT sends the owner or the CEO to let it into Phoenix.
 *
 * Signed out: straight to /login, and back here after signing in. Signed in: the request is checked
 * (a registered ChatGPT connection, its own return address, PKCE) and the page says plainly what
 * ChatGPT will be able to do, with Allow and Cancel. Any other seat reads that only the owner and
 * the CEO can connect it.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  phxFormBlockHeaderClassName,
  phxFormErrorClassName,
  phxFormPanelClassName,
} from "@/components/ui/form-tokens";
import { systemIdentity } from "@/config/system-settings";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { connectorOAuth } from "@/lib/chatgpt-connector/http";
import { isConnectorRole, OAuthError } from "@/lib/chatgpt-connector/oauth";
import { cn } from "@/lib/utils";

import { ConnectorConsent } from "./consent";

export const metadata: Metadata = { title: `Connect ChatGPT · ${systemIdentity.appName}` };
export const dynamic = "force-dynamic";

const KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-10 sm:items-center">
      <section className={cn(phxFormPanelClassName, "w-full max-w-lg")}>
        <header className={phxFormBlockHeaderClassName}>
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{systemIdentity.appName}</span>
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">ChatGPT connector</span>
        </header>
        <div className="px-5 py-6">{children}</div>
      </section>
    </main>
  );
}

export default async function ConnectorAuthorizePage({ searchParams }: PageProps) {
  const raw = (await searchParams) ?? {};
  const params: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    const value = Array.isArray(raw[key]) ? raw[key]?.[0] : raw[key];
    if (typeof value === "string" && value.length <= 2_048) params[key] = value;
  }

  const access = await resolveAccessContextFromPage();
  if (!access.loginId) {
    const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
    redirect(`/login?returnUrl=${encodeURIComponent(`/connector/authorize?${query.toString()}`)}`);
  }

  if (!isConnectorRole(access.role) || access.testPersona || access.seatView) {
    return (
      <Shell>
        <h1 className="text-lg font-bold text-slate-900">ChatGPT cannot be connected from this account</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Only the owner and the CEO can connect ChatGPT to {systemIdentity.appName}, from their own account.
        </p>
      </Shell>
    );
  }

  let clientName: string | null = null;
  try {
    clientName = (await connectorOAuth().validateAuthorizeRequest(params)).clientName;
  } catch (error) {
    const message = error instanceof OAuthError ? error.description : "Phoenix could not read this request. Start again from ChatGPT.";
    return (
      <Shell>
        <h1 className="text-lg font-bold text-slate-900">This link cannot be used</h1>
        <p className={cn(phxFormErrorClassName, "mt-3")}>{message}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ConnectorConsent params={params} clientName={clientName ?? "ChatGPT"} role={access.role} />
    </Shell>
  );
}
