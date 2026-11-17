import assert from 'node:assert/strict';
import {readdir,rm,mkdir,writeFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {LocalStore} from '../dist/store/local.js';
import {KnowledgeCloudSync} from '../dist/knowledge/cloud-sync.js';

// Fake backend: like conductor, only accepts the skill/memory directories, rejects paths escaping the directory, and files go through "signed URLs". stats confirm no extra transfers
const oss=new Map(),stats={uploads:0,downloads:0,removes:0};
const safe=name=>!name.split('/').some(part=>!part||part==='.'||part==='..');
const locks={holder:undefined,seq:0,ttlSeconds:300,retryAfterSeconds:0,denied:0};
const api=async(method,route,body)=>{
 if(route==='/api/v1/knowledge/lock'){
  if(locks.holder){locks.denied++;return {ok:true,data:{granted:false,ttlSeconds:locks.ttlSeconds,retryAfterSeconds:locks.retryAfterSeconds}};}
  locks.holder=`lock-${++locks.seq}`;
  return {ok:true,data:{granted:true,token:locks.holder,ttlSeconds:locks.ttlSeconds,retryAfterSeconds:locks.retryAfterSeconds}};
 }
 if(route==='/api/v1/knowledge/lock/renew')return {ok:true,data:{held:body.token===locks.holder}};
 if(route==='/api/v1/knowledge/lock/release'){if(body.token===locks.holder)locks.holder=undefined;return {ok:true,data:null};}
 const [,kind,action]=route.match(/^\/api\/v1\/knowledge\/(\w+)\/(\w+)$/)??[];
 assert.ok(kind==='skill'||kind==='memory',route);
 if(action==='objects')return {ok:true,data:[...oss].filter(([key])=>key.startsWith(`${kind}/`)).map(([key,item])=>({name:key.slice(kind.length+1),etag:`"${item.etag}"`,size:item.body.length}))};
 const names=[...(body.uploads??[]),...(body.downloads??[]),...(body.deletes??[])];
 assert.ok(names.length<=100,'the backend signs at most 100 at a time');
 if((body.uploads?.length||body.deletes?.length)&&body.lockToken!==locks.holder)return {ok:false,kind:'rejected',status:409,code:'KNOW_004',message:'lock lost'};
 if(names.some(name=>!safe(name)))return {ok:false,kind:'rejected',status:400,code:'KNOW_002',message:'bad name'};
 const url=name=>`${kind}/${name}`;
 return {ok:true,data:{uploads:Object.fromEntries((body.uploads??[]).map(name=>[name,{url:url(name),contentType:'application/octet-stream'}])),downloads:Object.fromEntries((body.downloads??[]).map(name=>[name,url(name)])),deletes:Object.fromEntries((body.deletes??[]).map(name=>[name,url(name)]))}};
};
const transport={
 async upload(url,bytes){stats.uploads++;const body=Buffer.from(bytes),etag=createHash('md5').update(body).digest('hex').toUpperCase();oss.set(url,{body,etag});return `"${etag}"`;},
 async download(url){stats.downloads++;assert.ok(oss.has(url),url);return oss.get(url).body;},
 async remove(url){stats.removes++;oss.delete(url);}
};
const head=id=>`skill/${id}/.ading-meta.json`;
const skillObjects=id=>[...oss.keys()].filter(key=>key.startsWith(`skill/${id}/`)).map(key=>key.slice(`skill/${id}/`.length)).sort();
const setJson=(key,value)=>{const body=Buffer.from(JSON.stringify(value));oss.set(key,{body,etag:createHash('md5').update(body).digest('hex').toUpperCase()});};
const root=await mkdtemp('knowledge-cloud-');
const logs=[];
async function device(name){
 const store=new LocalStore(path.join(root,name));await store.init();
 let pulled=0;
 const sync=new KnowledgeCloudSync({store,api,transport,log:(event,data)=>logs.push({event,data}),onPulled:()=>{pulled++;}});
 return {store,sync,pulledCount:()=>pulled};
}
const idle=async(fn)=>{const before={...stats};await fn();assert.deepEqual({...stats},before,'nothing changed, so nothing is transferred');};
const human={authorKind:'human'};
const skillFile=async(store,id,file)=>{const skill=await store.getSkill(id);return (await store.exportKnowledge()).skills.find(item=>item.skill.skillId===skill.skillId).files.find(item=>item.path===file);};

try {
 const a=await device('a'),b=await device('b');

 // 1. A full skill package (with scripts and executable bits) and memories upload, and a second computer pulls them as-is; a whole pull round notifies Agent sync only once
 const source=path.join(root,'source');await mkdir(path.join(source,'scripts'),{recursive:true});
 await writeFile(path.join(source,'SKILL.md'),'---\nname: demo\ndescription: d\n---\n\n正文\n');
 await writeFile(path.join(source,'scripts/run.sh'),'#!/bin/sh\necho hi\n');await chmod(path.join(source,'scripts/run.sh'),0o755);
 const binary=Buffer.from([0,255,254,128,10,13,0,1]);
 await writeFile(path.join(source,'scripts/图标.bin'),binary);
 const demo=await a.store.importSkill({sourcePath:source,scope:'global',...human});
 const memoryA=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'记住这个',...human});
 const memoryB=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'还有这个',...human});
 await a.sync.sync();
 assert.deepEqual(skillObjects(demo.skillId),['.ading-meta.json','SKILL.md','scripts/run.sh','scripts/图标.bin'],'a skill is a real directory on OSS');
 assert.match(oss.get(`skill/${demo.skillId}/SKILL.md`).body.toString(),/正文/,'its files are readable as they are');
 assert.equal([...oss.keys()].filter(key=>key.startsWith('memory/')).length,2,'one object per memory entry');
 await b.sync.sync();
 assert.equal(b.pulledCount(),1,'agents are refreshed once per round, not per entry');
 const pulled=await b.store.getSkill(demo.skillId);
 assert.equal(pulled.name,'demo');assert.equal(pulled.updatedAt,demo.updatedAt,'keeps the original timestamp');
 assert.equal(pulled.source.fingerprint,demo.source.fingerprint,'the package arrives byte for byte');
 assert.equal((await skillFile(b.store,demo.skillId,'scripts/run.sh')).mode&0o777,0o755);
 assert.deepEqual(Buffer.from((await skillFile(b.store,demo.skillId,'scripts/图标.bin')).bytes),binary,'binary files survive');
 assert.deepEqual((await b.store.listMemories('user','u_me')).map(item=>item.content),['记住这个','还有这个']);

 // 2. Running again after alignment transfers nothing, and freshly pulled content is not uploaded back as a local change
 await idle(()=>b.sync.sync());await idle(()=>a.sync.sync());

 // 3. One side edits, the other catches up
 await b.store.updateSkill(demo.skillId,{content:'B 改的正文'});
 await b.store.updateMemory(memoryA.memoryId,{content:'B 改的记忆'});
 await b.sync.sync();await a.sync.sync();
 assert.equal((await a.store.getSkill(demo.skillId)).content.trim(),'B 改的正文');
 assert.equal((await a.store.listMemories('user','u_me')).find(item=>item.memoryId===memoryA.memoryId).content,'B 改的记忆');
 assert.ok(await skillFile(a.store,demo.skillId,'scripts/run.sh'),'editing the body keeps the other package files');
 // Only the body changed: upload only changed files and the manifest, without re-uploading other files
 const beforeEdit=stats.uploads;
 await a.store.updateSkill(demo.skillId,{content:'只改正文'});await a.sync.sync();
 assert.equal(stats.uploads-beforeEdit,2,'SKILL.md and the manifest only');
 await b.sync.sync();assert.equal((await b.store.getSkill(demo.skillId)).content.trim(),'只改正文');
 // Re-import with one file removed: the old file on OSS is deleted, and it disappears on the other computer too
 await rm(path.join(source,'scripts/图标.bin'));
 await a.store.importSkill({sourcePath:source,skillId:demo.skillId,scope:'global',...human});await a.sync.sync();
 assert.deepEqual(skillObjects(demo.skillId),['.ading-meta.json','SKILL.md','scripts/run.sh'],'a removed file is deleted from OSS');
 await b.sync.sync();assert.equal(await skillFile(b.store,demo.skillId,'scripts/图标.bin'),undefined);
 await b.store.updateSkill(demo.skillId,{content:'B 改的正文'});await b.sync.sync();await a.sync.sync();

 // 4. Delete propagation: write a tombstone without deleting objects; a new computer does not pull back deleted items
 await a.store.deleteMemory(memoryB.memoryId);
 await a.sync.sync();await b.sync.sync();
 assert.equal((await b.store.listMemories('user','u_me')).some(item=>item.memoryId===memoryB.memoryId),false);
 assert.equal(JSON.parse(oss.get(`memory/${memoryB.memoryId}.json`).body).deleted,true);
 await idle(()=>b.sync.sync());
 const c=await device('c');await c.sync.sync();
 assert.equal((await c.store.listMemories('user','u_me')).some(item=>item.memoryId===memoryB.memoryId),false);
 assert.equal((await c.store.listMemories('user','u_me')).length,1);

 // 5. Both sides edit: newer wins, the loser is kept in the local conflict directory; both sides end up consistent
 await a.store.updateSkill(demo.skillId,{content:'A 的旧改动'});
 await new Promise(resolve=>setTimeout(resolve,5));
 await b.store.updateSkill(demo.skillId,{content:'B 的新改动'});
 await a.sync.sync();await b.sync.sync();await a.sync.sync();
 assert.equal((await a.store.getSkill(demo.skillId)).content.trim(),'B 的新改动');
 assert.equal((await b.store.getSkill(demo.skillId)).content.trim(),'B 的新改动');
 assert.equal((await readdir(path.join(root,'b/knowledge-cloud-conflicts'))).length,1,'the losing copy is kept locally');

 // 6. Two computers each import a skill with the same name (same native directory name, only one can stay): keep the newer, tombstone the older, without getting stuck on a directory-name conflict
 const same=path.join(root,'same');await mkdir(same);
 await writeFile(path.join(same,'SKILL.md'),'---\nname: same\ndescription: d\n---\n\n旧\n');
 const older=await a.store.importSkill({sourcePath:same,scope:'global',...human});
 await a.sync.sync();
 await new Promise(resolve=>setTimeout(resolve,5));
 await writeFile(path.join(same,'SKILL.md'),'---\nname: same\ndescription: d\n---\n\n新\n');
 const newerSkill=await b.store.importSkill({sourcePath:same,scope:'global',...human});
 assert.equal(newerSkill.directoryName,older.directoryName);
 await b.sync.sync();await a.sync.sync();await b.sync.sync();
 for(const {store} of [a,b]) {
  assert.equal(await store.getSkill(older.skillId),null);
  assert.equal((await store.getSkill(newerSkill.skillId)).content.trim(),'新');
 }
 // Hand-written same-name skills have an ID suffix in the directory name, so no conflict: keep both, without deciding for the user whether they are the same
 const typedA=await a.store.createSkill({name:'typed',description:'',content:'A',scope:'global',...human});
 const typedB=await b.store.createSkill({name:'typed',description:'',content:'B',scope:'global',...human});
 await a.sync.sync();await b.sync.sync();await a.sync.sync();
 assert.equal((await a.store.getSkill(typedB.skillId)).content.trim(),'B');
 assert.equal((await b.store.getSkill(typedA.skillId)).content.trim(),'A');

 // 7. Edit on one side while deleting on the other: keep the content, lose no data
 await a.store.deleteSkill(demo.skillId);
 await new Promise(resolve=>setTimeout(resolve,5));
 await b.store.updateSkill(demo.skillId,{content:'删除时还在改'});
 await b.sync.sync();await a.sync.sync();
 assert.equal((await a.store.getSkill(demo.skillId)).content.trim(),'删除时还在改');

 // 8. Bad cloud content: do not write to disk, report and record the error, other entries unaffected, recovers next round once fixed
 const before=oss.get(head(demo.skillId));
 const manifest=JSON.parse(before.body.toString());
 manifest.updatedAt=new Date(Date.now()+60000).toISOString();
 manifest.skill.description='坏掉的新版本';
 const failed=()=>logs.some(item=>item.event==='knowledge-cloud-sync-failed');
 const keepsLocal=async()=>assert.equal((await a.store.getSkill(demo.skillId)).content.trim(),'删除时还在改');
 const extra=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'损坏时新增',...human});
 // 8a. Files and manifest do not match (e.g. another computer is mid-upload): keep the local copy
 setJson(head(demo.skillId),{...manifest,files:manifest.files.map(file=>file.path==='SKILL.md'?{...file,sha256:'0'.repeat(64)}:file)});
 logs.length=0;await a.sync.sync();assert.ok(failed());await keepsLocal();
 assert.ok(oss.has(`memory/${extra.memoryId}.json`),'a bad object does not stop the rest');
 // 8b. Manifest is missing a file
 setJson(head(demo.skillId),{...manifest,files:[...manifest.files,{path:'missing.txt',size:1,sha256:'0'.repeat(64),mode:420}]});
 logs.length=0;await a.sync.sync().catch(()=>{});assert.ok(failed());await keepsLocal();
 // 8c. Manifest contains a path escaping the directory
 setJson(head(demo.skillId),{...manifest,files:[...manifest.files,{path:'../../evil',size:1,sha256:'0'.repeat(64),mode:420}]});
 logs.length=0;await a.sync.sync();assert.ok(failed());await keepsLocal();
 // 8d. Manifest is not JSON
 oss.set('memory/m_bad.json',{body:Buffer.from('not json'),etag:'BAD'});
 logs.length=0;await a.sync.sync();assert.ok(failed());
 oss.set(head(demo.skillId),before);oss.delete('memory/m_bad.json');
 logs.length=0;await a.sync.sync();
 assert.ok(!failed(),JSON.stringify(logs));
 await keepsLocal();

 // 8e. Upload breaks between files and manifest: other computers keep the old manifest untouched, and the uploader finishes next round
 const crashAfterFiles=transport.upload;
 transport.upload=async(url,bytes,type)=>{if(url===head(demo.skillId))throw new Error('upload failed: HTTP 500');return crashAfterFiles(url,bytes,type);};
 await a.store.updateSkill(demo.skillId,{content:'断点续传'});
 await a.sync.sync();transport.upload=crashAfterFiles;
 assert.equal((await b.store.getSkill(demo.skillId)).content.trim()==='断点续传',false);
 await b.sync.sync();
 assert.notEqual((await b.store.getSkill(demo.skillId)).content.trim(),'断点续传','the old manifest means nothing changed');
 await a.sync.sync();await b.sync.sync();
 assert.equal((await b.store.getSkill(demo.skillId)).content.trim(),'断点续传','the uploader finishes on its next round');
 await a.store.updateSkill(demo.skillId,{content:'删除时还在改'});await a.sync.sync();await b.sync.sync();

 // 8f. Deleting a skill: the directory is emptied, leaving only a manifest marked deleted
 const doomed=await a.store.createSkill({name:'doomed',description:'',content:'x',scope:'global',...human});
 await a.sync.sync();await b.sync.sync();
 await b.store.deleteSkill(doomed.skillId);await b.sync.sync();await a.sync.sync();
 assert.deepEqual(skillObjects(doomed.skillId),['.ading-meta.json']);
 assert.equal(JSON.parse(oss.get(head(doomed.skillId)).body.toString()).deleted,true);
 assert.equal(await a.store.getSkill(doomed.skillId),null);

 // 9. Backend unavailable: only log, do not throw, local content untouched
 const down=new KnowledgeCloudSync({store:a.store,api:async()=>({ok:false,kind:'network',status:0,message:'offline'}),transport,log:(event,data)=>logs.push({event,data})});
 logs.length=0;
 await down.sync();
 assert.ok(logs.some(item=>item.event==='knowledge-cloud-sync-failed'));
 await down.stop();

 // 10. UI notices: offline and signed-out states do not disturb; backend errors must notify; dismissed after one successful round; still notify when mixed with real errors
 const statuses=[];let answer={ok:false,kind:'network',status:0,message:'offline'};
 const report=new KnowledgeCloudSync({store:a.store,api:async(...args)=>answer??api(...args),transport,log:()=>{},onStatus:status=>statuses.push(status)});
 await report.sync();assert.deepEqual(statuses,[],'offline is not reported');
 answer={ok:false,kind:'signed-out',status:0,message:'signed out'};await report.sync();assert.deepEqual(statuses,[],'signed out is not reported');
 answer={ok:false,kind:'server',status:500,code:'FILE_008',message:'x'.repeat(1000)};await report.sync();
 assert.equal(statuses.length,1);assert.match(statuses[0],/FILE_008/);assert.ok(statuses[0].length<=300,'long reasons are bounded');
 answer=undefined;await report.sync();assert.equal(statuses.at(-1),undefined,'a clean round clears the failure');
 const realUpload=transport.upload;
 transport.upload=async()=>{throw new TypeError('fetch failed');};
 const offlineMemory=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'上传时断网',...human});
 statuses.length=0;await report.sync();assert.deepEqual(statuses,[],'losing the network during a transfer is not reported');
 transport.upload=async()=>{throw new Error('upload failed: HTTP 403');};
 await report.sync();assert.match(statuses.at(-1),/HTTP 403/,'a signed URL rejected by OSS is reported');
 transport.upload=realUpload;
 await report.sync();assert.equal(statuses.at(-1),undefined);assert.ok(oss.has(`memory/${offlineMemory.memoryId}.json`),'the retry uploads what failed');
 await report.stop();

 // 11. Queuing: while a is uploading, b cannot get the lock, writes nothing and reports no failure; after a releases the lock, b retries automatically and completes
 assert.equal(locks.holder,undefined,'every round gives the lock back, failed ones too');
 let releaseUpload,uploadStarted;const started=new Promise(resolve=>{uploadStarted=resolve;});
 const realUpload2=transport.upload;
 transport.upload=async(...args)=>{uploadStarted();await new Promise(resolve=>{releaseUpload=resolve;});transport.upload=realUpload2;return realUpload2(...args);};
 const queuedA=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'A 排队',...human});
 const queuedB=await b.store.appendMemory({scope:'user',ownerId:'u_me',content:'B 排队',...human});
 const roundA=a.sync.sync();await started;
 const writesBefore=oss.size,deniedBefore=locks.denied,statusB=[];
 const waiting=new KnowledgeCloudSync({store:b.store,api,transport,log:()=>{},onStatus:status=>statusB.push(status)});
 await waiting.sync();
 assert.equal(locks.denied,deniedBefore+1,'b was told to wait');
 assert.equal(oss.has(`memory/${queuedB.memoryId}.json`),false,'b writes nothing without the lock');
 assert.equal(oss.size,writesBefore);assert.deepEqual(statusB,[],'waiting in line is not a failure');
 // Queuing must not dismiss an earlier failure notice either: only a fully completed round counts as recovery
 releaseUpload();await roundA;
 assert.ok(oss.has(`memory/${queuedA.memoryId}.json`));
 const deadline=Date.now()+15000;
 while(!oss.has(`memory/${queuedB.memoryId}.json`)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
 assert.ok(oss.has(`memory/${queuedB.memoryId}.json`),'b retried by itself after a finished');
 await waiting.stop();
 assert.equal(statusB.at(-1),undefined);

 // 12. Lost lock (e.g. the computer slept past expiry and the lock went to someone else): the backend rejects writes, this round stops without reporting failure, and a retry fills it in
 const lost=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'丢锁时新增',...human});
 const statusLost=[];
 const stealing=async(method,route,body)=>{
  if(route==='/api/v1/knowledge/memory/urls'&&body.uploads?.length&&!stolen){stolen=true;locks.holder='someone-else';}
  return api(method,route,body);
 };
 let stolen=false;
 const victim=new KnowledgeCloudSync({store:a.store,api:stealing,transport,log:()=>{},onStatus:status=>statusLost.push(status)});
 await victim.sync();
 assert.equal(oss.has(`memory/${lost.memoryId}.json`),false,'the backend refused the stale holder');
 assert.deepEqual(statusLost,[],'losing the lock is not shown as a failure');
 assert.equal(locks.holder,'someone-else','a stale holder cannot release the new holder\'s lock');
 locks.holder=undefined;
 await victim.sync();
 assert.ok(oss.has(`memory/${lost.memoryId}.json`),'the next round uploads it');
 await victim.stop();

 // 13. Heartbeat: renew periodically while holding the lock; stop writing once the lock is found lost
 locks.ttlSeconds=0.09;
 let renews=0;const counting=async(method,route,body)=>{if(route.endsWith('/lock/renew'))renews++;return api(method,route,body);};
 const pause=transport.upload;
 transport.upload=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,200));transport.upload=pause;return pause(...args);};
 await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'慢上传',...human});
 const slow=new KnowledgeCloudSync({store:a.store,api:counting,transport,log:()=>{}});
 await slow.sync();await slow.stop();
 assert.ok(renews>=2,`renewed ${renews} times`);
 locks.ttlSeconds=300;
 assert.equal(locks.holder,undefined);

 // 14. Auto upload after changes: consecutive changes are batched for a few seconds into one round; nothing triggers after stop
 const typed=await a.store.appendMemory({scope:'user',ownerId:'u_me',content:'连续改动一',...human});
 let rounds=0;const countRounds=async(method,route,body)=>{if(route==='/api/v1/knowledge/lock')rounds++;return api(method,route,body);};
 const auto=new KnowledgeCloudSync({store:a.store,api:countRounds,transport,log:()=>{}});
 auto.schedule();auto.schedule();auto.schedule();
 assert.equal(oss.has(`memory/${typed.memoryId}.json`),false,'it waits a moment first');
 const autoDeadline=Date.now()+10000;
 while(!oss.has(`memory/${typed.memoryId}.json`)&&Date.now()<autoDeadline)await new Promise(resolve=>setTimeout(resolve,50));
 assert.ok(oss.has(`memory/${typed.memoryId}.json`),'the change is uploaded without waiting for the hourly check');
 assert.equal(rounds,1,'several quick changes make one round');
 auto.schedule();await auto.stop();
 await new Promise(resolve=>setTimeout(resolve,3300));
 assert.equal(rounds,1,'stop cancels what was scheduled');

 for(const item of [a,b,c]){await item.sync.stop();await item.store.close();}
 console.log('knowledge cloud sync ok');
} finally {
 await rm(root,{recursive:true,force:true});
}
