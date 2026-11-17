import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-user-text-'));const store=new LocalStore(dir);await store.init();
try {
 const [agent]=await store.syncDiscoveredAgents([{kind:'claude-code',localUuid:'cc',version:'test',executablePath:'/mock'}]);
 const prompts=[];const scheduler=new LocalScheduler({idleRetryLimit:0,store,registry:{runTurn:async(_d,input)=>{prompts.push(input.prompt);return {ok:true,threadId:'test',message:'SKIP',steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'claude-code',localUuid:'cc'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
 const raw='  hi？\n\n**原文**\\\n<image>不是工具调用</image>  \n';
 const conversation=await scheduler.createConversation({name:'短标题',memberIds:[agent.userId],charter:{goal:'供调度参考的目标'},initialMessage:raw});
 assert.equal((await store.listMessages(conversation.conversationId))[0].content,raw);
 await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'second',content:'  SKIP\n'});
 assert.equal((await store.listMessages(conversation.conversationId)).find(m=>m.messageId==='second').content,'  SKIP\n');
 for(let i=0;i<100&&scheduler.runtimeSnapshot().agents.length;i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(prompts.some(p=>p.includes(raw)),'internal prompt includes exact original');
 assert.ok(prompts.every(p=>!p.includes('供调度参考的目标')),'direct chat does not inject task charter');
 assert.ok(!(await store.listMessages(conversation.conversationId)).some(m=>m.content.includes('我们开始一个新任务')));
 const reopened=new LocalStore(dir);await reopened.init();assert.equal((await reopened.listMessages(conversation.conversationId))[0].content,raw);await reopened.close();
 console.log('user-message: original first/subsequent content, whitespace, persistence and separate context passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
