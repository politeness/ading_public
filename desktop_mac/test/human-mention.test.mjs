import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';

const dir=await mkdtemp(path.join(os.tmpdir(),'ading-human-mention-'));
const store=new LocalStore(dir);await store.init();
try {
 const discovered=['codex','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
 const agents=await store.syncDiscoveredAgents(discovered),[first,second]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
 const friend={userId:'u_friend',displayName:'Alice',isAgent:false},other={userId:'u_other',displayName:'Bob',isAgent:false};
 await store.rememberPeople([friend,other]);
 const me=await store.currentUser();
 for(const agent of [first,second])await store.updateContact(agent.userId,{sharedWith:[friend.userId,other.userId]});
 const prompts=[];
 const scheduler=new LocalScheduler({store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{},
  registry:{runTurn:async(agent,input)=>{prompts.push({kind:agent.kind,prompt:input.prompt});return {ok:true,message:'SKIP',steps:[],metrics:{iterations:1,sideEffects:false}};}}});
 const settle=async()=>{for(let i=0;i<400;i++){await new Promise(r=>setTimeout(r,5));if(!scheduler.runtimeSnapshot().agents.length&&i>10)return;}};
 const send=async(conversation,id,content,mentions)=>{await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:id,content,mentions});await settle();};
 const group=(name,memberIds)=>store.createConversation({name,memberIds,leaderId:first.userId});

 // Multi-Agent group with no discussion yet: @-mentioning a human does not start a discussion or wake any Agent
 const fresh=await group('fresh',[first.userId,second.userId,friend.userId]);
 await send(fresh,'fresh-1','@Alice 看一下',[friend.userId]);
 assert.equal(prompts.length,0,'no Agent turn for a reminder between people');
 assert.ok(!(await store.getConversation(fresh.conversationId)).brainstorm,'no discussion is started');

 // Paused conversation: @-mentioning a human does not resume it
 const paused=await group('paused',[first.userId,second.userId,friend.userId]);
 await store.setConversationPaused(paused.conversationId,true);
 await send(paused,'paused-1','@Alice 看一下',[friend.userId]);
 assert.equal((await store.getConversation(paused.conversationId)).paused,true,'the conversation stays paused');
 assert.equal(prompts.length,0);

 // Group with only one Agent: when woken later it sees this message and is told it need not handle it
 const solo=await group('solo',[first.userId,friend.userId]);
 await send(solo,'solo-1','@Alice 帮我看下报价',[friend.userId]);
 assert.equal(prompts.length,0);
 await send(solo,'solo-2','小c 看下今天的日志',[]);
 assert.equal(prompts.length,1,'a later plain message wakes the Agent');
 assert.match(prompts[0].prompt,/@Alice 帮我看下报价\n调度上下文（不是成员发言）：上面这条消息 @ 了 Alice，是提醒对方，只由对方处理/,'the note follows the reminder');
 prompts.length=0;

 // @-mentioning both a human and an Agent: only the mentioned Agent replies, no discussion starts
 const mixed=await group('mixed',[first.userId,second.userId,friend.userId]);
 await send(mixed,'mixed-1','@Alice @claude 都看下',[friend.userId,second.userId]);
 assert.deepEqual(prompts.map(item=>item.kind),['claude-code'],'only the mentioned Agent answers');
 assert.ok(!(await store.getConversation(mixed.conversationId)).brainstorm);
 prompts.length=0;

 // @-mentioning a human is transparent to scheduling: it does not override earlier directed messages, and the Agent's later turn decisions are unchanged
 const directed=await group('directed',[first.userId,second.userId,friend.userId]);
 await send(directed,'directed-1','@claude 看下',[second.userId]);
 prompts.length=0;
 await send(directed,'directed-2','@Alice 顺便说一声',[friend.userId]);
 assert.equal((await scheduler.latestDirected(await store.getConversation(directed.conversationId))).seq,1,'the earlier directed message still counts');
 assert.equal(prompts.length,0);

 // Reminder position: the first unread @; once read past, move to the next; cleared when you speak; Agent and ordinary messages do not count
 const mark=await group('mark',[first.userId,friend.userId]);
 const id=mark.conversationId,mine=async()=>(await store.getConversation(id)).members.find(m=>m.userId===me.userId).firstUnreadMentionSeq;
 const say=(cid,senderId,mentions=[],extra={})=>store.appendMessage({conversationId:id,clientMessageId:cid,senderId,content:'x',mentions,...extra});
 await say('m1',friend.userId);assert.equal(await mine(),undefined,'a plain message is no mention');
 await say('m2',friend.userId,[me.userId]);assert.equal(await mine(),2);
 await say('m3',friend.userId,[me.userId]);assert.equal(await mine(),2,'the first unread mention stays');
 await say('m4',friend.userId,[me.userId],{internal:true});
 await store.markRead(id,me.userId,2);assert.equal(await mine(),3,'reading past the first moves to the next');
 await store.markRead(id,me.userId,4);assert.equal(await mine(),undefined,'internal messages never remind');
 await say('m5',friend.userId,[me.userId]);assert.equal(await mine(),5);
 await say('m6',me.userId);assert.equal(await mine(),undefined,'speaking means the person has read it');
 await say('m7',me.userId,[me.userId]);assert.equal(await mine(),undefined,'no reminder for a mention of oneself');
 console.log('human mention: reminders stay between people, Agents stay quiet, the note reaches later turns and the unread mention position is kept');
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
