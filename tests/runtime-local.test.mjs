import test from 'node:test';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {readFile,writeFile,mkdtemp,mkdir,copyFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir,homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const sourceRoot=fileURLToPath(new URL('../src/',import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'dsh-runtime-unit-'));
const build=join(temp,'build');await mkdir(build);
const source=await readFile(join(sourceRoot,'runtime.ts'),'utf8');
await writeFile(join(build,'runtime.mjs'),stripTypeScriptTypes(source));
const helperSource=join(sourceRoot,'read-model-config.cjs');
try{await copyFile(helperSource,join(build,'read-model-config.cjs'))}catch(error){if(error.code!=='ENOENT')throw error}
const runtime=await import(new URL('file:///'+join(build,'runtime.mjs').replaceAll('\\','/')));
const dshHome=join(temp,'user home');await mkdir(dshHome);
const credentialPath=join(dshHome,'.credentials.yaml');
const keyFixture='unit-test-credential-value-never-output';
await writeFile(credentialPath,JSON.stringify({refs:{CUSTOM_PROVIDER_KEY:keyFixture}}));
const modules=join(temp,'installation','node_modules');
const cli=join(modules,'@deepseek-ai','dsh-desktop-host','lib','cli.js');
await mkdir(dirname(cli),{recursive:true});
await writeFile(cli,"console.log('fixture-dsh-version');");
const yamlDirectory=join(modules,'yaml');await mkdir(yamlDirectory);
await writeFile(join(yamlDirectory,'package.json'),JSON.stringify({main:'index.cjs'}));
await writeFile(join(yamlDirectory,'index.cjs'),"exports.parseDocument=text=>{try{return {errors:[],toJS:()=>JSON.parse(text)}}catch{return {errors:[Error('source must not be printed')],toJS:()=>null}}};");
const profile=join(temp,'desktop-model.yml');
const modelPatch=[{id:'agent-default-model',config:{provider:'fixture-provider',model:'fixture-model',reasoningEffort:'low'}},{id:'llm-pi-ai',config:{providers:{'fixture-provider':{baseURL:'https://example.invalid/provider/v1',apiKeyEnv:'CUSTOM_PROVIDER_KEY',models:[{id:'fixture-model',name:'Fixture Model',maxTokens:4096},{id:'unused-model',name:'Unused'}]}}}}];
await writeFile(profile,JSON.stringify(modelPatch));
const settings=join(temp,'local-runtime.json');
await writeFile(settings,JSON.stringify({dshExecutable:process.execPath,dshCli:cli,dshHome,desktopProfile:profile}));
const env={...process.env,DSH_MCP_RUNTIME:'local',DSH_MCP_LOCAL_SETTINGS:settings};
const workspace=join(temp,'workspace with spaces & shell symbols');await mkdir(workspace);
const serviceHome=join(temp,'service');await mkdir(serviceHome);

test('local mode runs the configured executable directly and leaves shell symbols literal',()=>{
 const command=runtime.buildHarnessWebCommand({workspace,serviceHome},env);
 assert.equal(command.command,process.execPath);
 assert.equal(command.args[0],'--expose-internals');
 assert.ok(command.args.includes(cli));assert.ok(command.args.includes('--no-open'));
 assert.equal(command.cwd,workspace);assert.equal(command.env.DSH_CWD,workspace);
 assert.equal(command.env.DSH_HOME,serviceHome);assert.equal(command.env.ELECTRON_RUN_AS_NODE,'1');
 assert.equal(command.env.DSH_PERMISSION_MODE,'workspace-write');
 assert.ok(!command.args.some(value=>value.startsWith('--package=')));
});
test('service overlay copies only the selected model and stores a credential reference',async()=>{
 const command=runtime.buildHarnessWebCommand({workspace,serviceHome},env);
 const patchPath=command.args[command.args.indexOf('--patch')+1];
 assert.ok(patchPath?.startsWith(serviceHome));
 const contents=await readFile(patchPath,'utf8');assert.ok(!contents.includes(keyFixture));
 const patch=JSON.parse(contents);
 assert.equal(patch.find(item=>item.id==='agent-default-model').config.provider,'fixture-provider');
 const provider=patch.find(item=>item.id==='llm-pi-ai').config.providers['fixture-provider'];
 assert.equal(provider.apiKeyEnv,'CUSTOM_PROVIDER_KEY');assert.equal(provider.models.length,1);
 assert.equal(provider.models[0].id,'fixture-model');
 assert.equal(patch.find(item=>item.id==='credentials').config.path,undefined);
 assert.ok(!contents.includes(JSON.stringify(credentialPath)));
 assert.equal(command.env.CUSTOM_PROVIDER_KEY,keyFixture);
 assert.equal(patch.find(item=>item.id==='credentials').config.watch,false);
 assert.equal(patch.find(item=>item.id==='deepseek-account').disabled,true);
 assert.equal(await readFile(credentialPath,'utf8'),JSON.stringify({refs:{CUSTOM_PROVIDER_KEY:keyFixture}}));
});
test('doctor recognizes a stored referenced credential without printing its value',()=>{
 const report=runtime.inspectRuntime(env);
 assert.equal(report.ready,true);assert.equal(report.harnessSource,'installed-desktop');
 assert.equal(report.modelProvider,'fixture-provider');assert.equal(report.model,'fixture-model');
 assert.equal(report.credentialAvailable,true);assert.equal(report.apiKeyInEnvironment,false);
 assert.ok(!JSON.stringify(report).includes(keyFixture));
});
test('an explicit local settings file selects local mode without setting a global environment variable',()=>{
 const autoEnv={...env};delete autoEnv.DSH_MCP_RUNTIME;
 const command=runtime.buildHarnessWebCommand({workspace,serviceHome},autoEnv);
 assert.equal(command.command,process.execPath);
 assert.ok(command.args.includes(cli));
});
test('explicit npm mode preserves custom executable and package overrides',()=>{
 const command=runtime.buildHarnessWebCommand({workspace,serviceHome},{...env,DSH_MCP_RUNTIME:'npm',DSH_MCP_NPX_COMMAND:'fixture-npx',DSH_MCP_HARNESS_PACKAGE:'fixture-package@1.2.3'});
 assert.equal(command.command,'fixture-npx');
 assert.deepEqual(command.args,['--yes','--package=fixture-package@1.2.3','--','dsh','web','--port','0']);
});
test('local mode rejects missing and invalid configuration before launching any service',()=>{
 assert.throws(()=>runtime.buildHarnessWebCommand({workspace,serviceHome},{DSH_MCP_RUNTIME:'local',DSH_MCP_LOCAL_SETTINGS:join(temp,'missing.json')}),/local|settings|config/i);
 const report=runtime.inspectRuntime({DSH_MCP_RUNTIME:'local',DSH_MCP_LOCAL_SETTINGS:join(temp,'missing.json')});
 assert.equal(report.ready,false);assert.equal(report.harnessSource,'installed-desktop');
});
test('helper rejects inline secrets without printing the offending configuration',async()=>{
 const unsafe=structuredClone(modelPatch);unsafe[1].config.providers['fixture-provider'].headers={Authorization:'do-not-print-this-test-value'};
 const unsafeProfile=join(temp,'unsafe.yml');await writeFile(unsafeProfile,JSON.stringify(unsafe));
 const unsafeSettings=join(temp,'unsafe-runtime.json');await writeFile(unsafeSettings,JSON.stringify({dshExecutable:process.execPath,dshCli:cli,dshHome,desktopProfile:unsafeProfile}));
 const helper=join(build,'read-model-config.cjs');
 const result=spawnSync(process.execPath,['--expose-internals',helper,unsafeSettings],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/secret|credential|header/i);
 assert.ok(!result.stdout.includes('do-not-print-this-test-value'));assert.ok(!result.stderr.includes('do-not-print-this-test-value'));
});
test('invalid runtime selection is rejected rather than silently falling back',()=>{
 assert.throws(()=>runtime.buildHarnessWebCommand({workspace,serviceHome},{DSH_MCP_RUNTIME:'typo'}),/DSH_MCP_RUNTIME/);
});
if(process.platform==='win32'){
 test('default Windows npx uses Node and its JavaScript CLI without a shell',()=>{
  const command=runtime.buildHarnessWebCommand({workspace,serviceHome},{...process.env,DSH_MCP_RUNTIME:'npm'});
  assert.equal(command.command,process.execPath);
  assert.match(command.args[0],/[\\/]npm[\\/]bin[\\/]npx-cli\.js$/);
  assert.equal(command.args[1],'--yes');
 });
 test('an explicit missing npx.cmd path never falls back to an unrelated npm installation',()=>{
  assert.throws(()=>runtime.buildHarnessWebCommand({workspace,serviceHome},{DSH_MCP_RUNTIME:'npm',DSH_MCP_NPX_COMMAND:join(temp,'missing','npx.cmd')}),/npx|npm/i);
 });
}

test('helper rejects credentials embedded in provider URLs',async()=>{
 const unsafe=structuredClone(modelPatch);unsafe[1].config.providers['fixture-provider'].baseURL='https://user:url-test-value@example.invalid/v1?token=query-test-value';
 const unsafeProfile=join(temp,'unsafe-url.yml');await writeFile(unsafeProfile,JSON.stringify(unsafe));
 const unsafeSettings=join(temp,'unsafe-url-runtime.json');await writeFile(unsafeSettings,JSON.stringify({dshExecutable:process.execPath,dshCli:cli,dshHome,desktopProfile:unsafeProfile}));
 const result=spawnSync(process.execPath,['--expose-internals',join(build,'read-model-config.cjs'),unsafeSettings],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/credentials|tokens/i);
 assert.ok(!result.stdout.includes('url-test-value'));assert.ok(!result.stderr.includes('url-test-value'));assert.ok(!result.stderr.includes('query-test-value'));
});
test('invalid local settings objects produce a configuration error without raw input',async()=>{
 const invalidSettings=join(temp,'null-runtime.json');await writeFile(invalidSettings,'null');
 assert.throws(()=>runtime.buildHarnessWebCommand({workspace,serviceHome},{DSH_MCP_RUNTIME:'local',DSH_MCP_LOCAL_SETTINGS:invalidSettings}),/valid local DSH settings|local DSH settings require/i);
});

test('only the selected stored credential is passed through the child environment',async()=>{
 const isolatedHome=join(temp,'private-store-source');await mkdir(isolatedHome);
 const isolatedCredentialPath=join(isolatedHome,'.credentials.yaml');
 const sourceDocument=JSON.stringify({refs:{CUSTOM_PROVIDER_KEY:keyFixture,UNUSED_UNIT_PROVIDER_KEY:'unit-unused-credential-value'}});
 await writeFile(isolatedCredentialPath,sourceDocument);
 const originalHash=createHash('sha256').update(sourceDocument).digest('hex');
 const isolatedSettings=join(temp,'private-store-runtime.json');
 await writeFile(isolatedSettings,JSON.stringify({dshExecutable:process.execPath,dshCli:cli,dshHome:isolatedHome,desktopProfile:profile}));
 const launchEnv={...env,DSH_MCP_LOCAL_SETTINGS:isolatedSettings,CUSTOM_PROVIDER_KEY:'unit-launch-environment-value'};
 const command=runtime.buildHarnessWebCommand({workspace,serviceHome},launchEnv);
 assert.equal(command.env.CUSTOM_PROVIDER_KEY,keyFixture);
 assert.equal(command.env.UNUSED_UNIT_PROVIDER_KEY,undefined);
 assert.equal(launchEnv.CUSTOM_PROVIDER_KEY,'unit-launch-environment-value');
 const overlay=await readFile(command.args[command.args.indexOf('--patch')+1],'utf8');
 assert.ok(!overlay.includes(keyFixture));assert.ok(!overlay.includes('unit-unused-credential-value'));
 assert.ok(!overlay.includes(JSON.stringify(isolatedCredentialPath)));
 assert.equal(createHash('sha256').update(await readFile(isolatedCredentialPath)).digest('hex'),originalHash);
 const report=runtime.inspectRuntime(launchEnv);
 assert.equal(report.credentialAvailable,true);
 assert.ok(!JSON.stringify(report).includes(keyFixture));assert.ok(!JSON.stringify(report).includes('unit-unused-credential-value'));
 assert.equal(report.privateEnvironment,undefined);
});
test('helper rejects an API-key-shaped credential reference without echoing it',async()=>{
 const malformed=structuredClone(modelPatch);malformed[1].config.providers['fixture-provider'].apiKeyEnv='sk-unit-invalid-ref-value';
 const malformedProfile=join(temp,'invalid-reference.yml');await writeFile(malformedProfile,JSON.stringify(malformed));
 const malformedSettings=join(temp,'invalid-reference-runtime.json');await writeFile(malformedSettings,JSON.stringify({dshExecutable:process.execPath,dshCli:cli,dshHome,desktopProfile:malformedProfile}));
 const result=spawnSync(process.execPath,['--expose-internals',join(build,'read-model-config.cjs'),malformedSettings],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.equal(result.stdout,'');
 assert.match(result.stderr,/valid environment credential reference/i);
 assert.ok(!result.stderr.includes('sk-unit-invalid-ref-value'));
 const report=runtime.inspectRuntime({...env,DSH_MCP_LOCAL_SETTINGS:malformedSettings});
 assert.equal(report.ready,false);assert.ok(!JSON.stringify(report).includes('sk-unit-invalid-ref-value'));
});
test('a missing stored credential can use the selected launch environment value privately',async()=>{
 const emptyHome=join(temp,'empty-store-source');await mkdir(emptyHome);
 const emptySettings=join(temp,'empty-store-runtime.json');
 await writeFile(emptySettings,JSON.stringify({dshExecutable:process.execPath,dshCli:cli,dshHome:emptyHome,desktopProfile:profile}));
 const launchEnv={...env,DSH_MCP_LOCAL_SETTINGS:emptySettings,CUSTOM_PROVIDER_KEY:'unit-launch-only-credential'};
 const command=runtime.buildHarnessWebCommand({workspace,serviceHome},launchEnv);
 assert.equal(command.env.CUSTOM_PROVIDER_KEY,'unit-launch-only-credential');
 const report=runtime.inspectRuntime(launchEnv);
 assert.equal(report.credentialAvailable,true);assert.equal(report.apiKeyInEnvironment,true);
 assert.ok(!JSON.stringify(report).includes('unit-launch-only-credential'));
});
