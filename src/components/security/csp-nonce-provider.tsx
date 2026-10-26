"use client";

import * as React from "react";

import { documentScriptNonce } from "@/lib/security/csp-nonce";

/**
 * Hands the page's script nonce (src/lib/security/content-security-policy.ts) to the client
 * components that need it: a next/script tag and the frames that show our own rendered HTML.
 *
 * The root layout reads the nonce from the request and passes it in, so the SERVER render of a
 * client component has it too — next/script asks the browser to preload its file during that render,
 * with the nonce. In the browser the nonce the document was SERVED with wins (`documentScriptNonce`),
 * because a refresh re-renders the root layout with a new request's nonce that the document's policy
 * has never heard of.
 */
const CspNonceContext = React.createContext<string | undefined>(undefined);

export function CspNonceProvider({ nonce, children }: { nonce: string | undefined; children: React.ReactNode }) {
  return <CspNonceContext.Provider value={nonce}>{children}</CspNonceContext.Provider>;
}

export function useCspNonce(): string | undefined {
  const fromServer = React.useContext(CspNonceContext);
  if (typeof window === "undefined") return fromServer;
  return documentScriptNonce() ?? fromServer;
}
