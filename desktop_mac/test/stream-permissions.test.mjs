import assert from 'node:assert/strict';
import {StreamPermissions} from '../dist/agents/stream-permissions.js';

const channel=()=>{const c={sent:[],ended:0,write(v){c.sent.push(v);return true;},end(){c.ended++;},waitingForApproval(){}};return c;};
const start=()=>{
  const c=channel();
  const p=new StreamPermissions({prompt:'conversation',fullAccess:true,permissionMode:'unattended',workspacePath:'/tmp'},()=>{});
  p.start(c);
  p.line({type:'control_response',response:{subtype:'success',request_id:c.sent[0].request_id}});
  assert.equal(c.sent.at(-1).type,'user','the task is sent once the control channel is ready');
  return {c,p};
};

// A mid-turn steer (e.g. the tool-loop nudge) is absorbed into the running turn by
// Claude Code / Qoder and never gets a result of its own. Waiting for one left stdin
// open, so the CLI idled until the 600 s watchdog killed an already-finished turn.
{
  const {c,p}=start();
  assert.equal(p.steer('mid-turn nudge'),true);
  assert.equal(c.ended,0);
  p.line({type:'result',subtype:'success',result:'done'});
  assert.equal(c.ended,1,'the single result of a steered turn closes stdin');
  p.close();
}

// Without a result the turn is still running, so stdin stays open.
{
  const {c,p}=start();
  p.line({type:'assistant',message:{content:[{type:'text',text:'working'}]}});
  assert.equal(c.ended,0);
  p.close();
}
// A steer counts as seen only once the CLI echoes it into the turn and the model
// speaks again; one that arrives after the final answer is never echoed.
{
  const {c,p}=start();
  assert.equal(p.steer('folded input','m-folded'),true);
  assert.equal(p.steer('late input','m-late'),true);
  p.line({type:'user',message:{role:'user',content:[{type:'text',text:'folded input'}]},parent_tool_use_id:null});
  assert.deepEqual(p.steersSeen,[],'the echo alone does not prove the model answered after it');
  p.line({type:'assistant',message:{content:[{type:'text',text:'adjusted'}]},parent_tool_use_id:'child'});
  assert.deepEqual(p.steersSeen,[],'sub-agent output is not the top-level reply');
  p.line({type:'assistant',message:{content:[{type:'text',text:'adjusted'}]},parent_tool_use_id:null});
  p.line({type:'result',subtype:'success',result:'done'});
  assert.deepEqual(p.steersSeen,['m-folded']);
  assert.equal(c.ended,1);
  p.close();
}
// A steer that lands after the final answer is queued by the CLI (Qoder and
// Claude Code, verified live) and answered by a follow-up turn it starts on its
// own after the first result. That follow-up's result confirms it.
{
  const {c,p}=start();
  p.line({type:'assistant',message:{content:[{type:'text',text:'APPLE'}]},parent_tool_use_id:null});
  assert.equal(p.steer('late input','m-late'),true);
  p.line({type:'result',subtype:'success',result:'APPLE'});
  assert.deepEqual(p.steersSeen,[],'the first result predates the late steer');
  assert.equal(c.ended,1,'stdin still closes on the first result; the CLI drains its queue itself');
  p.line({type:'system',subtype:'init',session_id:'s'});
  p.line({type:'assistant',message:{content:[{type:'text',text:'BANANA'}]},parent_tool_use_id:null});
  p.line({type:'result',subtype:'success',result:'BANANA'});
  assert.deepEqual(p.steersSeen,['m-late'],'the CLI follow-up turn handled the late steer');
  p.close();
}
// Claude Code replays the steer (isReplay) in its follow-up turn: still one confirmation.
{
  const {p}=start();
  assert.equal(p.steer('late input','m-late'),true);
  p.line({type:'result',subtype:'success',result:'APPLE'});
  p.line({type:'user',message:{role:'user',content:'late input'},parent_tool_use_id:null,isReplay:true});
  p.line({type:'assistant',message:{content:[{type:'text',text:'BANANA'}]},parent_tool_use_id:null});
  p.line({type:'result',subtype:'success',result:'BANANA'});
  assert.deepEqual(p.steersSeen,['m-late']);
  p.close();
}
// A follow-up turn that fails does not confirm the queued steer.
{
  const {p}=start();
  assert.equal(p.steer('late input','m-late'),true);
  p.line({type:'result',subtype:'success',result:'APPLE'});
  p.line({type:'assistant',message:{content:[{type:'text',text:'partial'}]},parent_tool_use_id:null});
  p.line({type:'result',subtype:'error',is_error:true,result:'boom'});
  assert.deepEqual(p.steersSeen,[]);
  p.close();
}
console.log('stream-permissions: steered turns close stdin on their single result; echoed steers and late steers answered by the CLI follow-up turn count as seen');
