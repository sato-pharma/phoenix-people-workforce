import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { createSourceTransport } from './transport.mts';
import { createSourceAuthorization } from './authorization.mts';
import type { Config } from '../src/config.mts';
export type SourceConfig={origin:string;credential:string;secret:string;owner:Config['owner']};
export function createSourceApp(c:SourceConfig,request:typeof fetch=fetch){
 const app=express();app.disable('x-powered-by');let collecting=false;let hits:number[]=[];
 app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  const token=req.headers.authorization?.replace(/^Bearer /,'')??'',expected=Buffer.from(c.secret),actual=Buffer.from(token);
  if(expected.length<32||actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.sendStatus(401);
  hits=hits.filter(t=>t>Date.now()-60000);if(hits.length>=180)return res.sendStatus(429);hits.push(Date.now());next();
 });
 app.use(express.json({limit:'2kb',inflate:false}));
 app.post('/authorization',async(req,res)=>{
  try{
   const body=z.strictObject({subject:z.literal(c.owner.subject),nonce:z.string().uuid()}).parse(req.body);
   const live=createSourceAuthorization(createSourceTransport(c.origin,c.credential,request),c.owner);
   res.json({nonce:body.nonce,identity:await live(body.subject)});
  }catch{res.sendStatus(503);}
 });
 app.post('/projection',async(req,res)=>{
  if(collecting)return res.sendStatus(429);
  try{
   const body=z.strictObject({subject:z.literal(c.owner.subject),dataset:z.enum(['employees','vacancies','organization','published_sales']),period:z.string().regex(/^$|^20\d{2}-(0[1-9]|1[0-2])$/)}).parse(req.body);
   if((body.dataset==='published_sales')!==Boolean(body.period))return res.sendStatus(400);
   collecting=true;
   const result=await new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./source-worker.mjs',import.meta.url),{workerData:{...c,...body},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:256}});
    // Canonical loaders may log diagnostics. Never forward them to integration logs.
    worker.stdout.resume();worker.stderr.resume();
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('Source timeout'));},45000);
    worker.once('message',value=>{clearTimeout(timer);void worker.terminate();if(value.error)reject(Error('Source failed'));else resolve(value);});
    worker.once('error',()=>{clearTimeout(timer);reject(Error('Source failed'));});
    worker.once('exit',()=>{clearTimeout(timer);reject(Error('Source exited without a result'));});
   });
   res.json(result);
  }catch{res.sendStatus(503);}finally{collecting=false;}
 });
 app.use((_req,res)=>res.sendStatus(404));
 app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.sendStatus(400);});
 return app;
}
