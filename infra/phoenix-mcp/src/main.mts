import { configFromEnv } from './config.mts';
import { createReadStore } from './database.mts';
import { StateStore } from './state.mts';
import { createIdentityProvider } from './oauth.mts';
import { createApp } from './server.mts';
import type { ReadStore } from './contracts.mts';
import { createLiveAuthorization } from './live-authorization.mts';

// Startup is deliberately fail-closed. Importing tests never runs this entry point.
let store:ReadStore|undefined;
try{
  const c=configFromEnv(process.env), db=createReadStore(c,createLiveAuthorization(c));store=db;
  await db.ready();
  const upstream=await createIdentityProvider(c), state=new StateStore(c.statePath);
  const {app}=createApp(c,db,state,upstream,event=>{process.stdout.write(JSON.stringify(event)+'\n');});
  const server=app.listen(c.port,'0.0.0.0');
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxRequestsPerSocket=100;
  const stop=()=>{server.close();void db.close().finally(()=>{state.close();process.exit(0);});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch{
  // Never emit connection strings, provider payloads or a driver error with SQL/data.
  process.stderr.write('Phoenix MCP refused startup. Check the approved configuration and read-only database contract.\n');
  await store?.close();
  process.exitCode=1;
}
