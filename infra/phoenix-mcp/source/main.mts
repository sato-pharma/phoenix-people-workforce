import { z } from 'zod';
import { decodeJwt } from 'jose';
import { createSourceApp } from './server.mts';
// Opt-in service. No dotenv and no fallback to the Phoenix administrative credential.
try{
 const e=z.object({PHOENIX_MCP_SOURCE_ENABLED:z.literal('true'),PHOENIX_MCP_SOURCE_URL:z.string().url(),PHOENIX_MCP_SOURCE_READ_KEY:z.string().min(32),PHOENIX_MCP_AUTHORIZATION_KEY:z.string().min(32),PHOENIX_MCP_OWNER_SUBJECT:z.string().uuid(),PHOENIX_MCP_OWNER_LOGIN_ID:z.string().min(1),PHOENIX_MCP_OWNER_ROLE:z.enum(['Super Admin','CEO']),PORT:z.coerce.number().int().min(1024).max(65535).default(8081)}).parse(process.env);
 if(process.env.SUPABASE_SERVICE_ROLE_KEY||decodeJwt(e.PHOENIX_MCP_SOURCE_READ_KEY).role!=='phoenix_mcp_source_reader')throw Error('Dedicated source credential required');
 const app=createSourceApp({origin:e.PHOENIX_MCP_SOURCE_URL,credential:e.PHOENIX_MCP_SOURCE_READ_KEY,secret:e.PHOENIX_MCP_AUTHORIZATION_KEY,owner:{subject:e.PHOENIX_MCP_OWNER_SUBJECT,loginId:e.PHOENIX_MCP_OWNER_LOGIN_ID,role:e.PHOENIX_MCP_OWNER_ROLE}});
 const server=app.listen(e.PORT,'0.0.0.0');server.requestTimeout=50000;server.headersTimeout=10000;
}catch{process.stderr.write('Phoenix MCP source refused startup.\n');process.exitCode=1;}
