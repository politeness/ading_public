import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const dir = await mkdtemp(path.join(tmpdir(), 'ading-mentions-'));
const store = new LocalStore(dir);
let scheduler;
try {
 await store.init();
 const discovered = ['codex','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock'}));
 const agents = await store.syncDiscoveredAgents(discovered);
 const calls=[];
 scheduler = new LocalScheduler({idleRetryLimit:0,teamMonitorIntervalMs:0,store,
  registry:{cancel:()=>true,runTurn:async(d)=>{calls.push(d.kind);return {ok:true,message:'Directed answer',steps:[],metrics:{iterations:0,sideEffects:false}};}},
  syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),
  resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.userId===id)?.kind===d.kind),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
 const target=agents.find(a=>a.kind==='claude-code');
 const conversation=await scheduler.createConversation({name:'Directed',memberIds:agents.map(a=>a.userId),permanent:true,
  initialMessage:'Please answer',initialMentions:[target.userId]});
 for(let i=0;i<100 && !(await store.listMessages(conversation.conversationId)).some(m=>m.content==='Directed answer');i++)await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,80));
 assert.deepEqual(calls,['claude-code'],'only the mentioned agent answers, including no leader cascade');
 const messages=await store.listMessages(conversation.conversationId);
 assert.deepEqual(messages[0].mentions,[target.userId],'first-message mentions persist');
 assert.equal((await store.getConversation(conversation.conversationId)).permanent,true);
 const reply=messages.find(m=>m.content==='Directed answer');
 assert.deepEqual(await scheduler.pickTargets(await store.getConversation(conversation.conversationId),reply),[]);
 const friends=[{userId:'friend1',displayName:'Friend 1',isAgent:false},{userId:'friend2',displayName:'Friend 2',isAgent:false}];
 await store.syncPeople(friends);
 const humans=await store.createConversation({name:'Shared human group',memberIds:friends.map(p=>p.userId)});
 await store.updateContact(target.userId,{sharedWith:['friend1']});
 await assert.rejects(store.addMember(humans.conversationId,target.userId,'ENGINEER'),'one missing grant prevents adding');
 await store.updateContact(target.userId,{sharedWith:friends.map(p=>p.userId)});
 assert.equal((await store.addMember(humans.conversationId,target.userId,'ENGINEER')).members.length,4,'all humans share the Agent, so the mixed group can add it');
 // Permanent conversation without a goal: saving settings does not error, does not count as an instruction change, and does not wake Agents; only a real instruction change notifies the Leader
 const goalless=await scheduler.createConversation({name:'No goal',memberIds:agents.map(a=>a.userId),permanent:true});
 const systemCount=async()=>(await store.listMessages(goalless.conversationId)).filter(m=>m.type==='SYSTEM').length;
 const baseline=await systemCount();
 const callsBefore=calls.length;
 const saved=await scheduler.updateConversation(goalless.conversationId,{name:'No goal 2',charter:{goal:'',instructions:''}});
 assert.equal(saved.name,'No goal 2');
 assert.equal(await systemCount(),baseline,'empty charter on a goalless conversation is not an instruction change');
 assert.equal(calls.length,callsBefore);
 await scheduler.updateConversation(goalless.conversationId,{charter:{goal:'',instructions:'Be brief'}});
 assert.equal(await systemCount(),baseline+1,'a real instruction change still notifies');
 await store.updateConversation(conversation.conversationId,{permanent:false});
 await scheduler.shutdown(); scheduler=undefined; await store.close();
 const reopened=new LocalStore(dir);await reopened.init();
 assert.equal((await reopened.getConversation(conversation.conversationId)).permanent,false,'unchecking persists across restart');
 await reopened.close();
 console.log('permanent-mentions: durable flag, initial targeting and no reply cascade passed');
} finally {await scheduler?.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}
