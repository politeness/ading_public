import {createServer} from "node:http";
import {randomBytes} from "node:crypto";
import {lenientParallelInputSchema,objectParallelInputSchema,normalizeParallelArguments,parallelTool} from "./parallel-work";
import type {TurnInput} from "./types";
import {computerTools,computerToolsEnabled,isComputerTool,runComputerTool} from "./computer-tools";
import { p } from "../prompt-language";
import {isKnowledgeTool,knowledgeTools,runKnowledgeTool} from "../knowledge/tools";

/**
 * Ephemeral, authenticated loopback MCP. Nothing is written to user settings.
 * One server hosts all of ADing's tools for Agents: ading_parallel when parallel work can be dispatched,
 * plus background computer-use tools (computer_*) in fully authorized execution turns.
 */
export function adingMcpNeeded(input:TurnInput):boolean {
  return !!input.onParallelWork || !!input.onKnowledgeTool || computerToolsEnabled(input);
}

export async function startParallelMcp(input:TurnInput,options:{lenientSchema?:boolean;objectSchema?:boolean}={}) {
  const inputSchema=options.lenientSchema ? lenientParallelInputSchema : options.objectSchema ? objectParallelInputSchema : parallelTool.inputSchema;
  const scope=new AbortController();
  const signal=input.signal ? AbortSignal.any([input.signal,scope.signal]) : scope.signal;
  const token=randomBytes(32).toString("hex");
  const computer=computerToolsEnabled(input);
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}` || req.headers.origin) {res.writeHead(403).end();return;}
    if(req.method!=="POST") {res.writeHead(405).end();return;}
    let id:unknown=null;
    const reply=(value:object)=>{if(!res.destroyed)res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id,...value}));};
    try {
      let body="";
      for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>1024*1024){res.writeHead(413).end();return;}}
      const message=JSON.parse(body);id=message.id;
      if(id===undefined){res.writeHead(202).end();return;}
      switch(message.method){
        case "initialize": reply({result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"ading-parallel",version:"1.0.0"}}});break;
        case "ping": reply({result:{}});break;
        case "tools/list": reply({result:{tools:[
          ...(input.onParallelWork ? [{name:parallelTool.name,description:parallelTool.description,inputSchema,_meta:{"anthropic/alwaysLoad":true}}] : []),
          ...(computer ? computerTools().map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema})) : []),
          ...(input.onKnowledgeTool ? knowledgeTools().map(tool=>({...tool,_meta:{"anthropic/alwaysLoad":true}})) : [])
        ]}});break;
        case "tools/call": {
          if(isKnowledgeTool(message.params?.name)) {
            const result=await runKnowledgeTool(input,message.params.name,message.params.arguments,signal);
            reply({result:{content:[{type:"text",text:JSON.stringify(result)}]}});break;
          }
          if(computer && isComputerTool(message.params?.name)) {
            signal.throwIfAborted();
            const result=await runComputerTool(message.params.name,message.params.arguments,signal);
            reply({result:{isError:result.isError,content:result.content.map(item=>item.type==="image" ? {type:"image",data:item.data,mimeType:item.mimeType} : {type:"text",text:item.text ?? ""})}});break;
          }
          if(message.params?.name!==parallelTool.name || !input.onParallelWork)throw new Error(p("未知工具", "Unknown tool"));
          signal.throwIfAborted();
          const result=await input.onParallelWork(normalizeParallelArguments(message.params.arguments),signal);
          reply({result:{content:[{type:"text",text:JSON.stringify(result)}]}});break;
        }
        default: reply({error:{code:-32601,message:"Method not found"}});
      }
    }catch(error){reply({result:{isError:true,content:[{type:"text",text:String(error)}]}});}
  });
  server.requestTimeout=0;
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();
  if(!address || typeof address==="string")throw new Error(p("并行工具启动失败", "The parallel tool failed to start"));
  return {
    config:JSON.stringify({mcpServers:{ading:{type:"http",url:`http://127.0.0.1:${address.port}/mcp`,headers:{Authorization:`Bearer ${token}`},alwaysLoad:true,timeout:Math.max(1000,input.timeoutMs??100_000_000)}}}),
    close:()=>{scope.abort();server.close();server.closeAllConnections();}
  };
}
