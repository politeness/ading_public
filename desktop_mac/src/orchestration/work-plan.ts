import path from "node:path";
import { retryableStoreError, storeFailureReason } from "./store-retry";
import type { Store } from "../store/store";
import { newId } from "../store/ids";
import { p } from "../prompt-language";

/** Resolve a unique in-task display name/kind to its durable member id. Models
 * occasionally use the visible label even when the prompt asks for an id; a
 * unique match is unambiguous and must not cost another model round. */
export async function normalizeWorkCandidates(store: Store, conversation: Conversation, entries: NonNullable<LeaderControl["work"]>): Promise<NonNullable<LeaderControl["work"]>> {
  const users=(await Promise.all(conversation.members.map(member=>store.getUser(member.userId)))).filter((user):user is UserRef=>!!user);
  const leaderId=conversation.members.find(member=>member.role==="LEADER")?.userId;
  return entries.map(entry=>({...entry,candidates:entry.candidates.map(candidate=>{
    if(conversation.members.some(member=>member.userId===candidate))return candidate;
    const key=candidate.trim().toLowerCase();
    if(leaderId && ["leader","team leader","负责人","组长"].includes(key))return leaderId;
    const matches=users.filter(user=>user.displayName?.trim().toLowerCase()===key || user.username?.trim().toLowerCase()===key || user.kind?.toLowerCase()===key);
    return matches.length===1 ? matches[0].userId : candidate;
  })}));
}

/** Persisted small work queue; the model decides splits/capability candidates, and the scheduler handles dependencies, occupancy, and filling idle slots. */
export class WorkPlanner {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: {
    store: Store;
    workspacePath?(conversation: Conversation): Promise<string>;
    available(id: string, conversationId: string): boolean;
    busy(id: string, conversationId: string, leaderId: string): boolean;
    capacity?(id: string): number;
    deliver(conversation: Conversation, agent: UserRef, message: Message): Promise<void>;
    log(event: string, detail: Record<string, unknown>): Promise<void>;
    /** Only the computer coordinating the task changes the shared queue; others report through messages. */
    coordinates?(conversation: Conversation): Promise<boolean>;
  }) {}

  private async coordinates(conversation: Conversation | null | undefined): Promise<boolean> {
    return !!conversation && (!this.deps.coordinates || await this.deps.coordinates(conversation));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  merge(conversationId: string, entries: NonNullable<LeaderControl["work"]>, basis?: WorkItem[]): Promise<void> {
    return this.serial(async () => {
      const conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.type !== "GROUP" || conversation.paused || conversation.status !== "ACTIVE") throw new Error(p("会话未运行", "The conversation isn't running"));
      entries=await normalizeWorkCandidates(this.deps.store,conversation,entries);
      const plan = structuredClone(conversation.workPlan ?? []);
      if (basis) {
        // Compare only the items this decision edits/depends on; unrelated deliveries do not block it.
        for (const id of new Set(entries.flatMap(w => [w.id, ...w.dependsOn]))) {
          if (JSON.stringify(basis.find(w => w.id === id)) !== JSON.stringify(plan.find(w => w.id === id))) {
            throw new Error(p(`工作或依赖已变化，请按最新状态安排：${id}`, `The work or its dependencies have changed; arrange according to the latest state: ${id}`));
          }
        }
      }
      const incoming = new Set<string>();
      for (const entry of entries) {
        if (incoming.has(entry.id)) throw new Error(p(`工作编号重复：${entry.id}`, `Duplicate work id: ${entry.id}`));
        incoming.add(entry.id);
        if (entry.outputs.some(output=>/[\\\/]$/.test(output.trim()))) {
          throw new Error(p(`工作 ${entry.id} 的 outputs 不能只声明目录；数量未定时请声明可验收的文件模式，例如 output/*.png`, `The outputs of work ${entry.id} can't just declare a directory; when the count isn't fixed, declare a file pattern that can be accepted, e.g. output/*.png`));
        }
        for (const id of entry.candidates) {
          const member = conversation.members.find(m => m.userId === id);
          const user = await this.deps.store.getUser(id);
          if (!member || member.role === "OBSERVER" || !user?.isAgent) throw new Error(p(`候选人不是执行成员：${id}`, `The candidate isn't an executing member: ${id}`));
        }
        const existing = plan.find(w => w.id === entry.id);
        if (existing && !["queued", "blocked"].includes(existing.status)) throw new Error(p(`不能改写进行中或已交付工作：${entry.id}`, `Can't rewrite work that's in progress or already delivered: ${entry.id}`));
        const item: WorkItem = {...entry, candidates:[...new Set(entry.candidates)], dependsOn:[...new Set(entry.dependsOn)], status:"queued"};
        if (existing) plan.splice(plan.indexOf(existing), 1, item); else plan.push(item);
      }
      if (plan.length > 100) throw new Error(p("请分阶段规划，单阶段最多100项工作", "Please plan in stages; at most 100 work items per stage"));
      const seen = new Set<string>(); const visiting = new Set<string>();
      const visit = (id: string): void => {
        if (visiting.has(id)) throw new Error(p("工作依赖不能形成环", "Work dependencies can't form a cycle"));
        if (seen.has(id)) return;
        const item = plan.find(w => w.id === id);
        if (!item) throw new Error(p(`依赖不存在：${id}`, `Dependency doesn't exist: ${id}`));
        visiting.add(id); item.dependsOn.forEach(visit); visiting.delete(id); seen.add(id);
      };
      plan.forEach(w => visit(w.id));
      await this.deps.store.updateConversation(conversationId, {workPlan:plan});
      await this.deps.log("work-plan-updated", {conversation:conversationId, items:entries.map(w=>w.id)});
    });
  }

  transition(conversationId: string, assignment: NonNullable<Message["coordination"]>, phase: "result" | "blocked"): Promise<void> {
    return this.serial(async () => {
      const conversation = await this.deps.store.getConversation(conversationId);
      if (!(await this.coordinates(conversation))) return;
      const plan = structuredClone(conversation?.workPlan ?? []);
      const item = plan.find(w => w.id === assignment.workId && w.assignmentId === assignment.id && w.status === "active");
      if (!item) return;
      item.status = phase === "result" ? "review" : "blocked";
      item.completedAt = new Date().toISOString();
      await this.deps.store.updateConversation(conversationId, {workPlan:plan});
    });
  }

  interrupt(conversationId: string, leaderId: string, assignment: NonNullable<Message["coordination"]>, abort: () => void): Promise<boolean> {
    return this.serial(async () => {
      const conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.paused || conversation.status !== "ACTIVE" || !conversation.members.some(m=>m.userId===leaderId && m.role==="LEADER")) return false;
      const plan = structuredClone(conversation.workPlan ?? []);
      const item = plan.find(w=>w.id===assignment.workId && w.assignmentId===assignment.id && w.status==="active");
      if (!item) return false;
      // Serialize with result publication; invalidate the execution lease before another await.
      abort();
      item.status = "blocked";
      await this.deps.store.updateConversation(conversationId,{workPlan:plan});
      return true;
    });
  }

  /** Interrupt a demonstrably bad attempt and queue a concrete corrected method.
   * The same logical work id and durable task context are retained; only the
   * execution lease/provider branch changes, so the worker sees the Leader's new
   * evidence before touching the files again. */
  redirect(conversationId: string, leaderId: string, assignment: NonNullable<Message["coordination"]>, revisedAssignment: string, evidence: string, abort: () => void, targetId?: string): Promise<boolean> {
    return this.serial(async () => {
      const conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.paused || conversation.status !== "ACTIVE" || !conversation.members.some(m=>m.userId===leaderId && m.role==="LEADER")) return false;
      const plan = structuredClone(conversation.workPlan ?? []);
      const item = plan.find(w=>w.id===assignment.workId && w.assignmentId===assignment.id && w.status==="active");
      if (!item) return false;
      abort();
      const previous=item.assigneeId;
      item.assignment=revisedAssignment.trim();
      item.evidence=evidence.trim();
      item.status="queued";
      item.preAgreed=true;
      item.resumeAfterInterrupt=true;
      item.interventions=(item.interventions??0)+1;
      item.candidates=targetId ? [targetId] : previous ? [previous,...item.candidates.filter(id=>id!==previous)] : item.candidates;
      item.assigneeId=undefined;
      item.assignmentId=undefined;
      item.startedAt=undefined;
      item.completedAt=undefined;
      await this.deps.store.updateConversation(conversationId,{workPlan:plan});
      await this.deps.log("work-redirected",{conversation:conversationId,work:item.id,previousAssignee:previous,nextAssignee:targetId,interventions:item.interventions});
      return true;
    });
  }

  review(conversationId: string, id: string, verdict: "pass" | "retry", evidence: string, basis?: WorkItem): Promise<void> {
    return this.serial(async () => {
      const conversation = await this.deps.store.getConversation(conversationId);
      const plan = structuredClone(conversation?.workPlan ?? []);
      const item = plan.find(w=>w.id===id);
      // Concurrent reviewers may approve the same immutable delivery. Keep the
      // first receipt instead of turning a successful duplicate into a failure.
      if (item?.status === "done" && verdict === "pass" && basis &&
          ["review","done"].includes(basis.status) && item.assignmentId === basis.assignmentId &&
          item.completedAt === basis.completedAt) return;
      if (!item || item.status !== "review") throw new Error(p("只能验收已提交的工作", "Only submitted work can be accepted"));
      if (basis && (basis.status !== "review" || item.assignmentId !== basis.assignmentId || item.completedAt !== basis.completedAt)) {
        throw new Error(p("该工作在本轮期间已变化，请按最新交付重新复核；原复核意见已保留。", "This work changed during this turn; review it again against the latest delivery. The original review comments are kept."));
      }
      item.evidence = evidence;
      item.status = verdict === "pass" ? "done" : "blocked";
      if (verdict === "retry") { item.assigneeId = undefined; item.assignmentId = undefined; }
      await this.deps.store.updateConversation(conversationId, {workPlan:plan});
      await this.deps.log("work-reviewed", {conversation:conversationId, work:id, verdict});
    });
  }

  /** Don't pile new work on busy members. Within the candidate pool, whoever becomes idle first takes the next item. */
  fill(conversationId: string): Promise<void> {
    return this.serial(async () => {
      let conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.type !== "GROUP" || conversation.paused || conversation.status !== "ACTIVE" || conversation.charter?.mode !== "execution" || !conversation.workPlan?.length) return;
      const leader = conversation.members.find(m=>m.role==="LEADER");
      if (!leader || !(await this.coordinates(conversation))) return;
      const plan = structuredClone(conversation.workPlan);
      const workspacePath = await this.deps.workspacePath?.(conversation) ?? conversation.workspacePath ?? process.cwd();
      const messages = await this.deps.store.listMessages(conversationId, {limit:1000});
      const latest = new Map<string, NonNullable<Message["coordination"]>>();
      for (const m of messages) if (m.coordination) latest.set(m.coordination.id,m.coordination);
      // Even source-read-only reviews can write reports. Reserve every declared
      // output until review completes, independently of the source constraint.
      const activeOutputs = () => plan.filter(w=>["active","review"].includes(w.status)).flatMap(w=>w.outputs).map(p=>path.resolve(workspacePath, p));
      const conflicts = (a:string,b:string) => a===b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep);
      for (const item of plan) {
        if (item.status !== "queued" || !item.dependsOn.every(id=>plan.some(w=>w.id===id && w.status==="done"))) continue;
        if (item.outputs.some(p=>activeOutputs().some(a=>conflicts(a,path.resolve(workspacePath,p))))) continue;
        const candidates = item.candidates.filter(id=> {
          const member = conversation!.members.find(m=>m.userId===id);
          return member && !member.paused && member.role!=="OBSERVER" && this.deps.available(id,conversationId) && !this.deps.busy(id, conversationId, leader.userId) &&
            plan.filter(w=>w.status==="active" && w.assigneeId===id).length < (this.deps.capacity?.(id) ?? 1) &&
            ![...latest.values()].some(a=>a.assigneeId===id && !a.workId && ["proposal","accepted"].includes(a.phase));
        });
        // Candidate order expresses capability preference; equal candidates are first filtered by idleness. No need to guess quota or model strength.
        // Spread work across free Agents before using a second lane on one Agent.
        candidates.sort((a,b)=>plan.filter(w=>w.status === "active" && w.assigneeId === a).length - plan.filter(w=>w.status === "active" && w.assigneeId === b).length);
        const id = candidates[0];
        if (!id) {
          const canRecoverWithoutReplan = item.candidates.some(id => {
            const member = conversation!.members.find(m=>m.userId===id);
            return member && !member.paused && member.role!=="OBSERVER" && this.deps.available(id,conversationId);
          });
          if (!canRecoverWithoutReplan) {
            item.status = "blocked";
            item.evidence = p("所有候选成员均不可用、已暂停或已退出，请 Leader 更新候选人。", "All candidate members are unavailable, paused or have left; the Leader needs to update the candidates.");
            conversation = await this.deps.store.updateConversation(conversationId,{workPlan:plan});
            const owner = await this.deps.store.getUser(leader.userId);
            if (owner) {
              const notice = await this.deps.store.appendMessage({conversationId,clientMessageId:newId("message"),senderId:leader.userId,type:"TASK",mentions:[leader.userId],content:p(`工作 ${item.id} 未派发：${item.evidence}`, `Work ${item.id} not dispatched: ${item.evidence}`)});
              await this.deps.log("work-blocked",{conversation:conversationId,work:item.id,reason:"no-available-candidate"});
              await this.deps.deliver(conversation,owner,notice);
            }
          }
          continue;
        }
        const agent = await this.deps.store.getUser(id); if (!agent) continue;
        item.assigneeId=id; item.assignmentId=newId("message"); item.status="active"; item.startedAt=new Date().toISOString();
        const self = id===leader.userId;
        // Initial direct execution needs an explicit confirmation of the latest
        // reviewed concrete method, not mere participation in an earlier ideas
        // round. A Leader-corrected continuation is already an active-work
        // control decision and resumes without a redundant acceptance round.
        const accepted = self || item.resumeAfterInterrupt === true || (item.preAgreed === true && conversation.brainstorm?.phase === "ready" && conversation.brainstorm.confirmedParticipants?.includes(id));
        const input: Parameters<Store["appendMessage"]>[0] = {conversationId, clientMessageId:newId("message"), senderId:leader.userId, type:"TASK", mentions:[id],
          content:p(`${self ? "Leader 开始承担" : accepted ? `${agent.displayName} 已在共同讨论中确认具体方法，直接开始` : `请 ${agent.displayName} 评估并确认`}工作 ${item.id}：${item.assignment}\n验收：${item.acceptance}\n产物：${item.outputs.join("、") || "只读报告"}`, `${self ? "The Leader is taking on" : accepted ? `${agent.displayName} already confirmed the specific method in the joint discussion and is starting directly on` : `${agent.displayName}, please evaluate and confirm`} work ${item.id}: ${item.assignment}\nAcceptance: ${item.acceptance}\nOutputs: ${item.outputs.join(", ") || "read-only report"}`),
          coordination:{id:item.assignmentId, workId:item.id, assigneeId:id, phase:accepted ? "accepted" : "proposal", brief:p(`${item.assignment}\n验收：${item.acceptance}\n产物：${item.outputs.join("、") || "只读报告"}`, `${item.assignment}\nAcceptance: ${item.acceptance}\nOutputs: ${item.outputs.join(", ") || "read-only report"}`), readOnly:item.readOnly}};
        let message: Message | undefined;
        let failure: unknown;
        let attempts = 0;
        for (let attempt=1;attempt<=3;attempt++) {
          const current = await this.deps.store.getConversation(conversationId);
          if (!current || current.paused || current.status !== "ACTIVE") return;
          attempts=attempt;
          try {
            conversation = await this.deps.store.updateConversation(conversationId,{workPlan:plan});
            message = await this.deps.store.appendMessage(input);
            break;
          } catch (error) {
            failure=error;
            await this.deps.log("work-dispatch-save-retry",{conversation:conversationId,work:item.id,attempt,error:String(error),retryable:retryableStoreError(error)});
            if (!retryableStoreError(error)) break;
          }
        }
        if (!message) {
          item.status="blocked";
          item.evidence=p(`派单保存失败（${attempts} 次）：${storeFailureReason(failure)}`, `Saving the dispatch failed (${attempts} attempts): ${storeFailureReason(failure)}`);
          await this.deps.store.updateConversation(conversationId,{workPlan:plan});
          const notice=await this.deps.store.appendMessage({conversationId,clientMessageId:newId("message"),senderId:leader.userId,type:"TASK",mentions:[leader.userId],
            content:p(`工作 ${item.id} 未启动：${item.evidence}。请处理存储问题后继续会话。`, `Work ${item.id} didn't start: ${item.evidence}. Resolve the storage problem and continue the conversation.`),coordination:{...input.coordination!,phase:"rejected"}});
          const owner=await this.deps.store.getUser(leader.userId);
          if (owner) await this.deps.deliver(conversation,owner,notice);
          continue;
        }
        latest.set(message.coordination!.id,message.coordination!);
        await this.deps.log("work-dispatched",{conversation:conversationId,work:item.id,agent:id,readOnly:item.readOnly});
        await this.deps.deliver(conversation,agent,message);
      }
    });
  }
}
