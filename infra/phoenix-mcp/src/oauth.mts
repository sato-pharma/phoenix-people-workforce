import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { Authorizer } from './policy.mts';
import { StateStore, digest, randomToken, type Grant } from './state.mts';
import { scope, type Principal } from './contracts.mts';
import type { Config } from './config.mts';

type Pending = { clientId:string; redirect:string; state?:string; challenge:string; verifier:string; nonce:string; browser:string };
type Code = { clientId:string; redirect:string; challenge:string; principal:Principal };
type Consent = { pending:Pending; principal:Principal };
export interface IdentityProvider {
  authorization(input:{state:string;nonce:string;challenge:string}): string;
  exchange(code:string,verifier:string,nonce:string):Promise<string>;
}
export async function createIdentityProvider(c: Config, request:typeof fetch=fetch): Promise<IdentityProvider> {
  const issuer = c.oidcIssuer.replace(/\/$/,'');
  const response=await request(`${issuer}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok) throw new Error('Identity discovery unavailable');
  const metadata=await response.json() as Record<string, unknown>;
  const endpoint=(key:string)=>{
    const value=metadata[key]; if(typeof value!=='string') throw new Error('Invalid identity metadata');
    const u=new URL(value);
    if(u.protocol!=='https:' || u.origin!==new URL(issuer).origin || u.username || u.password) throw new Error('Untrusted identity endpoint');
    return u.href;
  };
  if(metadata.issuer!==issuer || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) throw new Error('PKCE identity provider required');
  const authorize=endpoint('authorization_endpoint'), token=endpoint('token_endpoint');
  const jwks=createRemoteJWKSet(new URL(endpoint('jwks_uri')),{timeoutDuration:5000,cooldownDuration:1000,[customFetch]:request});
  return {
    authorization({state,nonce,challenge}){
      const u=new URL(authorize);
      for(const [k,v] of Object.entries({client_id:c.oidcClientId,redirect_uri:c.callback,response_type:'code',scope:'openid',state,nonce,code_challenge:challenge,code_challenge_method:'S256',prompt:'login'}))u.searchParams.set(k,v);
      return u.href;
    },
    async exchange(code,verifier,nonce){
      const r=await request(token,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:c.callback,client_id:c.oidcClientId,client_secret:c.oidcClientSecret})});
      if(!r.ok)throw new InvalidGrantError('Identity verification failed');
      const body=await r.json() as {id_token?:string};
      if(typeof body.id_token!=='string')throw new InvalidGrantError('Missing identity proof');
      const {payload}=await jwtVerify(body.id_token,jwks,{issuer,audience:c.oidcClientId,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat','nonce'],maxTokenAge:'5m'});
      if(payload.nonce!==nonce || !payload.sub || (Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==c.oidcClientId) || (payload.azp!==undefined&&payload.azp!==c.oidcClientId))throw new InvalidGrantError('Identity verification failed');
      // Upstream access/refresh tokens are discarded, never relayed to ChatGPT or used for SQL.
      return payload.sub;
    },
  };
}
function cookie(req:Request){return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-phx-mcp='))?.slice('__Host-phx-mcp='.length);}
const principalOf=(p:Principal):Principal=>({subject:p.subject,loginId:p.loginId,role:p.role,sessionVersion:p.sessionVersion});
export class OAuthProvider implements OAuthServerProvider {
  // The SDK otherwise consumes PKCE and passes undefined to exchangeAuthorizationCode.
  // We perform S256 validation atomically with code consumption in that method.
  readonly skipLocalPkceValidation=true;
  readonly clientsStore;
  constructor(private readonly c:Config, private readonly state:StateStore, private readonly auth:Authorizer, private readonly upstream:IdentityProvider) {
    const client:OAuthClientInformationFull={client_id:c.clientId,redirect_uris:[c.redirectUri],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope};
    this.clientsStore={getClient:async(id:string)=>id===c.clientId?client:undefined};
  }
  private resource(resource?:URL){if(resource?.href!==this.c.resource)throw new InvalidRequestError('Incorrect resource');}
  async authorize(client:OAuthClientInformationFull,p:AuthorizationParams,res:Response){
    this.resource(p.resource);
    if(client.client_id!==this.c.clientId || p.redirectUri!==this.c.redirectUri || p.scopes?.join(' ')!==scope || !/^[A-Za-z0-9_-]{43}$/.test(p.codeChallenge))throw new InvalidRequestError('Invalid authorization request');
    const key=randomToken(),verifier=randomToken(),nonce=randomToken(),browser=randomToken();
    this.state.put('pending',key,{clientId:client.client_id,redirect:p.redirectUri,state:p.state,challenge:p.codeChallenge,verifier,nonce,browser:digest(browser)} satisfies Pending,300);
    res.cookie('__Host-phx-mcp',browser,{secure:true,httpOnly:true,sameSite:'lax',path:'/',maxAge:300000});
    res.redirect(this.upstream.authorization({state:key,nonce,challenge:digest(verifier)}));
  }
  async callback(req:Request,res:Response){
    const key=typeof req.query.state==='string'?req.query.state:'';
    const pending=this.state.take<Pending>('pending',key);
    if(!pending || pending.browser!==digest(cookie(req)??'') || typeof req.query.code!=='string' || req.query.code.length>4096)throw new InvalidGrantError('Invalid authentication callback');
    const subject=await this.upstream.exchange(req.query.code,pending.verifier,pending.nonce);
    const principal=principalOf(await this.auth.verify(subject));
    const ticket=randomToken();
    this.state.put('consent',ticket,{pending,principal} satisfies Consent,180);
    res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // All interpolated values are locally generated base64url. No identity/database text is HTML.
    res.type('html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phoenix read-only access</title><main><h1>Connect Phoenix Workforce</h1><p>Allow your private ChatGPT connection to read authorized workforce summaries, active employee counts, vacancies, organizational structure and published sales. Payroll, bank details, national IDs, medical information and attachments are excluded. No business data can be changed.</p><form method="post" action="/oauth/consent"><input type="hidden" name="ticket" value="${ticket}"><button name="decision" value="approve">Approve read-only access</button> <button name="decision" value="deny">Deny</button></form></main></html>`);
  }
  async consent(req:Request,res:Response){
    if(req.headers.origin!==this.c.issuer || typeof req.body.ticket!=='string')throw new InvalidRequestError('Invalid consent');
    const consent=this.state.take<Consent>('consent',req.body.ticket);
    if(!consent || consent.pending.browser!==digest(cookie(req)??''))throw new InvalidGrantError('Expired consent');
    const u=new URL(consent.pending.redirect);
    if(consent.pending.state)u.searchParams.set('state',consent.pending.state);
    if(req.body.decision==='approve'){
      await this.auth.verify(consent.principal.subject,consent.principal);
      const code=randomToken();
      this.state.put('code',code,{clientId:consent.pending.clientId,redirect:consent.pending.redirect,challenge:consent.pending.challenge,principal:consent.principal} satisfies Code,60);
      u.searchParams.set('code',code);
    }else{u.searchParams.set('error','access_denied');}
    res.clearCookie('__Host-phx-mcp',{secure:true,httpOnly:true,sameSite:'lax',path:'/'});
    res.redirect(u.href);
  }
  async challengeForAuthorizationCode(client:OAuthClientInformationFull,code:string){
    const row=this.state.get<Code>('code',code);
    if(!row || row.clientId!==client.client_id)throw new InvalidGrantError('Invalid code');
    return row.challenge;
  }
  private async issue(principal:Principal,family=randomToken(),expiresAt=Date.now()+86400000){
    await this.auth.verify(principal.subject,principal);
    if(expiresAt<=Date.now() || this.state.isRevoked(family))throw new InvalidGrantError('Grant expired');
    const access=randomToken(),refresh=randomToken();
    const grant:Grant={principal,clientId:this.c.clientId,resource:this.c.resource,family,expiresAt,accessExpiresAt:Math.min(Date.now()+300000,expiresAt)};
    const remaining=Math.floor((expiresAt-Date.now())/1000);
    this.state.put('access',access,grant,Math.min(300,remaining));
    this.state.put('refresh',refresh,grant,remaining);
    return {access_token:access,token_type:'Bearer',expires_in:Math.min(300,remaining),refresh_token:refresh,scope};
  }
  async exchangeAuthorizationCode(client:OAuthClientInformationFull,code:string,verifier?:string,redirect?:string,resource?:URL){
    this.resource(resource);
    const row=this.state.take<Code>('code',code);
    if(!row || row.clientId!==client.client_id || row.redirect!==redirect || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || digest(verifier)!==row.challenge)throw new InvalidGrantError('Invalid code');
    return this.issue(row.principal);
  }
  async exchangeRefreshToken(client:OAuthClientInformationFull,token:string,scopes?:string[],resource?:URL){
    this.resource(resource);
    if(scopes && scopes.join(' ')!==scope)throw new InvalidGrantError('Invalid scope');
    const replay=this.state.get<Grant>('used-refresh',token);
    if(replay){this.state.revokeFamily(replay.family);throw new InvalidGrantError('Refresh token reused');}
    const grant=this.state.take<Grant>('refresh',token);
    if(!grant || grant.clientId!==client.client_id || this.state.isRevoked(grant.family))throw new InvalidGrantError('Invalid refresh token');
    this.state.put('used-refresh',token,grant,86400);
    return this.issue(grant.principal,grant.family,grant.expiresAt);
  }
  async verifyAccessToken(token:string){
    const grant=this.state.get<Grant>('access',token);
    if(!grant || grant.resource!==this.c.resource || grant.expiresAt<=Date.now() || this.state.isRevoked(grant.family))throw new InvalidTokenError('Invalid access token');
    try{await this.auth.verify(grant.principal.subject,grant.principal);}catch{throw new InvalidTokenError('Authorization revoked');}
    return {token,clientId:grant.clientId,scopes:[scope],expiresAt:Math.floor(grant.accessExpiresAt/1000),resource:new URL(this.c.resource),extra:{principal:grant.principal}};
  }
  async revokeToken(client:OAuthClientInformationFull,request:{token:string}){
    const grant=this.state.get<Grant>('access',request.token)??this.state.get<Grant>('refresh',request.token)??this.state.get<Grant>('used-refresh',request.token);
    if(grant?.clientId===client.client_id && !this.state.isRevoked(grant.family))this.state.revokeFamily(grant.family);
  }
}
