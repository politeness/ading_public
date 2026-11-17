import assert from 'node:assert/strict';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {QoderAdapter} from '../dist/agents/qoder.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';
for(const Adapter of [ClaudeCodeAdapter,QoderAdapter,QoderCnAdapter]){
const adapter=new Adapter();
adapter.readNativeConfiguration=async()=>({source:'fixture-native'});
let active=0,peak=0,children=0;
adapter.runner.run=async(_id,options)=>{
 const session=String(++children),index=options.args.indexOf('--mcp-config');
 const finish=text=>({stdout:JSON.stringify({type:'result',subtype:'success',session_id:session,result:text}),stderr:'',failure:'',cancelled:false});
 // Subtasks are also fully authorized execution turns with ADing's MCP (computer-use tools) attached, so the parent task is identified by call order
 if(session==='1'){
   assert.ok(index>=0,'parent gets the ading MCP');
   const config=JSON.parse(options.args[index+1]).mcpServers.ading;
   options.onLine(JSON.stringify({type:'system',subtype:'init',session_id:session,model:'claude-fixture',tools:['mcp__ading__ading_parallel']}));
   const response=await fetch(config.url,{method:'POST',headers:{...config.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ading_parallel',arguments:{jobs:Array.from({length:11},(_,i)=>({id:String(i),instruction:'read fixture',outputs:[]}))}}})});
   const result=await response.json();return finish(result.result.content[0].text);
 }
 assert.equal(options.args[options.args.indexOf('--model')+1],'claude-fixture','children inherit resolved parent model');
 active++;peak=Math.max(peak,active);
 await new Promise(resolve=>setTimeout(resolve,30));active--;
 return finish('read complete');
};
const result=await adapter.runTurn({kind:'claude-code',localUuid:'fixture',executablePath:'/mock'}, {workspacePath:'/tmp',prompt:'read fixtures',fullAccess:true,onProgress:()=>{},onPermission:async()=>false,parallelWork:{key:'task:agent',limit:10,executionSlot:true,allowSplit:true,sessionBudget:11}});
assert.equal(result.ok,true,JSON.stringify(result));
assert.equal(JSON.parse(result.message).results.length,11);
assert.equal(peak,10,'11th job waits and the waiting parent releases its lane');assert.equal(active,0);
console.log('claude-parallel: native MCP adapter path, 10 lanes, overflow, parent slot release and model inheritance passed');

}
