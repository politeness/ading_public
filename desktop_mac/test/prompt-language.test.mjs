import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {setMainLanguage} from '../dist/i18n.js';
import {addressOwner} from '../dist/orchestration/owner-name.js';
import {handshakePrompt} from '../dist/agents/handshake.js';
import {conversationNamingAsk, parseConversationTitle} from '../dist/orchestration/conversation-title.js';

// When the UI is English, prompts written to Agents and newly produced system messages are all in English;
// the user's own content and Agent names are not system text and are removed before checking.
const CJK=/[一-鿿]/;
const leftovers=(text,allowed)=>{let rest=text;for(const a of allowed)rest=rest.split(a).join('');return [...rest.matchAll(/.{0,30}[一-鿿]+.{0,30}/g)].map(m=>m[0]);};

setMainLanguage('en');
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-prompt-language-'));
const store=new LocalStore(dir);await store.init();
// Like other scheduler tests, stop the scheduler before deleting the directory: its background writes collide with rm (ENOTEMPTY)
let scheduler;
try {
  assert.ok(!CJK.test(handshakePrompt()));
  assert.ok(!CJK.test(conversationNamingAsk("Sort these receipts by month.")),"naming ask is English too");
  assert.equal(parseConversationTitle('<task-title>New task</task-title>\nOn it.').title,undefined,'the English placeholder is not a title');
  assert.equal(addressOwner('Ask the task owner. The task owner decides.','Mia'),'Ask Mia. Mia decides.');
  assert.equal(addressOwner('Ask the task owner.',undefined),'Ask the task owner.');
  assert.equal(addressOwner('请主人确认',undefined),'请会话发起人确认','Chinese history keeps working');

  const [a,b]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'c',executablePath:'/mock'},{kind:'claude-code',localUuid:'cc',executablePath:'/mock'}]);
  const prompts=[];
  const reply=JSON.stringify({control:{action:'organize',mode:'discussion'}})+'\nLet us discuss.';
  scheduler=new LocalScheduler({idleRetryLimit:0,store,registry:{runTurn:async(_d,input)=>{prompts.push(input.prompt);return {ok:true,threadId:'t',message:reply,steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'c'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  const waitFor=async fn=>{for(let i=0;i<400&&!(await fn());i++)await new Promise(r=>setTimeout(r,5));assert.ok(await fn());};
  const user='Please sort these receipts by month.';
  const group=await scheduler.createConversation({name:'Receipts',memberIds:[a.userId,b.userId],initialMessage:user,charter:{goal:user}});
  await waitFor(async()=>(await store.getConversation(group.conversationId)).brainstorm?.phase==='ready' || scheduler.runtimeSnapshot().agents.length===0 && prompts.length>=2);
  await waitFor(()=>scheduler.runtimeSnapshot().agents.length===0);
  const direct=await scheduler.createConversation({name:'Chat',memberIds:[a.userId],initialMessage:'hello'});
  await waitFor(()=>scheduler.runtimeSnapshot().agents.length===0);
  assert.ok(prompts.length>=3,`agents were prompted (${prompts.length})`);

  const names=[a.displayName,b.displayName,'Receipts','Chat'];
  const found=prompts.flatMap(prompt=>leftovers(prompt,names));
  assert.deepEqual(found,[],'no Chinese system text in English prompts');
  for(const conversationId of [group.conversationId,direct.conversationId]){
    const system=(await store.listMessages(conversationId)).filter(m=>m.type==='SYSTEM'||m.internal);
    assert.deepEqual(system.flatMap(m=>leftovers(m.content,names)),[],'no Chinese in new system messages');
  }
  if(process.env.DUMP)console.log(prompts.join("\n\n=========\n\n"));
  console.log(`prompt-language: ${prompts.length} English prompts and system messages checked`);
} finally {
  setMainLanguage('zh');
  await scheduler?.shutdown();
  await store.close?.();
  await rm(dir,{recursive:true,force:true});
}
