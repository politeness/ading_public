import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {parseConversationTitle} from '../dist/orchestration/conversation-title.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-quick-conversation-'));
const store=new LocalStore(dir);await store.init();
try {
 const [offline,ready]=await store.syncDiscoveredAgents([{kind:'qoder',localUuid:'q',executablePath:'/mock'},{kind:'codex',localUuid:'c',executablePath:'/mock'}]);
 let release;const prompts=[];const naming=[];
 let reply='我先核对票据范围。\n{"control":{"action":"organize","mode":"discussion"}}';
 let namedAs='票据归档与月度统计';
 const scheduler=new LocalScheduler({idleRetryLimit:0,store,registry:{askOnce:async(_d,prompt)=>{naming.push(prompt);return {ok:true,text:namedAs};},runTurn:async(_d,input)=>{prompts.push(input.prompt);const phase=input.prompt.match(/当前是分工前共同讨论阶段：(\w+)/)?.[1];if(phase && phase!=='ideas')return {ok:true,message:'意见已汇总。\n'+JSON.stringify({control:{action:'organize',mode:'discussion'}}),steps:[],metrics:{iterations:0,sideEffects:false}};await new Promise(r=>release=r);return {ok:true,threadId:'test',message:reply,steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'c'}),isAgentReady:a=>a.userId===ready.userId,broadcast:()=>{},log:async()=>{}});
 const waitFor=async fn=>{for(let i=0;i<300&&!(await fn());i++)await new Promise(r=>setTimeout(r,5));assert.ok(await fn());};
 const raw='  请帮我把这些票据按月份归档，统计每月支出。\n';
 const conversation=await scheduler.createConversation({name:'新任务',autoTitle:true,memberIds:[offline.userId,ready.userId],initialMessage:raw,charter:{goal:raw}});
 await waitFor(()=>release);
 assert.equal(conversation.members.find(m=>m.role==='LEADER').userId,ready.userId,'skip unavailable leader without dropping membership');
 // Naming no longer leaks into the user-visible turn: the turn prompt has no naming request; it is asked separately once
 assert.ok(!prompts.some(p=>p.includes('拟一个简短、具体的任务名称')),'turn prompt does not contain the naming request');
 await waitFor(()=>naming.length>0);
 assert.ok(naming[0].includes('请帮我把这些票据按月份归档'),'naming call receives the user\'s original words');
 release();await waitFor(async()=>(await store.getConversation(conversation.conversationId)).brainstorm?.phase==='ready');
 const renamed=await store.getConversation(conversation.conversationId);
 assert.equal(renamed.name,'票据归档与月度统计');assert.equal(renamed.autoTitle,false);
 const messages=await store.listMessages(conversation.conversationId);
 assert.equal(messages[0].content,raw);
 assert.ok(messages.some(m=>m.content==='我先核对票据范围。'));
 assert.ok(!messages.some(m=>m.content.includes('<task-title>')),'metadata not in chat');
 assert.ok(messages.some(m=>m.agentReply?.raw===reply),'complete provider reply persisted');
 assert.equal(naming.length,1,'each conversation asks for a name only once');
 const reloaded=new LocalStore(dir);await reloaded.init();assert.equal((await reloaded.getConversation(conversation.conversationId)).name,'票据归档与月度统计');await reloaded.close();
 release=null;namedAs='迟到的自动名称';
 const direct=await scheduler.createConversation({name:'新任务',autoTitle:true,memberIds:[ready.userId],initialMessage:'归档票据'});
 await waitFor(()=>release);
 await scheduler.updateConversation(direct.conversationId,{name:'我手动指定的名称'});
 release();await waitFor(()=>scheduler.runtimeSnapshot().agents.length===0);
 assert.equal((await store.getConversation(direct.conversationId)).name,'我手动指定的名称','late auto title cannot overwrite manual name');
 assert.ok(!(await store.listMessages(direct.conversationId)).some(m=>m.content.includes('<task-title>')),'manual naming during generation still hides metadata');
 assert.ok(!/你的角色：负责人|当前内部协作策略/.test(prompts.at(-1)),'single chat remains simple');
 // A user-supplied name must be kept as-is: when autoTitle is false, the Agent's <task-title> has no effect.
 release=null;
 const named=await scheduler.createConversation({name:'我自己起的名字',memberIds:[ready.userId],initialMessage:'归档票据'});
 await waitFor(()=>release);
 release();await waitFor(()=>scheduler.runtimeSnapshot().agents.length===0);
 const keptName=await store.getConversation(named.conversationId);
 assert.equal(keptName.name,'我自己起的名字','user-supplied name is never replaced by the model');
 assert.equal(naming.length,2,'once the user names it, the model is not asked');
 assert.ok(!(await store.listMessages(named.conversationId)).some(m=>m.content.includes('<task-title>')),'metadata hidden even when unused');

 // When the other party is unavailable, a direct chat must name exactly who is unavailable,
 // rather than a generic "no Agent is currently available".
 await assert.rejects(
   scheduler.createConversation({name:'占位名',autoTitle:true,memberIds:[offline.userId],initialMessage:'先留个言'}),
   err=>err.message.includes(offline.displayName)&&err.message.includes('不可用'),
   'an unavailable direct counterpart is named in the error');

 // The naming call's result must be cleaned: strip quotes and punctuation; reject placeholder names --
 // saving "新任务" (New task) as the name would also turn off autoTitle, leaving the conversation named "新任务" forever.
 const { cleanConversationName } = await import("../dist/orchestration/conversation-title.js");
 assert.equal(cleanConversationName('票据归档'),'票据归档');
 assert.equal(cleanConversationName('「票据归档」'),'票据归档');
 assert.equal(cleanConversationName('票据归档。\n另外我还想说点别的'),'票据归档','only the first line is taken');
 assert.equal(cleanConversationName('新任务'),undefined,'placeholder name cannot be used as a name');
 assert.equal(cleanConversationName('New task'),undefined,'English placeholder name is rejected too');
 assert.equal(cleanConversationName('  '),undefined);
 assert.equal(cleanConversationName('名'.repeat(41)),undefined,'reject names that are too long');

 assert.deepEqual(parseConversationTitle('普通回复'),{visible:'普通回复'});
 assert.deepEqual(parseConversationTitle('<task-title>只有名称</task-title>'),{visible:'<task-title>只有名称</task-title>'},'never consume title-only actual content');
 assert.deepEqual(parseConversationTitle('示例：<task-title>标签</task-title>'),{visible:'示例：<task-title>标签</task-title>'});
 {
  const { parseConversationTitle: parse } = await import("../dist/orchestration/conversation-title.js");
  const middle = parse("已经查完上传链路。\n<task-title>排查知识空间上传异常</task-title>\n下一步复验。");
  assert.equal(middle.title, "排查知识空间上传异常", "title is extracted even when the tag is in the middle of the body");
  assert.equal(middle.visible.includes("conversation-title"), false, "tag in the middle of the body is not shown to the user");
  assert.equal(parse("<task-title>排查上传</task-title>\n开始处理").visible, "开始处理");
  const twice = parse("<task-title>排查上传</task-title>\n第一段\n<task-title>排查上传</task-title>\n第二段");
  assert.equal(twice.visible.includes("conversation-title"), false, "all tag lines are removed");
  assert.equal(parse("<task-title>只有标题</task-title>").visible, "<task-title>只有标题</task-title>", "a reply with only the tag is not a complete reply");
  assert.equal(parse("<task-title>新任务</task-title>\n正文").title, undefined, "\"新任务\" (New task) is not accepted as a title");
}

console.log('quick-conversation: ready leader, full membership, semantic name, original message, persistence, manual rename, user-supplied name and a named unavailable counterpart passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
