import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-direct-'));let store=new LocalStore(dir);await store.init();
try{
 const [agent]=await store.syncDiscoveredAgents([{kind:'qoder-cn',localUuid:'qcn',version:'test',executablePath:'/mock'}]);const me=await store.currentUser();
 const conversation=await store.createConversation({name:'问候',memberIds:[agent.userId],leaderId:agent.userId,charter:{goal:'hi？',mode:'discussion'}});
 assert.equal(conversation.type,'DIRECT');assert.ok(conversation.members.every(m=>m.role!=='LEADER'));assert.equal(conversation.charter.mode,undefined);
 await assert.rejects(store.setMemberRole(conversation.conversationId,agent.userId,'LEADER'),/单聊/);
 await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'old-user',senderId:me.userId,content:'hi？'});
 await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'old-agent',senderId:agent.userId,content:'你好，有什么事？'});
 const calls=[];let next='你好';
 const scheduler=new LocalScheduler({idleRetryLimit:0,store,registry:{runTurn:async(_a,input)=>{calls.push(input);return{ok:true,threadId:'plain-thread',message:next,steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'qoder-cn',localUuid:'qcn'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{},getPermissionMode:async()=> 'unattended',requestPermission:async()=>false});
 const settle=async()=>{for(let i=0;i<200&&scheduler.runtimeSnapshot().agents.length;i++)await new Promise(r=>setTimeout(r,5));assert.equal(scheduler.runtimeSnapshot().agents.length,0);};
 await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'new',content:'今天帮我看看一个文件'});await settle();
 assert.equal(calls.length,1,'one user message starts one normal turn');assert.equal(calls[0].threadId,undefined,'first turn opens a new provider thread');
 assert.equal(calls[0].discussionOnly,false);assert.equal(calls[0].fullAccess,true);assert.equal(calls[0].permissionMode,'unattended');assert.equal(calls[0].onPermission,undefined);
 assert.ok(calls[0].prompt.includes('hi？')&&calls[0].prompt.includes('你好，有什么事？'),'replay actual conversation');
 assert.ok(!/leader|负责人|协作策略|工作队列|验收|任务目标|control|accept|revise/i.test(calls[0].prompt));
 // Split delivery: ADing-generated instructions and conversation content are separated, but the two halves together must still equal the original, with no content lost
 const split=calls[0].split;
 assert.ok(split,'Provides a split-delivery version');
 assert.ok(split.dialogue.includes('hi？')&&split.dialogue.includes('你好，有什么事？'),'Conversation content goes to conversation');
 assert.ok(!split.app.includes('你好，有什么事？'),'Conversation content stays out of the ADing instruction half');
 assert.ok(split.app.includes('工作目录'),'ADing-generated instructions go to app');
 // After split delivery the protocol block goes into the system instruction channel instead of after the conversation, so compare content, not order:
 // every paragraph must appear as-is in one of the halves, none lost and none added.
 const paragraphs=text=>text.split('\n\n').map(part=>part.trim()).filter(Boolean).sort();
 assert.deepEqual(paragraphs(split.app+'\n\n'+split.dialogue),paragraphs(calls[0].prompt),'Content neither grows nor shrinks across the split');
 next='{"control":{"action":"stop","reason":"只是普通文本"}}';
 await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'next',content:'给我JSON例子'});await settle();
 assert.equal(calls.length,2);assert.equal(calls[1].threadId,'plain-thread');assert.equal((await store.getConversation(conversation.conversationId)).paused,false,'direct text never changes coordination state');
 assert.equal((await store.listMessages(conversation.conversationId)).at(-1).content,next);
 // Attachments only, no text: the message still sends, and the agent gets the absolute local file path
 const source=path.join(dir,'报表.pdf');await writeFile(source,'pdf');
 const attachment=await store.importAttachment(source);
 assert.equal(attachment.kind,'file');assert.equal(attachment.mimeType,'application/pdf');
 const sent=await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'with-file',content:'',attachments:[attachment]});await settle();
 assert.deepEqual(sent.attachments.map(a=>a.attachmentId),[attachment.attachmentId]);
 const file=await store.attachmentFile(conversation.conversationId,attachment);
 assert.equal(calls.length,3,'Attachment-only messages are also processed by the agent');
 assert.ok(calls[2].prompt.includes(file),'The prompt contains the attachment\'s local path');
 assert.ok(calls[2].prompt.includes('报表.pdf'));
 await assert.rejects(store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'empty',senderId:me.userId,content:'  '}),/不能为空|empty/,'Neither text nor attachment is still rejected');
 console.log('direct-chat: no leader, plain prompt, single turn, tools/approval, inert controls and attachments passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
