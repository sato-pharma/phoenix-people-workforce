// Source-side refresh loop. NOT part of the reader image and NOT started by anything in this branch.
// Runs inside an approved Phoenix source process; needs Phoenix service credentials (never given to
// the reader) plus the restricted publisher login for the isolated reporting database.
//
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./tests/alias-loader.mjs infra/phoenix-mcp/source/run-publisher.mjs
//
// Refuses to run unless explicitly enabled, publishes only complete proven datasets, withdraws a
// sales month only on a proven absence, and does nothing at all while the owner is not authorized.
import postgres from 'postgres';
import { publishProjection,withdrawProjection } from '../src/publisher.mts';
import { runPublishCycle } from '../src/publish-cycle.mts';
import { createPhoenixCollector,liveOwnerIdentity } from './phoenix-bindings.mjs';

const env=process.env;
if(env.PHOENIX_MCP_PUBLISHER_ENABLED!=='true')throw new Error('Set PHOENIX_MCP_PUBLISHER_ENABLED=true in an approved environment to run the publisher.');
const owner={subject:env.PHOENIX_MCP_OWNER_SUBJECT,loginId:env.PHOENIX_MCP_OWNER_LOGIN_ID,role:env.PHOENIX_MCP_OWNER_ROLE};
const c={owner,contractRevision:env.PHOENIX_MCP_CONTRACT_REVISION};
const periods=(env.PHOENIX_MCP_SALES_PERIODS??'').split(',').map(p=>p.trim()).filter(Boolean);
const intervalMs=Math.max(15_000,Number(env.PHOENIX_MCP_REFRESH_SECONDS??30)*1000);
const url=new URL(env.PHOENIX_MCP_PUBLISHER_DATABASE_URL);
if(decodeURIComponent(url.username).split('.')[0]!=='phoenix_mcp_publisher')throw new Error('A dedicated publisher login is required');
const sql=postgres(url.href,{max:1,prepare:false,ssl:{rejectUnauthorized:true,...(env.PHOENIX_MCP_DATABASE_CA?{ca:env.PHOENIX_MCP_DATABASE_CA}:{})},connection:{application_name:'phoenix-mcp-publisher'}});
for(;;){
 const started=Date.now();
 try{
  const identity=await liveOwnerIdentity(owner.subject);
  if(identity&&identity.active){
   const collect=createPhoenixCollector(identity);
   const outcomes=await runPublishCycle({collect,publish:(d,p,pr)=>publishProjection(sql,c,d,p,pr),withdraw:(d,p)=>withdrawProjection(sql,c,d,p)},periods);
   // Codes only: no row values, identifiers or Phoenix messages.
   console.log(JSON.stringify({event:'mcp_publish_cycle',outcomes}));
  }else console.log(JSON.stringify({event:'mcp_publish_cycle',skipped:'owner_not_authorized'}));
 }catch{console.log(JSON.stringify({event:'mcp_publish_cycle',skipped:'owner_authorization_undecidable'}));}
 await new Promise(r=>setTimeout(r,Math.max(1000,intervalMs-(Date.now()-started))));
}
