import { publishProjection,invalidateProjection } from '../src/publisher.mts';
import type { Config } from '../src/config.mts';
import type { Projection } from '../src/contracts.mts';
import type postgres from 'postgres';
export const datasets=['employees','vacancies','organization','published_sales'] as const;
export type Dataset=typeof datasets[number];
// Each dataset has its own proof and transaction. A sales failure cannot poison the others.
export async function refreshDatasets(sql:postgres.Sql,c:Pick<Config,'owner'|'contractRevision'>,period:string,collect:(dataset:Dataset,period:string)=>Promise<Projection<unknown>>){
 const results:Partial<Record<Dataset,'published'|'unavailable'|'invalidation_failed'>>={};
 for(const dataset of datasets){
  const month=dataset==='published_sales'?period:'';
  try{await publishProjection(sql,c,dataset,month,await collect(dataset,month));results[dataset]='published';}
  catch{
   // Remove only the manifest. No incomplete replacement or stale published-sales answer.
   try{await invalidateProjection(sql,c.owner.subject,dataset,month);results[dataset]='unavailable';}
   catch{results[dataset]='invalidation_failed';}
  }
 }
 return results;
}
