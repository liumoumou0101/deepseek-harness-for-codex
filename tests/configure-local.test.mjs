import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,stat,unlink,symlink,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureLocalRuntime,configureFromArgs,parseConfigureArgs} from '../scripts/configure-local.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cache=join(repo,'node_modules','.cache','configure-local-tests');
await mkdir(cache,{recursive:true});
const script=join(repo,'scripts','configure-local.mjs');
const fakeSecret='FAKE_PROFILE_KEY_MUST_NOT_APPEAR_IN_SETTINGS';
async function fixture({mac=false}={}){
 const base=await mkdtemp(join(cache,'case-'));
 const userHome=join(base,'用户 home');const dshHome=join(userHome,'.dsh');
 const executable=mac?join(base,'DSH 中文.app','Contents','MacOS','DeepSeek Harness'):join(base,'安装 folder','DeepSeek Harness.exe');
 const archive=mac?resolve(dirname(executable),'..','Resources','app.asar'):join(dirname(executable),'resources','app.asar');
 const cli=join(archive,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js');
 const profile=join(dshHome,'profiles','desktop','cordis.patch.yml');
 await mkdir(dirname(executable),{recursive:true});await writeFile(executable,'test executable placeholder');
 await mkdir(dirname(archive),{recursive:true});await writeFile(archive,'test archive placeholder');
 await mkdir(dirname(profile),{recursive:true});await writeFile(profile,'apiKey: '+fakeSecret+'\n');
 const settings=join(base,'输出 folder','local-runtime.json');
 return {base,userHome,dshHome,executable,archive,cli,profile,settings,options:{dshExecutable:executable,dshHome,settings},defaults:{userHome}};
}

test('writes only four path fields with spaces and Chinese characters',async()=>{
 const f=await fixture();const result=await configureLocalRuntime(f.options,f.defaults);
 const saved=await readFile(f.settings,'utf8');const parsed=JSON.parse(saved);
 assert.deepEqual(Object.keys(parsed).sort(),['desktopProfile','dshCli','dshExecutable','dshHome'].sort());
 assert.equal(parsed.dshExecutable,f.executable);assert.equal(parsed.dshCli,f.cli);assert.equal(parsed.dshHome,f.dshHome);assert.equal(parsed.desktopProfile,f.profile);
 assert.ok(!saved.includes(fakeSecret));assert.equal(result.changed,true);assert.equal(result.settingsPath,f.settings);assert.equal(result.backupPath,null);
 assert.equal(await readFile(f.profile,'utf8'),'apiKey: '+fakeSecret+'\n');
 if(process.platform!=='win32')assert.equal((await stat(f.settings)).mode&0o777,0o600);
});
test('defaults metadata and DSH home below the explicitly supplied test user home',async()=>{
 const f=await fixture();const result=await configureLocalRuntime({dshExecutable:f.executable},f.defaults);
 assert.equal(result.settingsPath,join(f.userHome,'.deep-seek-harness-mcp','local-runtime.json'));
 assert.equal(result.settings.dshHome,f.dshHome);assert.equal(result.settings.desktopProfile,f.profile);
});
test('same metadata is idempotent and creates no backup',async()=>{
 const f=await fixture();await configureLocalRuntime(f.options,f.defaults);const before=await readFile(f.settings,'utf8');
 const result=await configureLocalRuntime(f.options,f.defaults);assert.equal(result.changed,false);assert.equal(result.backupPath,null);assert.equal(await readFile(f.settings,'utf8'),before);assert.deepEqual(await readdir(dirname(f.settings)),['local-runtime.json']);
});
test('semantically identical JSON with different formatting is unchanged',async()=>{
 const f=await fixture();const first=await configureLocalRuntime(f.options,f.defaults);const compact=JSON.stringify(first.settings);await writeFile(f.settings,compact);
 const result=await configureLocalRuntime(f.options,f.defaults);assert.equal(result.changed,false);assert.equal(await readFile(f.settings,'utf8'),compact);assert.deepEqual(await readdir(dirname(f.settings)),['local-runtime.json']);
});
test('changed settings preserve an independent adjacent backup before replacement',async()=>{
 const f=await fixture();await configureLocalRuntime(f.options,f.defaults);const original=await readFile(f.settings,'utf8');
 const newCli=join(f.archive,'alternate','host','cli.js');const result=await configureLocalRuntime({...f.options,dshCli:newCli},f.defaults);
 assert.equal(result.changed,true);assert.ok(result.backupPath);assert.equal(dirname(result.backupPath),dirname(f.settings));assert.match(result.backupPath,/local-runtime\.json\.backup-/);
 assert.equal(await readFile(result.backupPath,'utf8'),original);assert.equal(JSON.parse(await readFile(f.settings,'utf8')).dshCli,newCli);assert.ok(!(await readdir(dirname(f.settings))).some(name=>name.includes('.tmp-')));
 await writeFile(f.settings,'different metadata');assert.equal(await readFile(result.backupPath,'utf8'),original);
});
test('replacement retains existing file permissions when the platform supports them',async()=>{
 const f=await fixture();await configureLocalRuntime(f.options,f.defaults);await chmod(f.settings,0o640);const prior=(await stat(f.settings)).mode&0o777;
 await configureLocalRuntime({...f.options,dshCli:join(f.archive,'new','cli.js')},f.defaults);
 assert.equal((await stat(f.settings)).mode&0o777,prior);
});
test('unknown flags are rejected before any target parent is created',async()=>{
 const f=await fixture();await assert.rejects(configureFromArgs(['--dsh-executable',f.executable,'--dsh-home',f.dshHome,'--settings',f.settings,'--unknown','value'],f.defaults),/Unknown option/);assert.equal(existsSync(dirname(f.settings)),false);
});
test('duplicate and valueless flags are rejected',()=>{
 assert.throws(()=>parseConfigureArgs(['--dsh-executable','one','--dsh-executable','two']),/Duplicate option/);
 assert.throws(()=>parseConfigureArgs(['--dsh-executable','--settings','somewhere']),/requires a value/);
});
for(const kind of ['missing-executable','relative-executable','relative-settings','missing-profile','missing-archive','empty-archive','non-asar-cli'])test('invalid '+kind+' does not write settings',async()=>{
 const f=await fixture();const options={...f.options};
 if(kind==='missing-executable')options.dshExecutable=join(f.base,'missing.exe');
 if(kind==='relative-executable')options.dshExecutable='relative.exe';
 if(kind==='relative-settings')options.settings='relative-settings.json';
 if(kind==='missing-profile')await unlink(f.profile);
 if(kind==='missing-archive')await unlink(f.archive);
 if(kind==='empty-archive')await writeFile(f.archive,'');
 if(kind==='non-asar-cli')options.dshCli=join(f.base,'outside-cli.js');
 await assert.rejects(configureLocalRuntime(options,f.defaults));assert.equal(existsSync(dirname(f.settings)),false);
});
test('rejects a directory at the target path without creating backups',async()=>{
 const f=await fixture();await mkdir(f.settings,{recursive:true});await assert.rejects(configureLocalRuntime(f.options,f.defaults),/regular file/);assert.deepEqual(await readdir(dirname(f.settings)),['local-runtime.json']);
});
test('rejects target symlinks or directory junctions',async t=>{
 const f=await fixture();const linkTarget=join(f.base,'link-target');await mkdir(linkTarget);await mkdir(dirname(f.settings));
 try{await symlink(linkTarget,f.settings,process.platform==='win32'?'junction':'dir')}catch(error){if(['EPERM','ENOTSUP','EACCES'].includes(error.code)){t.skip('This environment does not permit symlink/junction creation');return}throw error}
 await assert.rejects(configureLocalRuntime(f.options,f.defaults),/regular file|symbolic link/);assert.deepEqual(await readdir(linkTarget),[]);assert.deepEqual(await readdir(dirname(f.settings)),['local-runtime.json']);
});
test('rejects the desktop profile or credential store as the metadata target',async()=>{
 const f=await fixture();const credentialPath=join(f.dshHome,'.credentials.yaml');await writeFile(credentialPath,'never copy credentials');
 await assert.rejects(configureLocalRuntime({...f.options,settings:f.profile},f.defaults),/source|protected/);await assert.rejects(configureLocalRuntime({...f.options,settings:credentialPath},f.defaults),/source|protected/);
 assert.equal(await readFile(f.profile,'utf8'),'apiKey: '+fakeSecret+'\n');assert.equal(await readFile(credentialPath,'utf8'),'never copy credentials');
});
test('derives the macOS bundle Resources archive without executing the application',async()=>{
 const f=await fixture({mac:true});const result=await configureLocalRuntime(f.options,f.defaults);assert.equal(result.settings.dshCli,f.cli);
});
test('the CLI writes path-only settings and reports failures without profile contents',async()=>{
 const f=await fixture();const args=[script,'--dsh-executable',f.executable,'--dsh-home',f.dshHome,'--settings',f.settings];
 const success=spawnSync(process.execPath,args,{encoding:'utf8',shell:false,windowsHide:true});assert.equal(success.status,0,success.stderr);assert.equal(Object.keys(JSON.parse(await readFile(f.settings,'utf8'))).length,4);assert.ok(!(success.stdout+success.stderr).includes(fakeSecret));
 const failed=spawnSync(process.execPath,[...args,'--unknown'],{encoding:'utf8',shell:false,windowsHide:true});assert.notEqual(failed.status,0);assert.match(failed.stderr,/Unknown option/);assert.ok(!(failed.stdout+failed.stderr).includes(fakeSecret));
});
