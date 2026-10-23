# Approval-gated release and operations

Nothing in this document authorizes execution against production. Resolve SECURITY.md's HOLD first.

## Railway requirements

Create a **new** service after explicit approval. Keep existing Phoenix services unchanged. Use the
repository root build context and Dockerfile `infra/phoenix-mcp/Dockerfile`. Its deploy settings —
builder `DOCKERFILE`, `dockerfilePath: "infra/phoenix-mcp/Dockerfile"`, one replica, healthcheck
`/readyz` with a 60 s window, restart policy `ON_FAILURE` with 3 retries — are declared as a
`service("phoenix-mcp", …)` block in `.railway/railway.ts` in the same approved change. Railway
deprecated `railway.toml` (the file that used to hold them was retired on 2026-10-23), and
`tests/railway-deploy-config.test.ts` refuses one coming back. Never add the block ahead of that
approval: an apply of `.railway/railway.ts` would create the service. Keep the service in Europe. Select the reviewed commit explicitly;
disable automatic releases until authorized. One replica only, initial 512 MB memory ceiling and
0.5 vCPU ceiling subject to fixture measurement. Mount a dedicated persistent volume at `/state`,
writable by the image's `node` user, with directory permissions restricted to that user.

Give the new service only its own configuration. Do not share Phoenix's environment group or inject
its service-role key. A valid HTTPS hostname, outbound access to the approved OIDC issuer/JWKS and
TLS database endpoint are required. Startup fails if the owner/revision contract or effective grants
are wrong. `/healthz` is liveness only; `/readyz` validates database readiness. Set platform health
checks to `/readyz`. Use a verified CA chain; never disable TLS verification to make a pooler connect.

Build command from repository root, for an isolated build host:

```sh
docker build -f infra/phoenix-mcp/Dockerfile -t phoenix-mcp:review .
```

The image never copies environment files or the root node_modules. Runtime contains only the
bundled integration and production dependencies. Container build/start against Railway has not
been verified yet; it is a release gate, not a deployment claim.

## Required environment variables — names only

```text
PHOENIX_MCP_ENABLED
PHOENIX_MCP_PUBLIC_URL
PHOENIX_MCP_OWNER_SUBJECT
PHOENIX_MCP_OWNER_LOGIN_ID
PHOENIX_MCP_OWNER_ROLE
PHOENIX_MCP_DATABASE_URL
PHOENIX_MCP_DATABASE_ROLE
PHOENIX_MCP_CONTRACT_REVISION
PHOENIX_MCP_CLIENT_ID
PHOENIX_MCP_REDIRECT_URI
PHOENIX_MCP_OIDC_ISSUER
PHOENIX_MCP_OIDC_CLIENT_ID
PHOENIX_MCP_OIDC_CLIENT_SECRET
PHOENIX_MCP_STATE_PATH
PHOENIX_MCP_NODE_ID_KEY
PHOENIX_MCP_DATABASE_CA
PHOENIX_MCP_AUTHORIZATION_URL
PHOENIX_MCP_AUTHORIZATION_KEY
PORT
```

No environment file is created. No OpenAI API key or Supabase service-role credential is required
by this service. The database credential and upstream confidential-client secret stay server-side.
The ChatGPT client identifier is public. The upstream OIDC client secret is never entered into ChatGPT.
`PHOENIX_MCP_DATABASE_CA` is optional when the endpoint already chains to a trusted public CA.
The source publisher uses a separate credential, never the reader's environment or account. Source-host
variables (NOT in the reader): PHOENIX_MCP_SOURCE_ENABLED, PHOENIX_MCP_SOURCE_AUTHORIZATION_KEY (the same
value as the reader's PHOENIX_MCP_AUTHORIZATION_KEY), PHOENIX_MCP_OWNER_SUBJECT, PHOENIX_MCP_PUBLISHER_ENABLED,
PHOENIX_MCP_PUBLISHER_DATABASE_URL, PHOENIX_MCP_SALES_PERIODS, PHOENIX_MCP_REFRESH_SECONDS.
See `proposal/SOURCE-INTERFACE.md` and `proposal/IDENTITY.md` for concrete approval gates.

## Exact ChatGPT connection procedure — after approval and staging acceptance

Current official instructions: [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [OAuth authentication](https://developers.openai.com/plugins/build/auth).

1. Complete SECURITY.md's source and identity gates; verify a staging endpoint first. Confirm owner-only
   authentication, all five tools, negative-role tests, revocation and source reconciliation.
2. Prepare the personal ChatGPT connection's static client ID and exact callback URI. Copy the URI
   ChatGPT shows; register exactly that URI in this service, with no wildcard or guessed path. The
   upstream provider separately registers this service's `/oauth/callback`. These are distinct clients.
3. In ChatGPT on the web, open **Plugins**, select **+**, then **Add custom MCP server**.
4. Name it **Phoenix Workforce — Private Read Only**. Under Connection, enter the approved HTTPS
   URL ending `/mcp`. Choose **OAuth**, using the configured static public client ID. Choose public
   client/no token-endpoint secret where offered. Do not choose unauthenticated or mixed access.
   If the workspace UI requires a confidential client secret, stop for an interoperability update;
   do not paste the upstream secret or enable DCR to work around it.
5. Review the warning and choose **Create as a plugin** in personal scope. Install only for the owner.
   Do not publish, distribute to a workspace, enable other users or upload a public listing.
6. Sign in through the approved Phoenix identity provider and approve this service's explicit read-only
   consent. If subject/login/role is not the configured owner, authorization must fail.
7. Verify that exactly the five tools in README.md appear. Use `@` to select the personal plugin and
   ask for the active employee count. Compare the response with Phoenix for the same authorized scope.
   Test one published sales period and one unpublished period; the latter must not become zero sales.
8. Revoke the connection and confirm old access/refresh tokens fail, then reconnect if approved.
   Record the released commit, contract revision and verification evidence without any credentials.

These steps require the workspace to permit custom MCP plugins. The actual owner's ChatGPT UI and
provider compatibility have not been exercised. Current docs support static credentials, CIMD or
DCR; this service intentionally supports only pre-registration for personal use.

## Estimated incremental cost

Budget **about US$3–8/month for the small MCP container and a small state volume**, assuming average
0.25–0.5 GB RAM, 0.02–0.1 vCPU and low personal traffic. This is an estimate, not a measurement.
Railway lists $10/GB-month RAM, $20/vCPU-month CPU, $0.15/GB-month volume and $0.05/GB egress;
existing plan credits may cover some usage. See [Railway pricing](https://docs.railway.com/pricing/plans).

This excludes any separate reporting database, identity-provider charge, Secure MCP Tunnel runtime,
ChatGPT subscription, or plan upgrade. The source-isolation decision is unresolved, so the total
integration cost cannot honestly be fixed yet. No service was provisioned and no new bill was created.

## Emergency shutdown and rollback

The following are proposed incident actions and still require authority to operate that environment:

1. Stop only the new MCP service (or its tunnel). This immediately blocks new requests; an in-flight
   read is bounded by the database timeout. Disable the personal ChatGPT plugin as well.
2. If a credential may be compromised, revoke the dedicated database login and upstream MCP client;
   rotate only those integration credentials. Terminate only database sessions belonging to that
   dedicated role/application. Do not stop Phoenix or rotate shared Phoenix keys incidentally.
3. For token-only revocation, use OAuth `/revoke` for the token family. A Phoenix account disable,
   session-version change or role change also blocks subsequent checks, but changes to the owner's
   primary Phoenix account have wider effects and are not the first shutdown choice.
4. Roll back the new service to the previous reviewed image only when its source contract remains
   compatible. Stop the service before replacing/removing its OAuth state; all connections must sign
   in again. **Never restore an old OAuth-state backup**, which could undo revocation.
5. Preserve sanitized audit logs. Disable external access before investigating. Do not drop source
   objects/roles until dependencies have been reviewed; removing grants is itself a production change.

There is no Phoenix business-data rollback: this integration must never write business data. Removing
its branch/package or stopping its separate service does not require reverting Phoenix business logic.
