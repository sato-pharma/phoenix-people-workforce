import { NotPublished,type Projection } from './contracts.mts';
import type { Dataset } from './publisher.mts';

// One refresh cycle. Datasets are collected and published INDEPENDENTLY: an unavailable sales period
// must not stop a valid workforce, vacancy or organization refresh, and each sales month stands alone.
// A dataset is published only when its collector returns a sealed, proof-carrying projection; any
// refusal or error publishes nothing for that dataset and leaves its previous snapshot untouched
// (the reader's 60-second freshness bound then retires it). Only a clean, proven "not published"
// withdraws a sales month immediately.
export type Outcome={dataset:Dataset;period:string;status:'published'|'withdrawn'|'skipped'|'failed';reason?:string};
export type Collected=Projection<unknown>|{withdrawn:true};
export type CycleDeps={
 collect:(dataset:Dataset,period:string)=>Promise<Collected>;
 publish:(dataset:Dataset,period:string,projection:Projection<unknown>)=>Promise<void>;
 withdraw:(dataset:Dataset,period:string)=>Promise<void>;
};
export async function runPublishCycle(deps:CycleDeps,salesPeriods:readonly string[]):Promise<Outcome[]>{
 const jobs:[Dataset,string][]=[['employees',''],['vacancies',''],['organization',''],...salesPeriods.map(p=>['published_sales',p] as [Dataset,string])];
 return Promise.all(jobs.map(async([dataset,period]):Promise<Outcome>=>{
  try{
   const collected=await deps.collect(dataset,period);
   if('withdrawn' in collected){await deps.withdraw(dataset,period);return {dataset,period,status:'withdrawn'};}
   await deps.publish(dataset,period,collected);
   return {dataset,period,status:'published'};
  }catch(error){
   // Reasons are codes only: no row values, identifiers or messages from Phoenix.
   const reason=error instanceof NotPublished?'not_published':(error as {reason?:string})?.reason??'unavailable';
   return {dataset,period,status:'failed',reason};
  }
 }));
}
