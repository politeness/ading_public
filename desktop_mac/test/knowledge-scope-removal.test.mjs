import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access,chmod} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {KnowledgeService,KnowledgeRemovalRecordError} from '../dist/knowledge/service.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-knowledge-removal-'));
const store=new LocalStore(dir);await store.init();
try {
 const me=await store.currentUser();
 const workspace=await store.createWorkspace({name:'project',path:path.join(dir,'project')});
 const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'fixture',executablePath:'/fixture/codex'}]);
 const conversation=await store.createConversation({name:'private memory',memberIds:[agent.userId],workspaceId:workspace.workspaceId});
 const old={workspacePath:workspace.path,sharesKnowledge:true,knowledgeOwnerId:workspace.workspaceId};
 const resolve=async conversation=>{const workspace=await store.getWorkspace(conversation.workspaceId);return workspace?.path?{workspacePath:workspace.path,sharesKnowledge:true,knowledgeOwnerId:workspace.workspaceId}:{workspacePath:path.join(dir,'inbox',conversation.conversationId),sharesKnowledge:false};};
 const calls=[];let reject=true;
 const syncer={invalidate:()=>{},ensureSynced:async()=>[],
  unsyncMemories:async(resolution,kinds,context)=>{calls.push({kind:'conversation',resolution,kinds,context});assert.equal(await store.getConversation(context.conversationId),null,'central scope deletion precedes native withdrawal');if(reject)throw Error('fixture permission failure');return ['/owned/removed'];},
  unsyncWorkspace:async(resolution,kinds,context)=>{calls.push({kind:'workspace',resolution,kinds,context});assert.equal(await store.getWorkspace(resolution.knowledgeOwnerId),null);if(reject)throw Error('fixture permission failure');return ['/owned/workspace-removed'];}};
 const options={kinds:()=>['codex','qoder'],resolveWorkspace:resolve,fallback:()=>({workspacePath:dir,sharesKnowledge:false})};
 const service=new KnowledgeService(store,syncer,options);
 await service.removeScope('conversation',conversation.conversationId,old,()=>store.deleteConversation(conversation.conversationId));
 assert.ok(service.syncState().failures.some(failure=>failure.category==='removal'&&failure.detail==='fixture permission failure'&&failure.agents.join()==='codex,qoder'),'failed withdrawal is reported per Agent it could not reach');
 const pending=path.join(dir,'knowledge-pending-removals.json');
 const queue=JSON.parse(await readFile(pending,'utf8'));
 assert.equal(queue.length,1);assert.equal(queue[0].userId,me.userId);assert.equal(queue[0].resolution.workspacePath,old.workspacePath);
 const otherUserStore=new Proxy(store,{get:(target,key)=>key==='currentUser'?async()=>({...me,userId:'another-account'}):typeof target[key]==='function'?target[key].bind(target):target[key]});
 const before=calls.length;
 await new KnowledgeService(otherUserStore,syncer,options).refresh();assert.equal(calls.length,before,'another account cannot withdraw the stored scope');
 reject=false;
 const resumed=new KnowledgeService(store,syncer,options);await resumed.saved();
 assert.equal(calls.at(-1).context.userId,me.userId);assert.equal(calls.at(-1).context.conversationId,conversation.conversationId);
 await assert.rejects(access(pending),error=>error.code==='ENOENT','successful retry clears the central tombstone');
 reject=true;
 await resumed.removeScope('workspace',workspace.workspaceId,old,()=>store.deleteWorkspace(workspace.workspaceId));
 assert.equal(JSON.parse(await readFile(pending,'utf8'))[0].kind,'workspace');
 reject=false;await new KnowledgeService(store,syncer,options).saved();
 assert.equal(calls.at(-1).kind,'workspace');assert.deepEqual(calls.at(-1).context,{userId:me.userId});
 assert.equal(calls.at(-1).resolution.workspacePath,workspace.path);
 await assert.rejects(access(pending),error=>error.code==='ENOENT');
 const unchanged=await store.createWorkspace({name:'unchanged',path:path.join(dir,'unchanged')});
 await resumed.removeScope('workspace',unchanged.workspaceId,{workspacePath:unchanged.path,sharesKnowledge:true,knowledgeOwnerId:unchanged.workspaceId},()=>store.updateWorkspace(unchanged.workspaceId,{path:unchanged.path}));
 await assert.rejects(access(pending),error=>error.code==='ENOENT','no-op scope selection leaves no pending cleanup');
 await assert.rejects(resumed.removeScope('workspace',unchanged.workspaceId,{workspacePath:unchanged.path,sharesKnowledge:true,knowledgeOwnerId:unchanged.workspaceId},()=>Promise.reject(Error('central mutation rejected'))),/central mutation rejected/);
 await assert.rejects(access(pending),error=>error.code==='ENOENT','failed central deletion cancels cleanup intent');
 await writeFile(pending,'invalid sync queue fixture');
 let mutated=false;
 await assert.rejects(resumed.removeScope('workspace',unchanged.workspaceId,{workspacePath:unchanged.path,sharesKnowledge:true,knowledgeOwnerId:unchanged.workspaceId},async()=>{mutated=true;return store.updateWorkspace(unchanged.workspaceId,{name:'must not be saved'});}),error=>error instanceof KnowledgeRemovalRecordError&&error.cause instanceof SyntaxError,'an unreadable withdrawal queue blocks the scope change instead of dropping its records');
 assert.equal(mutated,false);assert.equal((await store.getWorkspace(unchanged.workspaceId)).name,'unchanged');
 assert.equal(await readFile(pending,'utf8'),'invalid sync queue fixture','existing queue is never overwritten by a failed append');
 await rm(pending);
 // A withdrawal record that cannot be persisted must abort the central deletion, otherwise native copies leak forever.
 const readOnly=await mkdtemp(path.join(dir,'readonly-knowledge-'));await chmod(readOnly,0o500);
 try {
  const unwritable=new Proxy(store,{get:(target,key)=>key==='knowledgeRoot'?async()=>readOnly:typeof target[key]==='function'?target[key].bind(target):target[key]});
  const doomed=await store.createConversation({name:'disk full',memberIds:[agent.userId],workspaceId:unchanged.workspaceId});
  const withdrawals=calls.length;let deleted=false;
  await assert.rejects(new KnowledgeService(unwritable,syncer,options).removeScope('conversation',doomed.conversationId,old,async()=>{deleted=true;return store.deleteConversation(doomed.conversationId);}),error=>error instanceof KnowledgeRemovalRecordError&&error.cause.code==='EACCES'&&/EACCES/.test(error.message),'persistence failure reaches the caller as a typed error main.ts can localize');
  assert.equal(deleted,false,'central scope is not deleted without a durable withdrawal record');
  assert.ok(await store.getConversation(doomed.conversationId),'conversation survives the failed deletion');
  assert.equal(calls.length,withdrawals,'no withdrawal is attempted for a scope that still exists');
  await assert.rejects(access(path.join(readOnly,'knowledge-pending-removals.json')),error=>error.code==='ENOENT');
 }finally{await chmod(readOnly,0o700);}
 await assert.rejects(resumed.removeScope('workspace',unchanged.workspaceId,{workspacePath:unchanged.path,sharesKnowledge:true,knowledgeOwnerId:unchanged.workspaceId},()=>Promise.reject(Error('central still fails'))),/central still fails/);
 await assert.rejects(access(pending),error=>error.code==='ENOENT');
 console.log('knowledge scope removal: central first, durable withdrawal retry after restart, account protection, workspace-only cleanup and no-op/failure cleanup and fail-closed withdrawal persistence passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
