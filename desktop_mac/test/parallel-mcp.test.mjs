import assert from 'node:assert/strict';
import {startParallelMcp} from '../dist/agents/parallel-mcp.js';
import {QoderAdapter} from '../dist/agents/qoder.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
assert.equal(new QoderAdapter().lenientParallelSchema,true);assert.equal(new QoderCnAdapter().lenientParallelSchema,true);assert.equal(new ClaudeCodeAdapter().lenientParallelSchema,false,'only qoder adapters relax the schema');
let calls=0,signal;
const bridge=await startParallelMcp({onParallelWork:async(args,s)=>{calls++;signal=s;return {results:args.jobs};}});
const config=JSON.parse(bridge.config).mcpServers.ading;
const request=async(method,params={},headers=config.headers)=>fetch(config.url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
try {
 assert.equal((await request('tools/list',{},{})).status,403);
 assert.equal((await request('tools/list',{}, {...config.headers,Origin:'https://example.com'})).status,403);
 const init=await (await request('initialize')).json();assert.equal(init.result.capabilities.tools.constructor,Object);
 const listing=await (await request('tools/list')).json();assert.equal(listing.result.tools[0].name,'ading_parallel');
 const result=await (await request('tools/call',{name:'ading_parallel',arguments:{jobs:['one','two']}})).json();
 assert.deepEqual(JSON.parse(result.result.content[0].text).results,['one','two']);assert.equal(calls,1);
 const bad=await (await request('tools/call',{name:'unknown'})).json();assert.equal(bad.result.isError,true);assert.equal(calls,1);
 assert.ok(config.timeout>60000,'batch wait must not inherit the HTTP request timeout');
}finally{bridge.close();}
assert.equal(signal.aborted,true,'closing provider transport cancels child work');
// Qoder clients check arguments against the advertised schema themselves and their
// models send jobs as a JSON string, so qoder adapters get a schema without oneOf
// and ADing decodes the strings before validating.
const strictListing=await (async()=>{const b=await startParallelMcp({onParallelWork:async()=>({})});try{const c=JSON.parse(b.config).mcpServers.ading;return (await (await fetch(c.url,{method:'POST',headers:{...c.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json()).result.tools[0];}finally{b.close();}})();
assert.ok(strictListing.inputSchema.oneOf,'other adapters keep the strict schema');
let received;
const lenient=await startParallelMcp({onParallelWork:async args=>{received=args;return {ok:true};}},{lenientSchema:true});
try {
 const c=JSON.parse(lenient.config).mcpServers.ading;
 const call=async(method,params={})=>(await fetch(c.url,{method:'POST',headers:{...c.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 const tool=(await call('tools/list')).result.tools[0];
 assert.equal(tool.inputSchema.oneOf,undefined,'no oneOf for qoder clients');
 const jobsSchema=tool.inputSchema.properties.jobs;
 assert.equal(jobsSchema.type,undefined,'no union type keyword: ajv strict mode warns on those and ADing reported the warning as the failure');
 assert.deepEqual(jobsSchema.anyOf.map(s=>s.type),['array','string']);
 assert.deepEqual(jobsSchema.anyOf[0].items.required,['id','instruction','outputs'],'job fields stay visible so the model sends ids');
 assert.equal(JSON.stringify(tool.inputSchema).includes('["array","string"]'),false,'union types are gone everywhere');assert.deepEqual(strictListing.inputSchema.oneOf[0].properties.jobs.items.required,['id','instruction','outputs']);
 await call('tools/call',{name:'ading_parallel',arguments:{sharedInstruction:'s',stream:'true',jobs:JSON.stringify([{id:'a',instruction:'do',outputs:'/tmp/a.png'}])}});
 assert.deepEqual(received,{sharedInstruction:'s',stream:true,jobs:[{id:'a',instruction:'do',outputs:['/tmp/a.png']}]},'string-encoded jobs are decoded before validation');
 await call('tools/call',{name:'ading_parallel',arguments:{batchId:'b1',cursor:'3'}});
 assert.deepEqual(received,{batchId:'b1',cursor:3});
}finally{lenient.close();}
console.log('parallel-mcp: authentication, origin isolation, discovery, execution, errors, cancellation and qoder lenient schema passed');
