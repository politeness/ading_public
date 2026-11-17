import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';

const dir=await mkdtemp(path.join(os.tmpdir(),'ading-message-reply-'));
const store=new LocalStore(dir);await store.init();
try {
 const me=await store.currentUser();
 const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'codex',executablePath:'/mock',version:'test'}]);
 const conversation=await store.createConversation({name:'reply',memberIds:[agent.userId],leaderId:agent.userId});
 const quote={senderId:me.userId,text:'原文'};
 const first=await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'m_first',senderId:me.userId,content:'原文'});
 await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'m_reply',senderId:me.userId,content:'收到',replyTo:first.messageId,quote});
 // Reopen: the quote must be read back from the log, not just kept in memory
 const reopened=new LocalStore(dir);await reopened.init();
 const saved=(await reopened.listMessages(conversation.conversationId)).find(item=>item.messageId==='m_reply');
 assert.equal(saved.replyTo,'m_first');
 assert.deepEqual(saved.quote,quote);
 // Content sent to the Agent must say which message this replies to; messages without a quote get no extra sentence
 const prompts=[];
 const scheduler=new LocalScheduler({store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'codex',executablePath:'/mock',version:'test'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{},
  registry:{runTurn:async(_agent,input)=>{prompts.push(input.prompt);return {ok:true,message:'好的',steps:[],metrics:{iterations:1,sideEffects:false}};}}});
 const settle=async()=>{for(let i=0;i<400;i++){await new Promise(r=>setTimeout(r,5));if(!scheduler.runtimeSnapshot().agents.length&&i>10)return;}};
 const direct=await store.createConversation({name:'direct',memberIds:[agent.userId],leaderId:agent.userId});
 await scheduler.sendUserMessage({conversationId:direct.conversationId,clientMessageId:'m_plain',content:'普通消息'});await settle();
 assert.ok(prompts.at(-1)?.includes('普通消息'),'Agent received the message');
 assert.ok(!prompts.at(-1).includes('基础上的回复'),'no quote means no explanation');
 await scheduler.sendUserMessage({conversationId:direct.conversationId,clientMessageId:'m_answer',content:'这个不对',replyTo:'m_plain',quote:{senderId:agent.userId,text:'方案是先改后端'}});await settle();
 assert.ok(prompts.at(-1).includes('这个不对'));
 assert.ok(prompts.at(-1).includes(`在 ${agent.displayName} 的这条消息基础上的回复：方案是先改后端`),'states whose message is being replied to');
 console.log('message reply: replyTo and quote survive a reload and reach the Agent');
} finally {await rm(dir,{recursive:true,force:true});}
