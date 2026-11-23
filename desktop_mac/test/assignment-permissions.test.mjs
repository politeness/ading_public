import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {PermissionPolicy} from '../dist/permissions/policy.js';

// Exercise the real scheduler -> approval policy boundary for a readOnly work
// item. Reading the source and saving a separate report must be compatible.
for (const [mode,allow] of [['unattended',true],['manual',true],['manual',false],['leader',true],['leader',false]]) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'ading-assignment-permissions-'));
 const store=new LocalStore(path.join(dir,'data'));await store.init();
 const discovered=['codex','qoder-cn'].map(kind=>({kind,localUuid:kind,executablePath:'/mock'}));
 const users=await store.syncDiscoveredAgents(discovered);
 const leader=users.find(a=>a.localUuid==='codex'),worker=users.find(a=>a.localUuid==='qoder-cn');
 const source=path.join(dir,'source.txt'),report=path.join(dir,'report.txt');
 await writeFile(source,'SOURCE_UNCHANGED');
 let human=0,review=0,finished=false,planned=false,executionCount=0;
 const errors=[],audits=[],profiles=[];
 const policy=new PermissionPolicy(path.join(dir,'policy.json'),{
  manual:async()=>{human++;return allow;},review:async()=>{review++;return allow;},
  audit:async(_t,_a,m,allowed)=>{audits.push({mode:m,allowed});}
 });await policy.set(mode);
 let conversation;
 const scheduler=new LocalScheduler({idleRetryLimit:0,store,
  syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),
  resolveDiscovered:id=>discovered.find(d=>users.find(u=>u.localUuid===d.localUuid)?.userId===id),
  isAgentReady:()=>true,broadcast:()=>{},log:async(event,data)=>{if(event==='permission-profile')profiles.push(data);},
  getPermissionMode:async()=>mode,
  requestPermission:(t,a,r)=>policy.request(t,a,r),
  registry:{cancel:()=>true,runTurn:async(d,input)=>{
   let message='SKIP';
   try {
    if(d.kind==='codex'&&!planned){
     planned=true;
     message=JSON.stringify({control:{action:'plan',work:[{id:'review-source',assignment:'核查原件，保存独立报告，不修改原件',candidates:[worker.userId],dependsOn:[],outputs:['report.txt'],acceptance:'原件不变，报告内容正确',readOnly:true}]}});
    } else if(d.kind==='qoder-cn') {
     const assignment=await scheduler.assignmentFor(conversation.conversationId,worker.userId);
     // A human's ordinary message now wakes every Agent member; before the
     // Leader plans, the worker has nothing assigned and skips by default.
     if(!assignment){message='SKIP';}
     else if(assignment.phase==='proposal'){
      assert.equal(input.discussionOnly,true);assert.equal(input.fullAccess,false);assert.equal(input.onPermission,undefined);
      message='同意，我按这个方案执行，重点核实原件是否完整，遇到无法核实的内容会如实报告。';
     } else {
      executionCount++;assert.equal(assignment.phase,'accepted');
      assert.equal(input.discussionOnly,false);assert.equal(input.fullAccess,true,'a verification assignment must not disable the report-writing tool');
      assert.match(input.prompt,/不得修改被核查的原件/);assert.match(input.prompt,/保存独立报告/);
      const content=await readFile(source,'utf8');
      assert.equal(input.permissionMode,mode);
      const allowed=mode==='unattended' ? (assert.equal(input.onPermission,undefined),true) : await input.onPermission({requestId:'report',toolName:'Write',input:{file_path:report,content},workspacePath:dir,signal:input.signal});
      if(allowed)await writeFile(report,content);
      message=allowed?'已核查，独立报告已保存。':`写入未获授权。\n${JSON.stringify({control:{action:'blocked',assignmentId:assignment.id,reason:'写入未获授权'}})}`;
      finished=true;
     }
    }
   } catch(e){errors.push(e);finished=true;}
   return {ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}};
  }}
 });
 try {
  conversation=await store.createConversation({name:'核查原件并保存报告',memberIds:[leader.userId,worker.userId],leaderId:leader.userId});
  // charter.mode no longer exists; an earlier Agent reply is what now keeps a
  // group out of the joint brainstorm, so the Leader plans directly.
  await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'earlier-reply',senderId:leader.userId,content:'收到。',agentReply:{turnId:'earlier-reply',inputSeq:0,raw:'收到。'}});
  const me=await store.currentUser();
  const incoming=await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'start',senderId:me.userId,content:'核查原件并保存报告'});
  await scheduler.dispatch(conversation,incoming);
  for(let i=0;i<600;i++){
   if(finished&&scheduler.runtimeSnapshot().agents.length===0)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.deepEqual(errors,[]);assert.ok(finished);assert.equal(executionCount,1);
  assert.equal(await readFile(source,'utf8'),'SOURCE_UNCHANGED');
  if(allow)assert.equal(await readFile(report,'utf8'),'SOURCE_UNCHANGED');
  else await assert.rejects(readFile(report),{code:'ENOENT'});
  assert.equal(human,mode==='manual'?1:0);assert.equal(review,mode==='leader'?1:0);
  assert.deepEqual(audits,mode==='unattended'?[]:[{mode,allowed:allow}]);
  assert.ok(profiles.some(p=>p.agent===worker.userId&&p.sourceReadOnly&&p.fullAccess&&p.permissionMode===mode&&p.fastApproval===(mode==='unattended')&&p.approvalHost===(mode!=='unattended')));
  const messages=await store.listMessages(conversation.conversationId,{limit:100});
  assert.ok(messages.some(m=>m.coordination?.phase===(allow?'result':'rejected')));
 } finally {await scheduler.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}
}
console.log('assignment-permissions: source constraints, independent report writes, all three policies, denial and negotiation isolation passed');
