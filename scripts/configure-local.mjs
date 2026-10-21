#!/usr/bin/env node
import {lstat,stat,mkdir,readFile,open,rename,unlink,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,extname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const FLAGS=new Map([
 ['--dsh-executable','dshExecutable'],['--dsh-home','dshHome'],
 ['--dsh-cli','dshCli'],['--settings','settings'],
]);
const USAGE='Usage: node scripts/configure-local.mjs --dsh-executable <absolute executable> [--dsh-home <absolute DSH home>] [--dsh-cli <absolute asar CLI>] [--settings <absolute JSON target>]';

export function parseConfigureArgs(argv){
 const options={};
 for(let index=0;index<argv.length;index++){
  const flag=argv[index];
  if(flag==='--help'||flag==='-h'){options.help=true;continue}
  const key=FLAGS.get(flag);
  if(!key)throw Error('Unknown option: '+flag);
  if(Object.hasOwn(options,key))throw Error('Duplicate option: '+flag);
  const value=argv[++index];
  if(!value||value.startsWith('--'))throw Error(flag+' requires a value.');
  options[key]=value;
 }
 return options;
}

function absolutePath(value,label){
 if(typeof value!=='string'||!value.trim()||!isAbsolute(value))throw Error(label+' must be an absolute path.');
 return resolve(value);
}
async function requireFile(path,label,{nonEmpty=false}={}){
 let info;try{info=await stat(path)}catch{throw Error(label+' must refer to an existing file.')}
 if(!info.isFile()||(nonEmpty&&info.size===0))throw Error(label+' must refer to a nonempty regular file.');
 return info;
}
async function requireDirectory(path,label){
 let info;try{info=await stat(path)}catch{throw Error(label+' must refer to an existing directory.')}
 if(!info.isDirectory())throw Error(label+' must refer to an existing directory.');
}
function archivePath(cli){
 const parts=cli.split(sep);const index=parts.findIndex(part=>extname(part).toLowerCase()==='.asar');
 if(index<0||index>=parts.length-1||!['.js','.cjs','.mjs'].includes(extname(cli).toLowerCase()))throw Error('dshCli must name a JavaScript entry inside a desktop .asar archive.');
 return parts.slice(0,index+1).join(sep)||sep;
}
async function deriveCli(executable){
 for(const resources of [join(dirname(executable),'resources'),resolve(dirname(executable),'..','Resources')]){
  const archive=join(resources,'app.asar');
  try{await requireFile(archive,'DSH desktop archive',{nonEmpty:true})}catch{continue}
  return join(archive,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js');
 }
 throw Error('Cannot find a nonempty desktop app.asar archive next to the DSH executable.');
}
function samePath(first,second){
 const normalize=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
 return normalize(first)===normalize(second);
}
async function canonicalIfPresent(path){try{return await realpath(path)}catch{return resolve(path)}}
async function inspectTarget(path){
 let info;try{info=await lstat(path)}catch(error){if(error.code==='ENOENT')return undefined;throw error}
 if(info.isSymbolicLink()||!info.isFile())throw Error('The settings target must be a regular file, not a directory or symbolic link.');
 return info;
}
async function existingFile(path){
 const info=await inspectTarget(path);if(!info)return undefined;
 const contents=await readFile(path);
 const after=await inspectTarget(path);
 if(!after||info.ino!==after.ino||info.dev!==after.dev||info.mtimeMs!==after.mtimeMs||info.size!==after.size)throw Error('The settings target changed while it was being read.');
 return {info,contents};
}
function sameMetadata(contents,settings){
 try{
  const parsed=JSON.parse(contents.toString('utf8').replace(/^\uFEFF/,''));
  if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')return false;
  const keys=Object.keys(settings);
  return Object.keys(parsed).length===keys.length&&keys.every(key=>parsed[key]===settings[key]);
 }catch{return false}
}
function assertAdjacent(path,parent){
 if(!samePath(dirname(path),parent))throw Error('Refusing a write outside the specified settings directory.');
}
async function unlinkOwned(path,parent){
 assertAdjacent(path,parent);
 try{await unlink(path)}catch(error){if(error.code!=='ENOENT')throw error}
}
async function writeExclusive(path,contents,mode,parent){
 assertAdjacent(path,parent);let handle;let created=false;
 try{
  handle=await open(path,'wx',mode);created=true;
  await handle.writeFile(contents);await handle.chmod(mode);await handle.sync();
 }catch(error){
  if(handle){await handle.close();handle=undefined}
  if(created)await unlinkOwned(path,parent);
  throw error;
 }finally{if(handle)await handle.close()}
}

/** Write local runtime path metadata only; no application or credential file is read. */
export async function configureLocalRuntime(options,{userHome=homedir()}={}){
 if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Expected local runtime configuration options.');
 const permitted=new Set(['dshExecutable','dshHome','dshCli','settings']);
 for(const key of Object.keys(options))if(!permitted.has(key))throw Error('Unknown configuration option: '+key);
 const home=absolutePath(userHome,'User home');
 const dshExecutable=absolutePath(options.dshExecutable,'dshExecutable');
 const dshHome=absolutePath(options.dshHome??join(home,'.dsh'),'dshHome');
 const settingsPath=absolutePath(options.settings??join(home,'.deep-seek-harness-mcp','local-runtime.json'),'settings');
 await requireFile(dshExecutable,'DSH executable');await requireDirectory(dshHome,'DSH home');
 const desktopProfile=join(dshHome,'profiles','desktop','cordis.patch.yml');
 await requireFile(desktopProfile,'DSH desktop profile');
 const dshCli=options.dshCli===undefined?await deriveCli(dshExecutable):absolutePath(options.dshCli,'dshCli');
 const archive=archivePath(dshCli);await requireFile(archive,'DSH desktop archive',{nonEmpty:true});
 const settings={dshExecutable,dshCli,dshHome,desktopProfile};
 const protectedPaths=await Promise.all([
  dshExecutable,archive,desktopProfile,join(dshHome,'.credentials.yaml'),
  join(home,'.local','share','opencode','auth.json'),join(home,'.codex','config.toml'),
 ].map(canonicalIfPresent));
 await inspectTarget(settingsPath);
 const canonicalTarget=await canonicalIfPresent(settingsPath);
 if(protectedPaths.some(path=>samePath(path,canonicalTarget)))throw Error('The settings target is a protected source or configuration file.');
 const parent=dirname(settingsPath);
 await mkdir(parent,{recursive:true});
 const actualParent=await realpath(parent);const target=join(actualParent,basename(settingsPath));
 const existing=await existingFile(target);
 if(existing&&sameMetadata(existing.contents,settings))return {settingsPath,settings,changed:false,backupPath:null};
 let backupPath=null;
 if(existing){
  backupPath=join(actualParent,basename(target)+'.backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await writeExclusive(backupPath,existing.contents,0o600,actualParent);
 }
 const temporaryPath=join(actualParent,basename(target)+'.tmp-'+randomUUID());
 let temporaryCreated=false;
 try{
  const mode=existing?(existing.info.mode&0o777):0o600;
  await writeExclusive(temporaryPath,JSON.stringify(settings,null,2)+'\n',mode,actualParent);temporaryCreated=true;
  const current=await existingFile(target);
  if(Boolean(current)!==Boolean(existing)||(existing&&current&&(
   current.info.ino!==existing.info.ino||current.info.dev!==existing.info.dev||
   current.info.mtimeMs!==existing.info.mtimeMs||!current.contents.equals(existing.contents)
  )))throw Error('The settings target changed while it was being configured; no replacement was made.');
  assertAdjacent(temporaryPath,actualParent);assertAdjacent(target,actualParent);
  await rename(temporaryPath,target);temporaryCreated=false;
 }finally{if(temporaryCreated)await unlinkOwned(temporaryPath,actualParent)}
 return {settingsPath,settings,changed:true,backupPath};
}

export async function configureFromArgs(argv,defaults){
 const options=parseConfigureArgs(argv);
 if(options.help)return {help:USAGE};
 return configureLocalRuntime(options,defaults);
}

if(process.argv[1]&&samePath(resolve(process.argv[1]),fileURLToPath(import.meta.url))){
 try{
  const result=await configureFromArgs(process.argv.slice(2));
  if(result.help)console.log(result.help);
  else{
   console.log((result.changed?'Saved local DSH path settings: ':'Local DSH path settings are already current: ')+result.settingsPath);
   if(result.backupPath)console.log('Previous settings backup: '+result.backupPath);
  }
 }catch(error){console.error('configure-local: '+(error instanceof Error?error.message:String(error)));process.exitCode=1}
}
