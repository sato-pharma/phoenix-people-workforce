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
    b.onLoad({filter:/.*/,namespace:'pure-cache'},()=>({contents:'export const cache = f => f; export const unstable_cache = f => f; export const revalidatePath = () => { throw Error("Disabled"); }; export const revalidateTag = revalidatePath;',loader:'js'}));
    b.onResolve({filter:/^exceljs$/},()=>({path:'exceljs',external:true,sideEffects:false}));
    b.onResolve({ filter: /^@\/lib\/(supabase\/server|supabase-rest|observability\/log)$/ }, () => ({ path: 'denied', namespace: 'denied' }));
    b.onLoad({ filter: /.*/, namespace: 'denied' }, () => ({
      contents: `const deny = () => { throw new Error('Phoenix administrative IO is unavailable in MCP'); }; export const getSupabaseAdmin=deny, getSupabaseUserClient=deny, rpcAll=deny, supabaseRest=deny, logError=deny, logWarn=deny, logWarning=deny, logInfo=deny, toQueryError=deny;`, loader: 'js',
    }));
  },
};
const result=await build({
  absWorkingDir: here,
  entryPoints: process.argv.includes('--tests') ? ['src/main.mts', 'tests/security.test.mts'] : ['src/main.mts'],
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
