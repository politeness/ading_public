import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-parallel-routing-')),store=new LocalStore(dir);await store.init();
const ds=['codex','claude-code','qoder','qoder-cn','qwen-code','kiro','copilot','antigravity'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const agents=await store.syncDiscoveredAgents(ds),codex=agents.find(a=>a.kind==='codex'),peer=agents.find(a=>a.kind==='qoder-cn'),me=await store.currentUser();
const calls=[],schedulers=[];
const make=extra=>{const scheduler=new LocalScheduler({store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>ds.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{},requestPermission:async()=>false,registry:{adapterFor:kind=>({supportsParallelWork:['codex','claude-code','qoder','qoder-cn','qwen-code','kiro','copilot','antigravity'].includes(kind)}),cancel:()=>true,runTurn:async(_a,input)=>{calls.push({...input,agentKind:_a.kind});input.onRuntimeConfig?.({model:'gpt-fixture',reasoningEffort:'low',serviceTier:'priority'});return {ok:true,message:'SKIP',threadId:'new-thread',steps:[],metrics:{iterations:0,sideEffects:false}};}},...extra});schedulers.push(scheduler);return scheduler;};
try{
 const direct=await store.createConversation({name:'direct',memberIds:[codex.userId],leaderId:codex.userId});
 await store.appendMessage({conversationId:direct.conversationId,clientMessageId:'user',senderId:me.userId,content:'处理独立文件'});
 await store.saveAgentSession({conversationId:direct.conversationId,agentUserId:codex.userId,providerThreadId:'old-thread'});
 await make().runAgentTurn(direct,codex);
 const a=calls.at(-1);assert.equal(a.threadId,undefined,'old provider session rebuilt to register the shared subtask tool');assert.deepEqual(a.parallelWork,{key:`${direct.conversationId}:${codex.userId}`,limit:10,executionSlot:false,allowSplit:true,planBeforeExecution:false,sessionBudget:11});assert.match(a.prompt,/处理独立文件/);
 assert.match(a.prompt,/阿钉已为当前工作准备好顶层厂商会话/);assert.match(a.prompt,/统一的 ading_parallel 子任务通道/);assert.match(a.prompt,/最多同时运行 10 项/);assert.match(a.prompt,/厂商原生子 Agent/);
 assert.match(a.prompt,/短小同质工作/);assert.match(a.prompt,/一次本地工具调用/,'shared prompt avoids expensive child contexts for trivial batches');
 assert.match(a.prompt,/开工先建立输入清单并选择执行形态/,'shared prompt asks for an early parallel or direct execution choice');assert.doesNotMatch(a.prompt,/不超过 2 次|长边不超过/,'no tool-call budget in the shared prompt');
 assert.match(a.prompt,/最终回复明确标为复用/,'stale artifacts cannot masquerade as fresh execution speed');
 assert.match(a.prompt,/不从相似位置移字拼贴，不推测或生成补齐/,'unverifiable reconstruction cannot consume a repair loop');
 assert.match(a.prompt,/机械操作直接一次批量执行/,'deterministic work skips a ceremonial sample round trip');
 assert.match(a.prompt,/coverage-audit/,'inferred all-item selection gets an independent coverage pass');
 assert.match(a.prompt,/dependsOn 样本/,'sample and production work are submitted as one dependency graph');
 assert.match(a.prompt,/定位根因再修正，直到达到要求/,'the parent keeps correcting until the work meets the bar');assert.doesNotMatch(a.prompt,/最多一次|改用一次|停止并报告|等待用户选择/,'no instruction tells the agent to stop and report after a fixed retry count');
 assert.match(a.prompt,/独立候选路径，对照检查/,'repairs preserve the last usable artifact until a candidate passes');
 const pinned=await store.getAgentSession(direct.conversationId,codex.userId);assert.deepEqual([pinned.runtimeConfig.model,pinned.runtimeConfig.reasoningEffort,pinned.runtimeConfig.serviceTier],['gpt-fixture','low','priority'],'effective Codex configuration is pinned with the task session');assert.equal(pinned.parallelToolsVersion,8);
 for(const kind of ['claude-code','qoder','qoder-cn']){
 const agent=agents.find(a=>a.kind===kind);
 const conversation=await store.createConversation({name:kind+' direct',memberIds:[agent.userId],leaderId:agent.userId});
 await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:kind+'-user',senderId:me.userId,content:'处理独立文件'});
 await make().runAgentTurn(conversation,agent);
 assert.equal(calls.at(-1).parallelWork?.allowSplit,true,kind+' receives the shared subtask channel');
 assert.equal(calls.at(-1).parallelWork?.sessionBudget,11,kind+' receives the same ten-child budget');
 }
 const followup=await store.appendMessage({conversationId:direct.conversationId,clientMessageId:'followup',senderId:me.userId,content:'再检查另外三个独立文件'});
 await make().runAgentTurn(direct,codex);
 assert.equal(calls.at(-1).parallelWork.planBeforeExecution,false,'new human request stays in the existing provider session');
 await store.markProcessed(direct.conversationId,codex.userId,followup.seq);
 await store.appendMessage({conversationId:direct.conversationId,clientMessageId:'progress',senderId:codex.userId,type:'SYSTEM',content:'工具进度更新'});
 await make().runAgentTurn(direct,codex);
 assert.equal(calls.at(-1).parallelWork.planBeforeExecution,false,'progress alone does not repeat planning');
 for(const agent of agents.filter(a=>a.kind!=='codex')){
 const conversation=await store.createConversation({name:agent.kind+' group',memberIds:[agent.userId,codex.userId],leaderId:codex.userId,charter:{mode:'execution'}});
 await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:agent.kind+'-assignment',senderId:codex.userId,type:'TASK',content:'当前工作',coordination:{id:agent.kind+'-assignment',assigneeId:agent.userId,phase:'accepted',brief:'处理独立文件'}});
 await make().runAgentTurn(conversation,agent);
 const groupInput=calls.find(c=>c.parallelWork?.key===`${conversation.conversationId}:${agent.userId}`);
 assert.ok(groupInput,agent.kind+' group execution receives the shared subtask channel');
 assert.equal(groupInput.parallelWork.allowSplit,true,agent.kind+' group execution enables child tasks');
 assert.equal(groupInput.parallelWork.sessionBudget,11,agent.kind+' group execution receives ten child contexts');
 assert.equal(groupInput.parallelWork.planBeforeExecution,false,agent.kind+' group assignment reuses the Leader decomposition');
 }
 const group=await store.createConversation({name:'group',memberIds:[codex.userId,peer.userId],leaderId:peer.userId,charter:{mode:'execution'}});
 await store.appendMessage({conversationId:group.conversationId,clientMessageId:'assignment',senderId:peer.userId,type:'TASK',content:'当前工作',coordination:{id:'assignment',assigneeId:codex.userId,phase:'accepted',brief:'处理独立文件'}});
 await make().runAgentTurn(group,codex);
 const b=calls.find(c=>c.parallelWork?.key===`${group.conversationId}:${codex.userId}`);assert.ok(b,'group execution receives the shared execution policy');assert.equal(b.parallelWork.allowSplit,true,'accepted group executor receives the same subtask channel');assert.equal(b.parallelWork.sessionBudget,11);assert.equal(b.parallelWork.planBeforeExecution,false);assert.equal(b.parallelWork.key,`${group.conversationId}:${codex.userId}`);assert.notEqual(a.parallelWork.key,b.parallelWork.key,'same Agent different tasks keep independent execution state');
 const discussion=await store.createConversation({name:'discussion',memberIds:[codex.userId,peer.userId],leaderId:peer.userId,charter:{mode:'discussion'}});
 await make().runAgentTurn(discussion,codex);assert.equal(calls.at(-1).parallelWork,undefined,'discussion cannot start work');
 const replay=await store.createConversation({name:'replay-without-provider-thread',memberIds:[codex.userId],leaderId:codex.userId});
 const original=await store.appendMessage({conversationId:replay.conversationId,clientMessageId:'replay-user',senderId:me.userId,content:'必须继承的完整讨论结论'});
 await store.markProcessed(replay.conversationId,codex.userId,original.seq);
 await make().runAgentTurn(await store.getConversation(replay.conversationId),codex);
 assert.match(calls.at(-1).prompt,/必须继承的完整讨论结论/,'a watermark alone cannot hide context when no provider thread exists');
 // Negotiating and then executing is one conversation, not two. A turn without the
 // child-task channel used to leave the contract version unset, which the next
 // execution turn read as "written by an older build" and rebuilt the thread - so a
 // task that alternates phases burned a fresh top-level session every round.
 const cycling=await store.createConversation({name:'cycling',memberIds:[codex.userId,peer.userId],leaderId:peer.userId,charter:{mode:'execution'}});
 const accept=async id=>store.appendMessage({conversationId:cycling.conversationId,clientMessageId:id,senderId:peer.userId,type:'TASK',content:'当前工作',coordination:{id:'cycle',assigneeId:codex.userId,phase:'accepted',brief:'处理独立文件'}});
 const codexTurn=async()=>{const mark=calls.length;await make().runAgentTurn(await store.getConversation(cycling.conversationId),codex);
  const mine=calls.slice(mark).filter(c=>c.agentKind==='codex');assert.ok(mine.length,'the scheduled turn reached the provider');return mine[0];};
 await store.appendMessage({conversationId:cycling.conversationId,clientMessageId:'cycle-proposal',senderId:peer.userId,type:'TASK',content:'当前工作',coordination:{id:'cycle',assigneeId:codex.userId,phase:'proposal',brief:'处理独立文件'}});
 const negotiation=await codexTurn();
 assert.equal(negotiation.parallelWork,undefined,'negotiation has no child-task channel');
 const negotiated=await store.getAgentSession(cycling.conversationId,codex.userId);
 assert.equal(negotiated.parallelToolsVersion,8,'a turn without the channel still records the contract version');
 assert.equal(negotiated.providerThreadGeneration,1);
 await accept('cycle-accepted');
 const execution=await codexTurn();
 assert.equal(execution.threadId,'new-thread','execution resumes the negotiation thread instead of opening a second top-level session');
 assert.equal(execution.parallelWork?.allowSplit,true,'and it is the execution turn that gained the child-task channel');
 assert.equal((await store.getAgentSession(cycling.conversationId,codex.userId)).providerThreadGeneration,1,'a negotiate-then-execute cycle costs one provider session');

 // The protocol is delivered once per thread. A resumed thread is told only what
 // changed, instead of receiving thousands of identical tokens every turn.
 assert.match(execution.prompt,/委派必须用结构化控制/,'a thread that has not seen this protocol receives it in full');
 assert.match(execution.prompt,/统一的 ading_parallel 子任务通道/);
 await accept('cycle-still-accepted');
 await store.appendMessage({conversationId:cycling.conversationId,clientMessageId:'cycle-more',senderId:me.userId,content:'再处理一批'});
 const resumed=await codexTurn();
 assert.equal(resumed.threadId,'new-thread');
 assert.doesNotMatch(resumed.prompt,/委派必须用结构化控制/,'the collaboration protocol is not repeated into the same thread');
 assert.doesNotMatch(resumed.prompt,/统一的 ading_parallel 子任务通道/,'neither are the method and child-task rules');
 assert.match(resumed.prompt,/本轮不再重复/,'the turn says the earlier protocol still applies');
 assert.match(resumed.prompt,/再处理一批/,'what actually changed is still delivered');
 assert.ok(resumed.prompt.length<execution.prompt.length/2,`a resumed turn is far smaller (${resumed.prompt.length} vs ${execution.prompt.length})`);

 // A rebuilt thread has never seen the protocol, so it must receive it again.
 await store.saveAgentSession({conversationId:cycling.conversationId,agentUserId:codex.userId,providerThreadId:undefined,protocolDigest:undefined});
 await accept('cycle-fresh');
 await store.appendMessage({conversationId:cycling.conversationId,clientMessageId:'cycle-again',senderId:me.userId,content:'新一轮'});
 assert.match((await codexTurn()).prompt,/委派必须用结构化控制/,'a new provider thread always receives the full protocol');
 console.log('parallel-routing: one top-level session plus shared ten-child channel for every adapter in direct and group execution, legacy migration, replay, discussion isolation, one session across a negotiate-execute cycle and one protocol delivery per thread passed');
}finally{for(const s of schedulers)await s.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}
