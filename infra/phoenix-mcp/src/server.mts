import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Config } from './config.mts';
import type { ReadStore, Principal } from './contracts.mts';
import { scope } from './contracts.mts';
import { OAuthProvider, type IdentityProvider } from './oauth.mts';
import { Authorizer } from './policy.mts';
import { StateStore } from './state.mts';
import { ToolService, createMcp, type Audit } from './tools.mts';

export function createApp(c:Config,db:ReadStore,state:StateStore,upstream:IdentityProvider,audit:Audit){
  const app=express();
  // Apply our small parser limit BEFORE any SDK router parses a request body.
  app.use(hostHeaderValidation([new URL(c.resource).hostname,'localhost','127.0.0.1']));
  app.disable('x-powered-by');
  app.set('trust proxy',false);
  let count=0,start=Date.now(),inflight=0;
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if(req.path==='/healthz')return next();
    // Global budget is intentionally sufficient for ONE owner and does not trust forwarded IPs.
    if(Date.now()-start>=60000){count=0;start=Date.now();}
    if(++count>120){res.set('Retry-After','60');res.status(429).json({error:'rate_limited'});return;}
    const origin=req.headers.origin;
    if(origin && origin!==c.issuer){res.status(403).json({error:'origin_rejected'});return;}
    next();
  });
  app.get('/healthz',(_req,res)=>res.json({status:'ok',service:'phoenix-mcp'}));
  app.use(express.json({limit:'16kb',inflate:false}));
  app.use(express.urlencoded({extended:false,limit:'4kb',inflate:false,parameterLimit:20}));
  app.get('/readyz',async(_req,res)=>{try{await db.ready();res.json({status:'ready'});}catch{res.status(503).json({status:'unavailable'});}});
  const auth=new Authorizer(db,c.owner),provider=new OAuthProvider(c,state,auth,upstream);
  const service=new ToolService(db,auth,state,audit);
  app.use(mcpAuthRouter({provider,issuerUrl:new URL(c.issuer),resourceServerUrl:new URL(c.resource),scopesSupported:[scope],resourceName:'Phoenix Workforce — Read Only'}));
  app.get('/oauth/callback',async(req,res)=>{try{await provider.callback(req,res);}catch{res.status(403).json({error:'authentication_failed'});}});
  app.post('/oauth/consent',express.urlencoded({extended:false,limit:'4kb'}),async(req,res)=>{try{await provider.consent(req,res);}catch{res.status(403).json({error:'consent_failed'});}});
  app.post('/mcp',requireBearerAuth({verifier:provider,requiredScopes:[scope],resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(new URL(c.resource))}),express.json({limit:'16kb'}),async(req,res)=>{
    if(inflight>=2){res.status(429).json({error:'busy'});return;}
    inflight++;
    const principal=req.auth?.extra?.principal as Principal|undefined;
    if(!principal){inflight--;res.status(401).end();return;}
    const server=createMcp(service,principal);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    let cleaned=false;
    const cleanup=()=>{if(cleaned)return;cleaned=true;inflight--;void transport.close();void server.close();};
    res.on('close',cleanup);
    try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch{if(!res.headersSent)res.status(500).json({error:'unavailable'});}
    finally{if(res.writableEnded)cleanup();}
  });
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  app.use((_req,res)=>res.status(404).json({error:'not_found'}));
  app.use((_err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:'invalid_request'}));
  return {app,provider,service};
}
