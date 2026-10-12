import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
// Reuse PURE Phoenix policy exports. No administrative client may survive bundling.
const denyIo = {
  name: 'deny-phoenix-business-io',
  setup(b) {
    b.onLoad({filter:/\.tsx?$/},async args=>{
      if(!args.path.startsWith(path.join(root,'src')+path.sep))return;
      // These wrappers are replaced by identity functions below. Mark only their calls
      // pure so discarded exports cannot retain administrative loaders in the bundle.
      const source=await readFile(args.path,'utf8');
      return {contents:source.replace(/\b(cache|unstable_cache)\s*\(/g,'/* @__PURE__ */ $&'),loader:args.path.endsWith('.tsx')?'tsx':'ts'};
    });
    b.onResolve({filter:/^(next\/cache(?:\.js)?|react)$/},()=>({path:'cache',namespace:'pure-cache',sideEffects:false}));
    b.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx',namespace:'no-ui',sideEffects:false}));
    b.onLoad({filter:/.*/,namespace:'no-ui'},()=>({contents:'export const jsx=()=>{throw Error("UI unavailable in MCP")}; export const jsxs=jsx; export const Fragment=Symbol();',loader:'js'}));
    b.onLoad({filter:/.*/,namespace:'pure-cache'},()=>({contents:'export const cache = f => f; export const unstable_cache = f => f; export const revalidatePath = () => { throw Error("Disabled"); }; export const revalidateTag = revalidatePath;',loader:'js'}));
    b.onResolve({filter:/^exceljs$/},()=>({path:'exceljs',external:true,sideEffects:false}));
    b.onResolve({filter:/^sanitize-html$/},()=>({path:'sanitize-html',external:true,sideEffects:false}));
    b.onResolve({ filter: /^@\/lib\/(supabase\/server|supabase-rest|observability\/log)$/ }, () => ({ path: 'denied', namespace: 'denied' }));
    b.onLoad({ filter: /.*/, namespace: 'denied' }, () => ({
      contents: `const deny = () => { throw new Error('Phoenix administrative IO is unavailable in MCP'); }; export const getSupabaseAdmin=deny, getSupabaseUserClient=deny, rpcAll=deny, supabaseRest=deny, logError=deny, logWarn=deny, logWarning=deny, logInfo=deny, toQueryError=deny;`, loader: 'js',
    }));
  },
};
const result=await build({
  absWorkingDir: here,
  entryPoints: process.argv.includes('--tests') ? ['src/main.mts', 'tests/security.test.mts','tests/integration.test.mts'] : ['src/main.mts'],
  outdir: 'dist', outExtension: { '.js': '.mjs' }, outbase: '.',
  entryNames: '[name]', bundle: true, platform: 'node', target: 'node24', format: 'esm',
  packages: 'external', alias: { '@': path.join(root, 'src') },
  plugins: [denyIo], sourcemap: false, logLevel: 'warning', metafile:true,
});
const artifact=await readFile(path.join(here,'dist/main.mjs'),'utf8');
if(/serviceRoleKey|\/rest\/v1\/|getRequiredEnv\("SUPABASE|supabase\.co/.test(artifact))throw Error('Administrative Phoenix IO survived bundling');
for(const output of Object.values(result.metafile.outputs)){
  for(const item of output.imports){
    if(item.external&&!/^(node:|@modelcontextprotocol\/sdk\/|express$|jose$|postgres$|zod$)/.test(item.path))throw Error(`Unreviewed runtime dependency: ${item.path}`);
  }
}
await writeFile(path.join(here,'dist/build-manifest.json'),JSON.stringify(result.metafile,null,2));
// Source-only build. Original Phoenix loaders outside this artifact retain their behavior.
const sourceIo={name:'strict-source-io',setup(b){
 b.onResolve({filter:/(supabase\/server|\/env|employee-directory)(\.ts)?$/},args=>{
  const name=args.path.replaceAll('\\','/');
  if(args.importer.replaceAll('\\','/').endsWith('/source/runtime.mjs'))return;
  if(name.endsWith('/supabase/server')||name.endsWith('/supabase/server.ts')||name.endsWith('/env')||name.endsWith('/env.ts'))return {path:'runtime',namespace:'source-io'};
  if(!args.importer.endsWith('employee-original'))return {path:'employee-original',namespace:'source-io'};
 });
 b.onLoad({filter:/.*/,namespace:'source-io'},args=>({contents:args.path==='runtime'?`export * from ${JSON.stringify(path.join(here,'source/runtime.mjs'))};`:
  `export * from ${JSON.stringify(path.join(root,'src/lib/employees/employee-directory.ts'))}; export {getSourceDirectory as getEmployeeDirectory} from ${JSON.stringify(path.join(here,'source/runtime.mjs'))};`,loader:'js',resolveDir:here}));
}};
await build({absWorkingDir:here,entryPoints:{'source-main':'source/main.mts','source-worker':'source/worker.mjs',...(process.argv.includes('--tests')?{'source-pipeline.test':'tests/source-pipeline.test.mjs'}:{})},outdir:'dist',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',alias:{'@':path.join(root,'src')},plugins:[sourceIo,denyIo],logLevel:'warning'});
