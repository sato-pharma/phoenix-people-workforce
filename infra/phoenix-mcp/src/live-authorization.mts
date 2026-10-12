import { randomUUID } from 'node:crypto';
import { identitySchema, Unavailable } from './contracts.mts';
import type { Config } from './config.mts';

// Dedicated owner-only source interface. Never consult a projection or cached identity.
// The source endpoint is approval-gated; it must read Phoenix account/RBAC live.
export function createLiveAuthorization(c:Config, request:typeof fetch=fetch){
  return async(subject:string)=>{
    if(subject!==c.owner.subject)throw new Unavailable();
    const nonce=randomUUID();
    const response=await request(c.authorizationUrl,{method:'POST',redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(3000),headers:{authorization:`Bearer ${c.authorizationKey}`,'content-type':'application/json'},
      body:JSON.stringify({subject,nonce})});
    if(!response.ok)throw new Unavailable();
    const body=await response.text();if(body.length>32000)throw new Unavailable();
    const value=JSON.parse(body);
    if(value.nonce!==nonce)throw new Unavailable();
    if(value.identity===null)return null;
    const identity=identitySchema.parse(value.identity);
    if(identity.subject!==subject)throw new Unavailable();
    return identity;
  };
}
