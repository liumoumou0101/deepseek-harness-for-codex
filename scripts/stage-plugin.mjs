import {cp,copyFile,mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const dist=join(root,'dist');
await copyFile(join(root,'src','read-model-config.cjs'),join(dist,'read-model-config.cjs'));
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
const notices=[];
for(const [packagePath,entry]of Object.entries(lock.packages??{})){
 if(!packagePath||entry.dev||!packagePath.startsWith('node_modules/'))continue;
 const directory=resolve(root,packagePath),child=relative(root,directory);
 if(child.startsWith('..')||isAbsolute(child))throw Error('Invalid dependency path');
 let files;try{files=await readdir(directory)}catch{continue}
 const name=files.find(file=>/^licen[cs]e(?:\.(?:md|txt))?$/i.test(file));
 if(!name)continue;
 const metadata=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
 notices.push(`\n===== ${metadata.name}@${metadata.version} =====\n${await readFile(join(directory,name),'utf8')}`);
}
await writeFile(join(dist,'THIRD_PARTY_NOTICES.txt'),'Bundled runtime dependency notices.\n'+notices.join('\n'),'utf8');
const plugin=join(root,'plugins','deepseek-harness');
await mkdir(join(plugin,'dist'),{recursive:true});
await cp(dist,join(plugin,'dist'),{recursive:true});
await copyFile(join(root,'LICENSE'),join(plugin,'LICENSE'));
console.log('Staged the self-contained MCP server and its local DSH helper.');
