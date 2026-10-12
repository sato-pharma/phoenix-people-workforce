import type { Identity } from './contracts.mts';
import { NotPublished } from './contracts.mts';
import { seal,workforceAdapter,organizationAdapter,vacancyAdapter,salesAdapter } from './source-adapters.mts';
import { provenRead,SPECS,SALES_PUBLICATION_SPEC,type WatermarkReader } from './phoenix-source.mjs';
import type { Collected } from './publish-cycle.mts';
import type { Dataset } from './publisher.mts';

// Source-side orchestration, written against injected loaders so the SAME code runs against Phoenix's
// real report loaders (source/phoenix-bindings.mjs) and against production-shaped synthetic loaders
// in tests. Every dataset is read under its own proof; nothing is shared between datasets, so one
// failing source cannot hold back another.
export type Loaders={
 employees():Promise<unknown[]>;
 organization():Promise<{diagnostic?:unknown;organogramRows:unknown[]}>;
 /** getScopedVacancyReport output: already occupancy-reconciled by Phoenix. */
 vacancies():Promise<{diagnostic?:unknown;rows:unknown[]}>;
 /** The lines the owner may see published closings for. */
 lines():Promise<string[]>;
 /** STRICT: null only when the read succeeded and no live publication row exists; any error throws. */
 publication(line:string,period:string):Promise<{publishedAt:string;revision:string}|null>;
 closing(line:string,period:string):Promise<unknown>;
};
export type CollectorConfig={loaders:Loaders;identity:Identity;watermark:WatermarkReader;now?:()=>Date;attempts?:number};

export function createCollector(c:CollectorConfig){
 const deps={watermark:c.watermark,now:c.now,attempts:c.attempts};
 return async(dataset:Dataset,period:string):Promise<Collected>=>{
  if(dataset==='employees'){const r=await provenRead(SPECS.employees,'',async()=>workforceAdapter(await c.loaders.employees(),c.identity),deps);return seal('employees','',r.value,r.proof);}
  if(dataset==='organization'){const r=await provenRead(SPECS.organization,'',async()=>organizationAdapter(await c.loaders.organization()),deps);return seal('organization','',r.value,r.proof);}
  if(dataset==='vacancies'){const r=await provenRead(SPECS.vacancies,'',async()=>vacancyAdapter(await c.loaders.vacancies()),deps);return seal('vacancies','',r.value,r.proof);}
  // Publication first, on its own narrow proof: a withdrawal must be provable without running (or
  // being blocked by) the heavy closing read, and "could not tell" must never look like "withdrawn".
  const published=await provenRead(SALES_PUBLICATION_SPEC,period,async()=>{
   const lines=await c.loaders.lines();
   if(!lines.length)throw new NotPublished();
   const flags:boolean[]=[];for(const line of lines)flags.push((await c.loaders.publication(line,period))!==null);
   return flags;
  },deps);
  if(published.value.some(flag=>!flag))return {withdrawn:true};
  const r=await provenRead(SPECS.published_sales,period,async()=>{
   const lines=await c.loaders.lines();
   return salesAdapter(period,lines,{publication:c.loaders.publication,closing:c.loaders.closing});
  },deps);
  return seal('published_sales',period,r.value,r.proof);
 };
}
