import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const root=dirname(fileURLToPath(import.meta.url));
const build=join(root,'..','node_modules','.cache','run-manager-compat');
await mkdir(build,{recursive:true});
const source=await readFile(join(root,'..','src','run-manager.ts'),'utf8');
const compiled=stripTypeScriptTypes(source,{mode:'strip'}).replaceAll('"./runtime.js"','"./stub-runtime.mjs"').replaceAll('"./web-client.mjs"','"./stub-web-client.mjs"');
await writeFile(join(build,'run-manager.mjs'),compiled,'utf8');
await writeFile(join(build,'stub-runtime.mjs'),`export function resolveDataDirectory(){return ${JSON.stringify(join(build,'data'))}};export function resolveAllowedRoots(){return []};export function buildHarnessWebCommand(input){return {command:'not-executed',args:[],cwd:input.workspace,env:{}}}`,'utf8');
await writeFile(join(build,'stub-web-client.mjs'),`export async function createWebClient(){throw Error('Expected injected fake remote client')};export async function createLegacyWebClient(){throw Error('Expected injected fake legacy client')}`,'utf8');
const {RunManager}=await import(pathToFileURL(join(build,'run-manager.mjs')).href);
// The compiled module uses a throwing default-client stub, so regressions cannot make network requests.
let fixtureNumber=0;
class FakeChild extends EventEmitter {
  exitCode=null;pid=undefined;stdout=new PassThrough();stderr=new PassThrough();kills=0;
  kill(){this.kills++;this.exitCode=0;queueMicrotask(()=>this.emit('close',0,null));return true}
}
function event(seq,type,data){return {event:{seq,type,data}}}
function message(seq,text){return event(seq,'assistant/message',{message:{content:[{type:'text',text}]}})}
async function fixture(options={}){
  const path=join(build,'cases',String(++fixtureNumber));
  const workspace=join(path,'workspaces','one');
  const otherWorkspace=join(path,'workspaces','two');
  await mkdir(workspace,{recursive:true});await mkdir(otherWorkspace,{recursive:true});
  const canonical=await realpath(workspace);
  const state={sessionCount:0,clients:0,closed:0,spawned:0,prompts:[],historyRequests:[],sessions:new Map(),children:[],throwHistory:false,finish:options.finish};
  const client={protocol:options.protocol??'remote',async rpc(method,payload){
    if(method==='workspace.create')return {workspace:{workspaceId:'workspace-one'}};
    if(method==='session.create'){const sessionId='session-'+(++state.sessionCount);state.sessions.set(sessionId,{sessionId,running:false,blank:true,cwd:canonical,events:[]});return {sessionId}}
    if(method==='session.list')return {items:[...state.sessions.values()].map(({events,...entry})=>entry)};
    if(method==='session.history'){state.historyRequests.push(payload);if(state.throwHistory)throw Error('temporary peer read failure');return {events:state.sessions.get(payload.sessionId)?.events??[]}}
    if(method==='session.prompt'){state.prompts.push(payload);const session=state.sessions.get(payload.sessionId);session.blank=false;session.running=true;state.finish?.(session,payload);return {accepted:true}}
    if(method==='session.cancel'){if(state.throwCancel)throw Error('cancel peer disconnected');const session=state.sessions.get(payload.sessionId);session.running=false;session.events.push(event(session.events.length+20,'turn/end',{reason:{kind:'aborted'}}));return {accepted:true}}
    throw Error('Unmocked method '+method);
  },async close(){state.closed++}};
  const manager=new RunManager({dataDirectory:join(path,'state'),allowedRoots:[join(path,'workspaces')],startupTimeoutMs:200,pollIntervalMs:1,commandFactory:input=>({command:'fake',args:[],cwd:input.workspace,env:{}}),spawnProcess:()=>{const child=new FakeChild();state.spawned++;state.children.push(child);queueMicrotask(()=>child.stdout.write(options.token===false?'dsh web: http://127.0.0.1:12345\n':'dsh web: http://127.0.0.1:12345/?token=test-token\n'));return child},webClientFactory:options.useDefaultClient?undefined:async(url)=>{assert.equal(url,'http://127.0.0.1:12345/?token=test-token');state.clients++;return client},openBrowser:async()=>{throw Error('Browser must not open during tests')}});
  return {manager,state,workspace,otherWorkspace,path,canonical};
}
const completed=session=>{session.running=false;session.events.push(message(0,'DSH_OK'),event(1,'turn/end',{reason:{kind:'completed'}}))};

test('deduplicates Web clients and sends a business requestId without opening a browser',async()=>{
  const {manager,state,workspace}=await fixture({finish:completed});
  try {const run=await manager.start({workspace,task:' reply DSH_OK ',openBrowser:false});assert.equal(run.status,'succeeded');assert.equal(run.assistantText,'DSH_OK');assert.equal(run.browserOpened,undefined);assert.equal(state.clients,1);assert.equal(state.spawned,1);assert.match(state.prompts[0].requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);assert.equal(state.prompts[0].content[0].text,'reply DSH_OK');assert.equal(run.sessionReused,false);assert.equal(run.error,null);assert.equal(state.historyRequests.at(-1).afterSeq,-1)} finally {await manager.close()}
});
for(const kind of ['error','blocked','max-tokens'])test('turn/end '+kind+' is failed without an agent/error event',async()=>{
 const {manager,workspace}=await fixture({finish:session=>{session.running=false;session.events.push(event(0,'turn/end',{reason:{kind,error:kind==='error'?{code:'TRANSPORT',message:'Connection failed'}:undefined}}))}});
 try {const run=await manager.start({workspace,task:'smoke'});assert.equal(run.status,'failed');assert.ok(run.error);if(kind==='error')assert.match(run.error,/Connection failed/)}finally{await manager.close()}
});
test('aborted turn is cancelled, not succeeded',async()=>{
 const {manager,workspace}=await fixture({finish:session=>{session.running=false;session.events.push(event(0,'turn/end',{reason:{kind:'aborted'}}))}});
 try{const run=await manager.start({workspace,task:'smoke'});assert.equal(run.status,'cancelled')}finally{await manager.close()}
});
test('missing or unrecognized end reason cannot claim success',async()=>{
 const {manager,workspace}=await fixture({finish:session=>{session.running=false;session.events.push(event(0,'turn/end',{reason:{kind:'future-end-kind'}}))}});
 try{const run=await manager.start({workspace,task:'smoke'});assert.equal(run.status,'failed');assert.match(run.error,/future-end-kind/)}finally{await manager.close()}
});
test('reuses a completed session and returns only the new turn',async()=>{
 const {manager,state,workspace,canonical}=await fixture({finish:session=>{session.running=false;session.events.push(message(8,'new reply'),event(9,'turn/end',{reason:{kind:'completed'}}))}});
 state.sessions.set('existing',{sessionId:'existing',running:false,blank:false,cwd:canonical,events:[message(1,'old reply'),event(2,'turn/end',{reason:{kind:'completed'}})]});
 try{const run=await manager.start({workspace,task:'continue',sessionId:'existing'});assert.equal(run.sessionReused,true);assert.equal(run.status,'succeeded');assert.equal(run.assistantText,'new reply');assert.equal(run.lastEventSeq,9);assert.equal(state.historyRequests.at(-1).afterSeq,2)}finally{await manager.close()}
});
test('rejects unknown, already running, and other-workspace sessions',async()=>{
 const {manager,state,workspace,otherWorkspace,canonical}=await fixture();
 state.sessions.set('busy',{sessionId:'busy',running:true,blank:false,cwd:canonical,events:[]});
 state.sessions.set('foreign',{sessionId:'foreign',running:false,blank:false,cwd:await realpath(otherWorkspace),events:[]});
 try{await assert.rejects(manager.start({workspace,task:'continue',sessionId:'missing'}),/Unknown sessionId/);await assert.rejects(manager.start({workspace,task:'continue',sessionId:'busy'}),/still running/);await assert.rejects(manager.start({workspace,task:'continue',sessionId:'foreign'}),/workspace/i);assert.equal(state.prompts.length,0)}finally{await manager.close()}
});
test('active MCP run guard prevents a second request even if a stale summary is idle',async()=>{
 const {manager,state,workspace}=await fixture();
 try{const first=await manager.start({workspace,task:'first'});state.sessions.get(first.sessionId).running=false;await assert.rejects(manager.start({workspace,task:'duplicate',sessionId:first.sessionId}),/active MCP run/);assert.equal(state.prompts.length,1)}finally{await manager.close()}
});
test('cancel uses the same session and releases it after an aborted turn',async()=>{
 const {manager,state,workspace}=await fixture();
 try{const run=await manager.start({workspace,task:'wait'});assert.equal(run.status,'running');const cancelled=await manager.cancel(run.runId);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.cancelRequested,true);assert.ok(cancelled.finishedAt);state.finish=completed;state.sessions.get(run.sessionId).events=[];const next=await manager.start({workspace,task:'retry',sessionId:run.sessionId});assert.equal(next.status,'succeeded')}finally{await manager.close()}
});
test('refresh can recover from a transient read error without retaining stale error text',async()=>{
 const {manager,state,workspace}=await fixture();
 try{const run=await manager.start({workspace,task:'wait'});state.throwHistory=true;const transient=await manager.get(run.runId);assert.equal(transient.status,'running');assert.match(transient.error,/temporary peer/);state.throwHistory=false;completed(state.sessions.get(run.sessionId));const finished=await manager.wait(run.runId,10);assert.equal(finished.status,'succeeded');assert.equal(finished.error,null)}finally{await manager.close()}
});
test('refuses paths outside allowed roots before creating any child',async()=>{
 const {manager,state,path}=await fixture();const outside=join(path,'outside');await mkdir(outside,{recursive:true});
 try{await assert.rejects(manager.startService({workspace:outside}),/outside DSH_MCP_WORKSPACE_ROOTS/);assert.equal(state.spawned,0)}finally{await manager.close()}
});
test('concurrent starts share one service and one client; close disposes exactly once',async()=>{
 const {manager,state,workspace}=await fixture({finish:completed});
 await Promise.all([manager.start({workspace,task:'one'}),manager.start({workspace,task:'two'})]);assert.equal(state.spawned,1);assert.equal(state.clients,1);await manager.close();await manager.close();assert.equal(state.closed,1);assert.equal(state.children[0].kills,1);assert.equal(manager.listServices()[0].status,'stopped');
});
test('service process death disposes its client and a pending run fails',async()=>{
 const {manager,state,workspace}=await fixture();
 try{const run=await manager.start({workspace,task:'wait'});const child=state.children[0];child.exitCode=1;child.emit('close',1,null);await new Promise(resolve=>setImmediate(resolve));assert.equal(state.closed,1);assert.equal((await manager.get(run.runId)).status,'failed')}finally{await manager.close();assert.equal(state.closed,1)}
});

for (const [label,reason,status] of [
  ['stop','stop','succeeded'],
  ['absent',undefined,'succeeded'],
  ['cancelled','cancelled','cancelled'],
  ['error','error','failed'],
])test('legacy end reason '+label+' is interpreted only by legacy connections',async()=>{
 const {manager,workspace}=await fixture({protocol:'legacy',finish:session=>{session.running=false;session.events.push(event(0,'turn/end',reason===undefined?{}:{reason}))}});
 try{const run=await manager.start({workspace,task:'legacy smoke'});assert.equal(run.status,status)}finally{await manager.close()}
});
test('modern connection cannot claim success when turn/end has no reason',async()=>{
 const {manager,workspace}=await fixture({finish:session=>{session.running=false;session.events.push(event(0,'turn/end',{}))}});
 try{const run=await manager.start({workspace,task:'modern smoke'});assert.equal(run.status,'failed');assert.match(run.error,/unknown reason/)}finally{await manager.close()}
});
for(const [token,protocol]of [[true,'remote'],[false,'legacy']])test('default factory selects '+protocol+' from the owned service URL',async()=>{
 const {manager,workspace}=await fixture({useDefaultClient:true,token});
 try{await assert.rejects(manager.start({workspace,task:'route selection'}),new RegExp('fake '+protocol+' client'))}finally{await manager.close()}
});
test('stopService still terminates its child when cancellation RPC rejects',async()=>{
 const {manager,state,workspace}=await fixture();
 try{
  const run=await manager.start({workspace,task:'wait'});state.throwCancel=true;
  const stopped=await manager.stopService(run.serviceId);
  assert.equal(stopped.status,'stopped');assert.equal(state.children[0].kills,1);assert.equal(state.closed,1);
  const final=await manager.get(run.runId);assert.equal(final.status,'failed');assert.match(final.error,/cancel peer disconnected/);
  await manager.stopService(run.serviceId);assert.equal(state.children[0].kills,1);assert.equal(state.closed,1);
 }finally{await manager.close()}
});