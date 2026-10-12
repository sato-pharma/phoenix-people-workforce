import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSourceTransport } from '../source/transport.mts';
import { createSourceAuthorization } from '../source/authorization.mts';
import { configureSource } from '../source/runtime.mjs';
import { collectCanonicalDataset } from '../source/phoenix-bindings.mjs';
import { sourceFixture } from './source-fixture.mjs';
import { config,subject } from './fixtures.mts';

test('canonical source collector executes real Phoenix report loaders over synthetic IO',async()=>{
 const fixture=sourceFixture(),transport=createSourceTransport('https://source.test','synthetic-read-key',fixture.request);
 configureSource(transport,'https://source.test','synthetic-read-key');
 const previous=globalThis.fetch;globalThis.fetch=transport.fetch;
 try{
  const identity=await createSourceAuthorization(transport,config.owner)(subject);
  for(const dataset of ['employees','vacancies','organization','published_sales']){
   try{const result=await collectCanonicalDataset(identity,dataset,dataset==='published_sales'?'2026-06':'',transport);assert.ok(result.freshness.sourceWatermark);console.log(dataset,result.length);}
   catch(error){console.log('SOURCE FIXTURE READS',fixture.requests);throw new Error(dataset,{cause:error});}
  }
 }finally{globalThis.fetch=previous;}
});
