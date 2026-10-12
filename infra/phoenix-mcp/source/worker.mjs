import { parentPort,workerData } from 'node:worker_threads';
import { createSourceTransport } from './transport.mts';
import { configureSource } from './runtime.mjs';
import { createSourceAuthorization } from './authorization.mts';
import { collectCanonicalDataset } from './phoenix-bindings.mjs';
import { Authorizer } from '../src/policy.mts';
const nativeFetch=globalThis.fetch;
const {origin,credential,owner,dataset,period}=workerData;
const transport=createSourceTransport(origin,credential,nativeFetch);
configureSource(transport,origin,credential);
// Only this short-lived worker overrides fetch. No module cache survives a collection.
globalThis.fetch=transport.fetch;
try{
 const live=createSourceAuthorization(transport,owner);
 const auth=new Authorizer({identity:live},owner);
 const names={employees:'get_workforce_summary',vacancies:'get_open_vacancies',organization:'get_organizational_structure',published_sales:'get_published_sales_summary'};
 const identity=await live(owner.subject);await auth.tool(identity,names[dataset]);
 const result=await collectCanonicalDataset(identity,dataset,period,transport);
 await auth.tool(identity,names[dataset]);
 parentPort.postMessage({rows:[...result],freshness:result.freshness});
}catch{parentPort.postMessage({error:'Source unavailable'});}
finally{parentPort.close();}
