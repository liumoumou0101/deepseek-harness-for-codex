#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile,stat,mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

const EXPECTED='DSH_CONNECTION_OK';
const PROTOCOL='2025-11-25';
const USAGE='Usage: node scripts/test-local.mjs [--server <absolute MCP bin.mjs>] [--settings <absolute local-runtime.json>]';
function failure(code){const error=new Error(code);error.diagnosticCode=code;return error}
function codeOf(error,fallback='DIAGNOSTIC_FAILED'){
 if(error?.diagnosticCode)return error.diagnosticCode;
 const match=String(error?.message??'').match(/\b(ENOTFOUND|EACCES|EPERM|ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|TRANSPORT|HTTP [45]\d\d)\b/);
 return match?match[1].replace(' ','_'):fallback;
}
export function parseTestArgs(argv){
 const options={};const flags=new Map([['--server','server'],['--settings','settings']]);
 for(let index=0;index<argv.length;index++){
  const flag=argv[index];if(flag==='--help'||flag==='-h'){options.help=true;continue}
  const key=flags.get(flag);if(!key)throw failure('UNKNOWN_OPTION');
  if(Object.hasOwn(options,key))throw failure('DUPLICATE_OPTION');
  const value=argv[++index];if(!value||value.startsWith('--')||!isAbsolute(value))throw failure('ABSOLUTE_OPTION_PATH_REQUIRED');
  options[key]=resolve(value);
 }
 return options;
}

class StdioMcpClient{
 constructor(child){
  this.child=child;this.nextId=1;this.pending=new Map();this.broken=false;this.exited=false;this.exitCode=null;
  this.closed=new Promise(resolveClose=>{this.resolveClose=resolveClose});
  this.lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  this.lines.on('line',line=>this.receive(line));
  child.stderr.on('data',()=>{}); // Drain diagnostics without exposing logs, tokens, or credentials.
  child.stdin.on('error',()=>this.fail(failure('MCP_STDIN_ERROR')));
  child.on('error',()=>this.fail(failure('MCP_SPAWN_FAILED')));
  child.on('close',code=>{this.exited=true;this.exitCode=code;this.fail(failure('MCP_SERVER_CLOSED'));this.resolveClose()});
 }
 fail(error){this.broken=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}this.pending.clear()}
 receive(line){
  if(!line.trim())return;
  if(line.length>1_048_576){this.fail(failure('MCP_MESSAGE_TOO_LARGE'));return}
  let message;try{message=JSON.parse(line)}catch{this.fail(failure('MCP_INVALID_JSON'));return}
  if(!message||message.jsonrpc!=='2.0'){this.fail(failure('MCP_INVALID_MESSAGE'));return}
  if(message.id!==undefined&&message.method){
   const response=message.method==='ping'?{result:{}}:{error:{code:-32601,message:'Client capability is not supported'}};
   this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...response})+'\n');return;
  }
  const pending=this.pending.get(message.id);if(!pending)return;
  this.pending.delete(message.id);clearTimeout(pending.timer);
  if(message.error)pending.reject(failure('MCP_RPC_ERROR'));else pending.resolve(message.result);
 }
 request(method,params,timeoutMs){
  if(this.broken||this.exited)return Promise.reject(failure('MCP_CONNECTION_UNAVAILABLE'));
  const id=this.nextId++;
  return new Promise((resolveRequest,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(failure('MCP_REQUEST_TIMEOUT'))},Math.max(1,timeoutMs));
   this.pending.set(id,{resolve:resolveRequest,reject,timer});
   this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(failure('MCP_STDIN_ERROR'))}});
  });
 }
 notify(method){return new Promise((resolveNotify,reject)=>this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n',error=>error?reject(failure('MCP_STDIN_ERROR')):resolveNotify()))}
 async waitClosed(timeoutMs){let timer;try{return await Promise.race([this.closed.then(()=>true),new Promise(resolveWait=>{timer=setTimeout(()=>resolveWait(false),timeoutMs)})])}finally{clearTimeout(timer)}}
 async close(){
  if(!this.exited)this.child.stdin.end();
  let forced=false;
  if(!await this.waitClosed(3000)){
   forced=true;try{this.child.kill('SIGTERM')}catch{}
   if(!await this.waitClosed(3000)){try{this.child.kill('SIGKILL')}catch{};await this.waitClosed(1500)}
  }
  this.lines.close();this.fail(failure('MCP_CONNECTION_CLOSED'));
  return {serverExited:this.exited,serverExitCode:this.exitCode,forced};
 }
}
function toolValue(result,name){
 if(result?.isError){const text=(result.content??[]).filter(item=>item.type==='text').map(item=>item.text).join(' ');throw failure(codeOf({message:text},'TOOL_'+name.toUpperCase()+'_FAILED'))}
 if(result?.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
 for(const block of result?.content??[])if(block.type==='text'){try{const value=JSON.parse(block.text);if(value&&typeof value==='object')return value}catch{}}
 throw failure('MCP_TOOL_RESULT_INVALID');
}
function doctorSummary(value){
 const result={};
 for(const key of ['ready','runtime','harnessSource','nodeVersion','dshVersion','modelProvider','model','credentialAvailable']){
  const field=value[key];if(typeof field==='boolean')result[key]=field;
  else if(typeof field==='string'&&/^[\w .:@/+-]{1,160}$/.test(field)&&!field.includes('://'))result[key]=field;
 }
 return result;
}
async function hash(path){try{return createHash('sha256').update(await readFile(path)).digest('hex')}catch(error){if(error.code==='ENOENT')return null;throw failure('ORIGINAL_FILE_VERIFICATION_FAILED')}}
async function requireFile(path,label){let info;try{info=await stat(path)}catch{throw failure(label+'_NOT_FOUND')}if(!info.isFile())throw failure(label+'_NOT_FILE')}
function sameWorkspace(first,second){return typeof first==='string'&&(process.platform==='win32'?resolve(first).toLowerCase()===resolve(second).toLowerCase():resolve(first)===resolve(second))}

export async function runDiagnostic(options={}){
 let phase='configuration';let client;let initialized=false;let originalPaths=[];let before=[];let workspace;
 const ownedServices=new Set();const output={success:false};
 try{
  const server=options.server??fileURLToPath(new URL('../plugins/deepseek-harness/dist/bin.mjs',import.meta.url));
  await requireFile(server,'MCP_BUNDLE');
  const effectiveSettings=options.settings??process.env.DSH_MCP_LOCAL_SETTINGS?.trim()??join(homedir(),'.deep-seek-harness-mcp','local-runtime.json');
  let metadata={};
  try{metadata=JSON.parse((await readFile(effectiveSettings,'utf8')).replace(/^\uFEFF/,''))}catch(error){if(options.settings||error.code!=='ENOENT')throw failure('LOCAL_SETTINGS_INVALID')}
  const originalHome=typeof metadata.dshHome==='string'&&isAbsolute(metadata.dshHome)?metadata.dshHome:join(homedir(),'.dsh');
  const originalProfile=typeof metadata.desktopProfile==='string'&&isAbsolute(metadata.desktopProfile)?metadata.desktopProfile:join(originalHome,'profiles','desktop','cordis.patch.yml');
  originalPaths=[join(originalHome,'.credentials.yaml'),originalProfile];before=await Promise.all(originalPaths.map(hash));
  const temporaryParent=process.platform==='win32'?join(homedir(),'AppData','Local','Temp'):tmpdir();await mkdir(temporaryParent,{recursive:true});
  const temporaryRoot=await mkdtemp(join(temporaryParent,'dsh-mcp-smoke-'));workspace=join(temporaryRoot,'empty-workspace');await mkdir(workspace);
  const env={...process.env,DSH_MCP_RUNTIME:'local',DSH_MCP_DATA_DIR:join(temporaryRoot,'service-data'),DSH_MCP_WORKSPACE_ROOTS:workspace,DSH_PERMISSION_MODE:'read-only'};
  if(options.settings)env.DSH_MCP_LOCAL_SETTINGS=options.settings;
  const child=spawn(process.execPath,[server],{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});client=new StdioMcpClient(child);
  const deadline=Date.now()+120_000;
  const budget=maximum=>{const remaining=deadline-Date.now();if(remaining<=0)throw failure('DIAGNOSTIC_TIMEOUT');return Math.min(maximum,remaining)};
  const tool=async(name,args,maximum)=>toolValue(await client.request('tools/call',{name,arguments:args},budget(maximum)),name);
  phase='initialize';const init=await client.request('initialize',{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'dsh-local-connection-check',version:'1.0.0'}},budget(15000));
  if(typeof init?.protocolVersion!=='string')throw failure('MCP_INITIALIZE_INVALID');
  await client.notify('notifications/initialized');initialized=true;
  phase='doctor';const doctor=await tool('doctor',{},35000);output.doctor=doctorSummary(doctor);
  if(doctor.ready!==true)throw failure('DOCTOR_NOT_READY');
  if(doctor.credentialAvailable!==true)throw failure('CREDENTIAL_UNAVAILABLE');
  phase='start_run';let run=await tool('start_run',{workspace,openBrowser:false,task:'Connection smoke test only. Do not read or modify files, invoke tools, run commands, or perform any other task. Reply exactly DSH_CONNECTION_OK.'},60000);
  if(typeof run.serviceId==='string')ownedServices.add(run.serviceId);
  while(run.status==='running'){
   phase='wait_run';const timeoutMs=budget(30000);run=await tool('wait_run',{runId:run.runId,timeoutMs},timeoutMs+3000);
   if(typeof run.serviceId==='string')ownedServices.add(run.serviceId);
  }
  output.runStatus=['succeeded','failed','cancelled'].includes(run.status)?run.status:'unknown';
  const matches=typeof run.assistantText==='string'&&run.assistantText.trim()===EXPECTED;
  output.reply=matches?EXPECTED:'';output.replyMatched=matches;
  if(run.status!=='succeeded')throw failure(codeOf({message:run.error},'MODEL_RUN_FAILED'));
  if(!matches)throw failure('MODEL_REPLY_MISMATCH');
  output.success=true;
 }catch(error){output.error={phase,code:codeOf(error)}}
 finally{
  phase='cleanup';let stopped=true;
  if(client&&initialized&&!client.broken){
   try{
    const services=toolValue(await client.request('tools/call',{name:'list_services',arguments:{}},5000),'list_services');
    for(const service of services.services??[])if(sameWorkspace(service.workspace,workspace)&&typeof service.serviceId==='string')ownedServices.add(service.serviceId);
   }catch{stopped=false}
   for(const serviceId of ownedServices){try{toolValue(await client.request('tools/call',{name:'stop_service',arguments:{serviceId}},15000),'stop_service')}catch{stopped=false}}
  }else if(ownedServices.size)stopped=false;
  if(client){output.cleanup={servicesStopped:stopped,...await client.close()};if(!stopped||!output.cleanup.serverExited||output.cleanup.serverExitCode!==0||output.cleanup.forced){output.success=false;output.error??={phase,code:'CLEANUP_FAILED'}}}
  if(workspace){try{const files=await readdir(workspace);output.workspaceEmpty=files.length===0;output.workspaceFiles=files.length===0?[]:['[unexpected files omitted]'];if(files.length){output.success=false;output.error??={phase:'verification',code:'WORKSPACE_CHANGED'}}}catch{output.success=false;output.error??={phase:'verification',code:'WORKSPACE_VERIFICATION_FAILED'}}}
  if(originalPaths.length){try{const after=await Promise.all(originalPaths.map(hash));output.originalFilesUnchanged=before.length===after.length&&before.every((value,index)=>value===after[index]);if(!output.originalFilesUnchanged){output.success=false;output.error??={phase:'verification',code:'ORIGINAL_FILES_CHANGED'}}}catch{output.success=false;output.error??={phase:'verification',code:'ORIGINAL_FILE_VERIFICATION_FAILED'}}}
 }
 return output;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let output;
 try{const options=parseTestArgs(process.argv.slice(2));if(options.help){console.log(USAGE)}else{output=await runDiagnostic(options);console.log(JSON.stringify(output,null,2));if(!output.success)process.exitCode=1}}
 catch(error){console.log(JSON.stringify({success:false,error:{phase:'arguments',code:codeOf(error)}}));process.exitCode=1}
}
