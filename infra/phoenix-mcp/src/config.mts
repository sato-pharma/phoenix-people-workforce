import { z } from 'zod';

const https = z.string().url().refine(v => {
  const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
}, 'An HTTPS URL without credentials, query or fragment is required');
export function configFromEnv(env: NodeJS.ProcessEnv) {
  // Deliberately no dotenv loader. The repository's .env.local points at production.
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'PHOENIX_AUTH_SECRET', 'DATABASE_URL']) {
    if (env[name]) throw new Error(`Remove unrelated privileged environment variable: ${name}`);
  }
  const c = z.object({
    PHOENIX_MCP_ENABLED: z.literal('true'),
    PHOENIX_MCP_PUBLIC_URL: https,
    PHOENIX_MCP_OWNER_SUBJECT: z.string().uuid(),
    PHOENIX_MCP_OWNER_LOGIN_ID: z.string().min(1).max(100),
    PHOENIX_MCP_OWNER_ROLE: z.enum(['Super Admin', 'CEO']),
    PHOENIX_MCP_DATABASE_URL: z.string().url(),
    PHOENIX_MCP_DATABASE_ROLE: z.literal('phoenix_mcp_reader'),
    PHOENIX_MCP_CONTRACT_REVISION: z.string().regex(/^[a-f0-9]{40}$/),
    PHOENIX_MCP_CLIENT_ID: z.string().min(8),
    PHOENIX_MCP_REDIRECT_URI: https,
    PHOENIX_MCP_OIDC_ISSUER: https,
    PHOENIX_MCP_OIDC_CLIENT_ID: z.string().min(1),
    PHOENIX_MCP_OIDC_CLIENT_SECRET: z.string().min(16),
    PHOENIX_MCP_STATE_PATH: z.string().min(1),
    PHOENIX_MCP_NODE_ID_KEY:z.string().min(32),
    PHOENIX_MCP_DATABASE_CA:z.string().min(1).optional(),
    PHOENIX_MCP_AUTHORIZATION_URL:https,
    PHOENIX_MCP_AUTHORIZATION_KEY:z.string().min(32),
    PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
  }).parse(env);
  const db = new URL(c.PHOENIX_MCP_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.search) throw new Error('Invalid restricted database URL');
  if (decodeURIComponent(db.username).split('.')[0] !== c.PHOENIX_MCP_DATABASE_ROLE) throw new Error('A dedicated reader login is required');
  if (new URL(c.PHOENIX_MCP_PUBLIC_URL).pathname !== '/mcp') throw new Error('Public resource URL must end in /mcp');
  const callback = new URL('/oauth/callback', c.PHOENIX_MCP_PUBLIC_URL).href;
  return {
    resource: c.PHOENIX_MCP_PUBLIC_URL, issuer: new URL(c.PHOENIX_MCP_PUBLIC_URL).origin,
    owner: {subject:c.PHOENIX_MCP_OWNER_SUBJECT,loginId:c.PHOENIX_MCP_OWNER_LOGIN_ID,role:c.PHOENIX_MCP_OWNER_ROLE},
    databaseUrl: c.PHOENIX_MCP_DATABASE_URL, databaseRole:c.PHOENIX_MCP_DATABASE_ROLE,
    contractRevision:c.PHOENIX_MCP_CONTRACT_REVISION, clientId:c.PHOENIX_MCP_CLIENT_ID, redirectUri:c.PHOENIX_MCP_REDIRECT_URI,
    oidcIssuer:c.PHOENIX_MCP_OIDC_ISSUER, oidcClientId:c.PHOENIX_MCP_OIDC_CLIENT_ID,
    oidcClientSecret:c.PHOENIX_MCP_OIDC_CLIENT_SECRET, callback,
    statePath:c.PHOENIX_MCP_STATE_PATH, port:c.PORT,
    nodeIdKey:c.PHOENIX_MCP_NODE_ID_KEY, databaseCa:c.PHOENIX_MCP_DATABASE_CA,
    authorizationUrl:c.PHOENIX_MCP_AUTHORIZATION_URL, authorizationKey:c.PHOENIX_MCP_AUTHORIZATION_KEY,
  };
}
export type Config = ReturnType<typeof configFromEnv>;
