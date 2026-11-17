import assert from 'node:assert/strict';
import {ConversationControl, controlLocalThenRemote, executeConversationControl} from '../dist/store/conversation-control.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const packets=[],calls=[];
let finishPause;
const caller=new ConversationControl({send:(type,payload)=>{packets.push({type,payload});return true;},run:async()=>{},timeoutMs:1000});
const worker=new ConversationControl({send:(type,payload)=>{caller.receive(type,{...payload,terminalId:'remote'});return true;},run:async(id,action)=>{
  calls.push([id,action]);
  if(action==='pause')await new Promise(resolve=>{finishPause=resolve;});
}});
const receipt=(request,ids=['remote'])=>caller.receive('CONVERSATION_CONTROL_ACCEPTED',{...request,terminalIds:ids});
try {
  let complete=false;
  const pause=caller.request('task-a','pause').then(()=>{complete=true;});
  const request=packets.at(-1).payload;
  receipt(request);
  const command={...request,requesterTerminalId:'caller',expiresAt:Date.now()+1000};
  worker.receive('CONVERSATION_CONTROL',command);
  worker.receive('CONVERSATION_CONTROL',command);
  await tick();
  assert.deepEqual(calls,[['task-a','pause']],'duplicate deliveries execute once');
  assert.equal(complete,false,'request receipt is not execution completion');
  caller.receive('CONVERSATION_CONTROL_RESULT',{...request,terminalId:'unrelated',ok:true});
  caller.receive('CONVERSATION_CONTROL_RESULT',{...request,conversationId:'task-b',terminalId:'remote',ok:true});
  assert.equal(complete,false,'wrong source/task cannot complete the request');
  finishPause();await pause;
  assert.deepEqual(caller.stoppedIds(),['task-a']);
  const resume=caller.request('task-a','resume');
  const resumeRequest=packets.at(-1).payload;
  // Cross-instance result can beat the accepted receipt.
  worker.receive('CONVERSATION_CONTROL',{...resumeRequest,requesterTerminalId:'caller',expiresAt:Date.now()+1000});
  await tick();
  receipt(resumeRequest);
  await resume;
  assert.deepEqual(calls.at(-1),['task-a','resume']);
  assert.deepEqual(caller.stoppedIds(),[]);
  const group=caller.request('group','pause');const groupRequest=packets.at(-1).payload;
  receipt(groupRequest,['one','two']);
  caller.receive('CONVERSATION_CONTROL_RESULT',{...groupRequest,terminalId:'one',ok:true});
  assert.deepEqual(caller.stoppedIds(),[],'partial group completion is not success');
  caller.receive('CONVERSATION_CONTROL_RESULT',{...groupRequest,terminalId:'two',ok:false});
  await assert.rejects(group);
  const offline=caller.request('task-a','pause');
  caller.receive('CONVERSATION_CONTROL_ACCEPTED',{...packets.at(-1).payload,error:'AGENT_009'});
  await assert.rejects(offline);
  const disconnected=caller.request('task-a','pause');caller.disconnect();await assert.rejects(disconnected);
  worker.receive('CONVERSATION_CONTROL',{...command,requestId:'expired',expiresAt:Date.now()-1});await tick();
  assert.equal(calls.length,2,'expired command never stops later work');
} finally { caller.close();worker.close(); }

const oldServer=new ConversationControl({send:()=>true,run:async()=>{},timeoutMs:10});
try {await assert.rejects(oldServer.request('a','pause'));assert.deepEqual(oldServer.stoppedIds(),[]);}finally{oldServer.close();}
const noSocket=new ConversationControl({send:()=>false,run:async()=>{}});
try {await assert.rejects(noSocket.request('a','pause'));}finally{noSocket.close();}

let busy=true,cancelled=[],resumed=[];
const scheduler={stopConversation:async id=>{cancelled.push(id);},resumeConversation:async id=>{resumed.push(id);},runtimeSnapshot:()=>({revision:1,agents:[
  {conversationId:'a',agentUserId:'same-agent',busy},
  {conversationId:'b',agentUserId:'same-agent',busy:true}
]})};
const stopping=executeConversationControl(scheduler,'a','pause',200);
busy=false;await stopping;
assert.deepEqual(cancelled,['a']);
await executeConversationControl(scheduler,'a','resume');assert.deepEqual(resumed,['a']);
busy=true;await assert.rejects(executeConversationControl(scheduler,'a','pause',5));
// Regression: a group rejection (other computer offline / foreign Agent) used to keep this
// computer's running Agent going, because pause only went through the server.
{
  const order=[];
  const offline=new Error('offline');
  await assert.rejects(controlLocalThenRemote('pause',{
    local:async()=>{order.push('local');return 1;},
    remote:async localOk=>{order.push(['remote',localOk]);throw offline;}
  }),error=>error!==offline&&error.message.includes('offline'),'remote failure is reported as remote-only after local success');
  assert.deepEqual(order,['local',['remote',true]],'local members stop before the remote request');
  order.length=0;
  await assert.rejects(controlLocalThenRemote('resume',{
    local:async()=>{order.push('local');return 0;},
    remote:async()=>{order.push('remote');throw offline;}
  }),error=>error!==offline&&error.message.includes('offline'));
  assert.deepEqual(order,['local','remote'],'resume of local members is not blocked by an offline computer');
  assert.equal(await controlLocalThenRemote('pause',{local:async()=>2,remote:async()=>{}}),2);
  await assert.rejects(controlLocalThenRemote('pause',{remote:async()=>{throw offline;}}),error=>error===offline,'remote-only task keeps the original error');
  order.length=0;
  const localFailure=new Error('local');
  await assert.rejects(controlLocalThenRemote('pause',{local:async()=>{throw localFailure;},remote:async localOk=>{order.push(['remote',localOk]);}}),error=>error===localFailure);
  assert.deepEqual(order,[['remote',false]],'pause still reaches remote members when the local stop failed');
  order.length=0;
  await assert.rejects(controlLocalThenRemote('resume',{local:async()=>{throw localFailure;},remote:async()=>{order.push('remote');}}),error=>error===localFailure);
  assert.deepEqual(order,[],'failed local resume does not resume other computers');
}
// The server routes the command back to the requesting computer too; its own part already ran locally.
{
  const sent=[],runs=[];
  const self=new ConversationControl({send:(type,payload)=>{sent.push({type,payload});return true;},run:async(id,action)=>{runs.push([id,action]);},timeoutMs:1000});
  try {
    const pause=self.request('mixed','pause',true);
    const request=sent.at(-1).payload;
    self.receive('CONVERSATION_CONTROL_ACCEPTED',{...request,terminalIds:['self','remote']});
    self.receive('CONVERSATION_CONTROL',{...request,requesterTerminalId:'self',expiresAt:Date.now()+1000});
    await tick();await tick();
    assert.deepEqual(runs,[],'echo of an own request does not run the local part twice');
    const echo=sent.find(packet=>packet.type==='CONVERSATION_CONTROL_RESULT');
    assert.equal(echo.payload.ok,true,'echo reports the local outcome');
    self.receive('CONVERSATION_CONTROL_RESULT',{...echo.payload,terminalId:'self'});
    self.receive('CONVERSATION_CONTROL_RESULT',{...request,terminalId:'remote',ok:true});
    await pause;
    const failed=self.request('mixed','pause',false);
    const second=sent.at(-1).payload;
    self.receive('CONVERSATION_CONTROL',{...second,requesterTerminalId:'self',expiresAt:Date.now()+1000});
    await tick();await tick();
    assert.equal(sent.at(-1).payload.ok,false,'a failed local part is never reported as stopped');
    self.receive('CONVERSATION_CONTROL_ACCEPTED',{...second,terminalIds:['self']});
    self.receive('CONVERSATION_CONTROL_RESULT',{...sent.at(-1).payload,terminalId:'self'});
    await assert.rejects(failed);
    assert.deepEqual(runs,[]);
  } finally { self.close(); }
}
console.log('conversation-control: remote receipt, idempotence, isolation, failure, expiry and local-first pause passed');
