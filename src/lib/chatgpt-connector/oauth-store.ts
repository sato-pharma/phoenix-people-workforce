/**
 * The Supabase store behind the ChatGPT connector's sign-in (oauth.ts). Server only: the four tables
 * (migration 20261117130928_chatgpt_connector_oauth.sql) have RLS on with no policy, so only the
 * service role reads them. Tokens and codes are stored as SHA-256 fingerprints, never in plain text.
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { ClientRow, CodeRow, ConnectorOAuthStore, TokenRow } from "./oauth";
import type { ConnectorRole } from "./types";

type TokenDbRow = {
  token_hash: string;
  kind: "access" | "refresh";
  family_id: string;
  client_id: string;
  login_id: string;
  hr_id: string | null;
  role: string;
  session_version: number;
  resource: string;
  scope: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

type CodeDbRow = {
  client_id: string;
  login_id: string;
  hr_id: string | null;
  role: string;
  session_version: number;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
};

const TOKEN_COLUMNS = "token_hash,kind,family_id,client_id,login_id,hr_id,role,session_version,resource,scope,expires_at,used_at,revoked_at";
const CODE_COLUMNS = "client_id,login_id,hr_id,role,session_version,redirect_uri,code_challenge,resource,scope";

function toToken(row: TokenDbRow): TokenRow {
  return {
    tokenHash: row.token_hash,
    kind: row.kind,
    familyId: row.family_id,
    clientId: row.client_id,
    loginId: row.login_id,
    hrId: row.hr_id,
    role: row.role as ConnectorRole,
    sessionVersion: Number(row.session_version),
    resource: row.resource,
    scope: row.scope,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
  };
}

function toCode(row: CodeDbRow): CodeRow {
  return {
    clientId: row.client_id,
    loginId: row.login_id,
    hrId: row.hr_id,
    role: row.role as ConnectorRole,
    sessionVersion: Number(row.session_version),
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
  };
}

export function createSupabaseConnectorStore(db = getSupabaseAdmin()): ConnectorOAuthStore {
  return {
    async insertClient(row: ClientRow) {
      const { error } = await db.from("connector_oauth_clients").insert(row);
      if (error) throw error;
    },

    async getClient(clientId: string) {
      const { data, error } = await db
        .from("connector_oauth_clients")
        .select("client_id,client_name,redirect_uris")
        .eq("client_id", clientId)
        .maybeSingle();
      if (error) throw error;
      return (data as ClientRow | null) ?? null;
    },

    async insertCode(codeHash: string, row: CodeRow, expiresAt: string) {
      const { error } = await db.from("connector_oauth_codes").insert({
        code_hash: codeHash,
        client_id: row.clientId,
        login_id: row.loginId,
        hr_id: row.hrId,
        role: row.role,
        session_version: row.sessionVersion,
        redirect_uri: row.redirectUri,
        code_challenge: row.codeChallenge,
        resource: row.resource,
        scope: row.scope,
        expires_at: expiresAt,
      });
      if (error) throw error;
    },

    async consumeCode(codeHash: string, nowIso: string) {
      // One UPDATE that still finds the row unused and unexpired: two exchanges of one code cannot both win.
      const { data, error } = await db
        .from("connector_oauth_codes")
        .update({ used_at: nowIso })
        .eq("code_hash", codeHash)
        .is("used_at", null)
        .gt("expires_at", nowIso)
        .select(CODE_COLUMNS);
      if (error) throw error;
      const rows = (data ?? []) as CodeDbRow[];
      return rows.length === 1 ? toCode(rows[0]) : null;
    },

    async insertTokens(rows) {
      const { error } = await db.from("connector_oauth_tokens").insert(
        rows.map((row) => ({
          token_hash: row.tokenHash,
          kind: row.kind,
          family_id: row.familyId,
          client_id: row.clientId,
          login_id: row.loginId,
          hr_id: row.hrId,
          role: row.role,
          session_version: row.sessionVersion,
          resource: row.resource,
          scope: row.scope,
          expires_at: row.expiresAt,
        })),
      );
      if (error) throw error;
    },

    async findToken(tokenHash: string) {
      const { data, error } = await db.from("connector_oauth_tokens").select(TOKEN_COLUMNS).eq("token_hash", tokenHash).maybeSingle();
      if (error) throw error;
      return data ? toToken(data as TokenDbRow) : null;
    },

    async spendRefreshToken(tokenHash: string, nowIso: string) {
      const { data, error } = await db
        .from("connector_oauth_tokens")
        .update({ used_at: nowIso, last_used_at: nowIso })
        .eq("token_hash", tokenHash)
        .eq("kind", "refresh")
        .is("used_at", null)
        .is("revoked_at", null)
        .gt("expires_at", nowIso)
        .select(TOKEN_COLUMNS);
      if (error) throw error;
      const rows = (data ?? []) as TokenDbRow[];
      return rows.length === 1 ? toToken(rows[0]) : null;
    },

    async revokeFamily(familyId: string, reason: string, nowIso: string) {
      const { error } = await db
        .from("connector_oauth_tokens")
        .update({ revoked_at: nowIso, revoked_reason: reason })
        .eq("family_id", familyId)
        .is("revoked_at", null);
      if (error) throw error;
    },
  };
}

/** Best-effort "last used" stamp on an access token, at most once a minute per token. */
const lastTouched = new Map<string, number>();
export async function touchAccessToken(tokenHash: string, db = getSupabaseAdmin()) {
  const nowMs = Date.now();
  if ((lastTouched.get(tokenHash) ?? 0) > nowMs - 60_000) return;
  lastTouched.set(tokenHash, nowMs);
  if (lastTouched.size > 500) lastTouched.clear();
  await db.from("connector_oauth_tokens").update({ last_used_at: new Date(nowMs).toISOString() }).eq("token_hash", tokenHash);
}
