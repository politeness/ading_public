import { randomUUID } from "node:crypto";
import type { TurnInput } from "../agents/types";
import { p } from "../prompt-language";

const skillActions=["list","get","create","import","update","delete"];
const memoryActions=["list","append","update","delete"];
export function knowledgeTools() {
  const common={scope:{type:"string"},ownerId:{type:"string"},content:{type:"string"},patch:{type:"object",additionalProperties:true}};
  return [
    {name:"ading_skill",description:p("读取或维护阿钉中央技能库。action: list/get/create/import/update/delete。创建和修改先保存中央权威副本，再同步所有已发现的Agent。完整技能包用sourcePath导入目录或zip，包含scripts/assets/references；不要把厂商目录作为权威来源。", "Read or maintain ADing's central skill library. Actions: list/get/create/import/update/delete. Save the authoritative central copy first, then sync all discovered Agents. Import complete packages from a directory or zip through sourcePath, including scripts/assets/references; vendor directories are not the source of truth."),inputSchema:{type:"object",properties:{...common,action:{type:"string",enum:skillActions},skillId:{type:"string"},name:{type:"string"},description:{type:"string"},sourcePath:{type:"string"},targets:{type:"array",items:{type:"string"}}},required:["action"],additionalProperties:false}},
    {name:"ading_memory",description:p("读取或维护阿钉中央记忆库。action: list/append/update/delete；scope为user/workspace/conversation。先保存中央，个人记忆再由阿钉通知各Agent同步。个人记忆只执行用户明确要求的修改，并设userRequested=true；不自动推断或沉淀个人偏好。讨论和只读轮只允许list；保存记忆用这个工具，不要只改厂商自己的记忆文件。", "Read or maintain ADing's central memory library. Actions: list/append/update/delete; scopes: user/workspace/conversation. Save centrally first; ADing then notifies Agents to sync personal memory. Change personal memory only when the user explicitly asks, setting userRequested=true; do not automatically infer or capture personal preferences. Discussion and read-only turns allow only list; save memories through this tool rather than only in a vendor's own memory files."),inputSchema:{type:"object",properties:{...common,action:{type:"string",enum:memoryActions},memoryId:{type:"string"},pinned:{type:"boolean"},limit:{type:"number"},userRequested:{type:"boolean"}},required:["action"],additionalProperties:false}}
  ];
}
export function isKnowledgeTool(name:unknown):name is "ading_skill"|"ading_memory" {return name==="ading_skill"||name==="ading_memory";}
export function knowledgeMutation(args:unknown):boolean {return !["list","get"].includes(String((args as {action?:unknown})?.action??""));}
export async function runKnowledgeTool(input:TurnInput,name:string,args:unknown,signal:AbortSignal):Promise<unknown> {
  if(!isKnowledgeTool(name)||!input.onKnowledgeTool)throw new Error(p("阿钉知识工具不可用", "ADing knowledge tools are unavailable"));
  signal.throwIfAborted();
  if(knowledgeMutation(args)) {
    if(!input.fullAccess||input.discussionOnly||input.communicationOnly)throw new Error(p("本轮为讨论或只读轮次，只能读取阿钉知识；请在获授权的执行轮次保存修改。", "This discussion or read-only turn can only read ADing knowledge; save changes in an authorized execution turn."));
    if(input.permissionMode!=="unattended") {
      const allowed=input.onPermission && await input.onPermission({requestId:`knowledge:${randomUUID()}`,toolName:name,input:args && typeof args==="object" ? args as Record<string,unknown> : {},workspacePath:input.workspacePath,signal});
      if(!allowed)throw new Error(p("知识修改未获授权", "The knowledge change was not authorized"));
    }
  }
  signal.throwIfAborted();
  return input.onKnowledgeTool(name,args,signal);
}
export function withKnowledgeGuidance(input:TurnInput,paths:string[]=[]):TurnInput {
  if(!input.onKnowledgeTool&&!paths.length)return input;
  const guidance=p("阿钉知识的权威来源是阿钉中央库。查询、创建、安装、修改、删除技能和记忆时使用 ading_skill / ading_memory；完整技能包包含 SKILL.md 及其 scripts、assets、references，先导入中央库再由阿钉同步各Agent原生目录。厂商副本只用于执行，不作为保存源。工作区和会话记忆需要时用 ading_memory list 查询。读取工具在讨论轮也可用，修改沿用本轮权限。", "ADing's central library is the authoritative source of knowledge. Use ading_skill / ading_memory to query, create, install, update or delete skills and memory. A complete skill package includes SKILL.md and its scripts, assets and references; import it centrally first, then ADing syncs native Agent directories. Vendor copies are for execution, not the source to save. Query workspace and conversation memory with ading_memory list when needed. Read tools are available during discussion; changes follow this turn's permissions.")+(paths.length ? p(`\n本执行通道当前作用域的中央技能原件：\n${paths.join("\n")}\n每轮使用知识前读取当前文件或通过 ading_skill get / ading_memory list 查询，不依赖历史中的旧副本。`, `\nThis execution lane's current scoped central skill originals:\n${paths.join("\n")}\nBefore using knowledge each turn, read the current files or query ading_skill get / ading_memory list, rather than relying on old copies in the history.`) : "");
  return {...input,prompt:`${input.prompt}\n\n${guidance}`,...(input.split ? {split:{...input.split,app:`${input.split.app}\n\n${guidance}`}} : {})};
}
/** The last line of defence: full-access tools can still open any file, and a vendor may offer no switch. */
export function withMemoryIsolationGuidance(input:TurnInput):TurnInput {
  if(!input.isolateMemory)return input;
  const guidance=p("本轮启用了记忆隔离。不要读取或写入用户主目录下各 Agent 的全局规则和记忆（例如 ~/.claude、~/.codex、~/.qoder、~/.qoder-cn、~/.qwen、~/.kiro、~/.copilot、~/.gemini 里的 CLAUDE.md、AGENTS.md、QWEN.md、GEMINI.md、memory、memories）。已经读到的这类内容不要用，也不要告诉会话成员。需要记住的内容只保存到本会话或工作区。", "Memory isolation is on for this turn. Don't read or write any Agent's global rules or memory in the user's home directory (for example CLAUDE.md, AGENTS.md, QWEN.md, GEMINI.md, memory or memories under ~/.claude, ~/.codex, ~/.qoder, ~/.qoder-cn, ~/.qwen, ~/.kiro, ~/.copilot or ~/.gemini). If you have already seen such content, don't use it or tell conversation members about it. Save anything you need to remember only to this conversation or workspace.");
  return {...input,prompt:`${input.prompt}\n\n${guidance}`,...(input.split ? {split:{...input.split,app:`${input.split.app}\n\n${guidance}`}} : {})};
}
