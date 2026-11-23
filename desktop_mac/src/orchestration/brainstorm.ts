import type { Store } from "../store/store";
import { newId } from "../store/ids";
import { normalizeWorkCandidates } from "./work-plan";
import { p } from "../prompt-language";
import { humanMemberIds, inputAnswered, isHumanInput } from "./human-input";

const LEADER_UNAVAILABLE_ZH="Leader当前不可用，尚未完成方案讨论。";
const LEADER_UNAVAILABLE_EN="The Leader is currently unavailable; the plan discussion isn't finished.";
/** Stored reasons keep the language they were written in, so both wordings are recognized. */
export function leaderUnavailable(reason?: string): boolean {
  return reason===LEADER_UNAVAILABLE_ZH || reason===LEADER_UNAVAILABLE_EN;
}

export function brainstorming(conversation: Conversation): boolean {
  return !!conversation.brainstorm && conversation.brainstorm.phase !== "ready";
}

export function brainstormInstruction(state: BrainstormState, agentId: string): string {
  const leader = agentId === state.leaderId;
  const stages: Record<BrainstormState["phase"], string> = {
    frame: p("先理解主人的请求，用不超过250字说明目标、边界、完成标准和真正需要同伴补充的问题。提出自己的初步方法，但不要先定方案或分工；随后系统邀请其他可用成员提出意见。", "First understand the task owner's request, and in no more than 250 words state the goal, scope, completion criteria and the questions that genuinely need input from peers. Propose your own initial approach, but don't settle the plan or the division of work yet; the system will then invite other available members to give their views."),
    ideas: leader ? p("你与同伴正在从主人原始要求出发并行形成独立视角，避免先被单一方案锚定。先简短确认目标、边界和完成标准，再用只读工具核对会决定路线的事实并形成一份可执行的待定短计划；不要修改文件或正式执行。只需核实：(1)输入存在、格式和决定边界的最小实看，(2)主工具确实可用，(3)首样选择。不要在方案阶段枚举可选包版本、重复失败命令、遍历无关文件或提前做执行细节，普通合法性检查留给执行者。计划必须具体到主工具、步骤、首样、实物验收、真实依赖和成员分工。若同伴随后给出有效意见，下一阶段只做增量修正；若全部同伴超时/无有效意见，系统可直接采用这份经你核对的计划，避免你原样重讲。", "You and your peers are forming independent perspectives in parallel from the task owner's original request, to avoid being anchored by a single plan too early. First briefly confirm the goal, scope and completion criteria, then use read-only tools to check the facts that decide the route and form an executable, tentative short plan; don't modify files or formally execute. Only verify: (1) that the inputs exist, their format, and the minimal look needed to decide the scope, (2) that the main tool is actually available, (3) the choice of the first sample. At the planning stage, don't enumerate optional package versions, repeat failing commands, walk through unrelated files or work out execution details early; leave ordinary validity checks to the executor. The plan must be concrete down to the main tool, steps, first sample, acceptance on real outputs, real dependencies and member assignments. If peers then give useful input, the next stage only makes incremental corrections; if all peers time out or give no useful input, the system can adopt this plan you verified directly, so you don't have to repeat it.") : p("直接依据主人原始要求形成独立意见，不必等待Leader先定调。用不超过400字提出会实质改变方案的步骤、遗漏、风险和工具能力限制。必须具体指出首选工具/方法和第一个验证动作；敢于纠错，不盲从，也不复述任务。没有新观点就简短说明。", "Form an independent view directly from the task owner's original request, without waiting for the Leader to set the tone. In no more than 400 words, raise the steps, omissions, risks and tool capability limits that would materially change the plan. You must name the preferred tool/method and the first verification step; be willing to correct mistakes, don't just go along, and don't restate the task. If you have no new points, say so briefly."),
    synthesize: p("综合大家意见，直接形成可执行最终方案：验收标准、主工具和具体步骤、首个样本、失败判据、替代路线、真正依赖，并明确采纳/否决的方法及原因。本轮可用只读工具核对会改变方法的关键输入事实；最终路线依赖的本机文件、格式或工具可用性必须在本轮实际核对，不能把成员建议当成已安装事实，能只读确认的事项不再申请独立probe。最终plan一次列出当前已知的近期工作：关键路径交给实际掌握被采纳方法的最合适成员，其他成员并行做不阻塞关键路径的清单、边界任务或独立复核；Leader也承担一项合适的实质工作。不要把整条关键路径交给首选方法已被否决或工具尚未验证的成员，也不要进入执行后再补同阶段计划。若关键疑虑已解决，本轮直接进入分工；只有仍存在会改变方法的具体分歧才继续复核，不要为流程完整而追加回合。若是普通沟通就汇总观点，不编造操作任务。", "Combine everyone's views and form an executable final plan directly: acceptance criteria, the main tool and specific steps, the first sample, failure criteria, a fallback route, real dependencies, and clearly which methods are adopted or rejected and why. This turn you may use read-only tools to check key input facts that would change the method; the local files, formats or tool availability the final route relies on must actually be checked this turn — don't treat members' suggestions as installed facts, and don't request a separate probe for things that can be confirmed read-only. The final plan lists all currently known near-term work at once: give the critical path to the most suitable member who actually has the adopted method, and have other members work in parallel on lists, edge tasks or independent reviews that don't block the critical path; the Leader also takes on a suitable piece of substantive work. Don't give the whole critical path to a member whose preferred method was rejected or whose tools haven't been verified, and don't add same-stage planning after execution starts. If the key doubts are resolved, go straight to assigning work this turn; only continue reviewing when a specific disagreement that would change the method remains — don't add rounds just to complete the process. If it's ordinary conversation, summarize the views and don't invent operational tasks."),
    review: p("复核Leader最新方案，重点找不可行之处、遗漏、无关依赖和不必要成本。确认自己执行时会采用哪条已讨论的具体路线；若想改用被否决的方法，必须给出新证据并继续讨论。明确关键疑虑、改进建议或认可理由；若你确认最新具体工具、步骤、边界和失败路线可直接执行，在简短理由后附 {\"control\":{\"action\":\"brainstorm\",\"decision\":\"agree\",\"reason\":\"确认的具体路线\"}}。没有此确认、超时或SKIP都不算预先同意。你只参与评审，不决定团队进入执行。", "Review the Leader's latest plan, focusing on what's infeasible, omissions, unrelated dependencies and unnecessary cost. Confirm which discussed specific route you'd use when executing; if you want to switch to a rejected method, you must give new evidence and keep discussing. State clearly your key doubts, suggested improvements or reasons for approval; if you confirm the latest specific tools, steps, scope and failure route can be executed directly, append {\"control\":{\"action\":\"brainstorm\",\"decision\":\"agree\",\"reason\":\"the specific route confirmed\"}} after a brief reason. Without this confirmation, a timeout or SKIP doesn't count as prior agreement. You only take part in the review and don't decide when the team starts executing."),
    decide: p("阅读所有复核意见并逐项回应关键疑虑。目标/验收明确、执行方法具体到主工具、首个样本、验收和失败后的替代路线，且关键疑虑已解决时，说明最终采用和明确不采用的方法，然后用 plan 登记分工进入执行。纯交流用 {\"control\":{\"action\":\"organize\"}} 结束共同讨论、回到普通群聊，已经回答完毕可stop。若重要方法或拆解变化，使用brainstorm revise重新汇总并复核，不能直接执行未经复核的新方案。", "Read all the review comments and respond to the key doubts one by one. When the goal and acceptance are clear, the execution method is concrete down to the main tool, the first sample, acceptance and the fallback route after failure, and the key doubts are resolved, state the methods finally adopted and explicitly not adopted, then register the work with plan to move into execution. For pure conversation use {\"control\":{\"action\":\"organize\"}} to end the joint discussion and go back to normal group chat; if everything has been answered you can stop. If an important method or breakdown changes, use brainstorm revise to re-summarize and review again; a new plan that hasn't been reviewed can't be executed directly."),
    probe: p(`仅做一项限定范围的前置验证：${state.reason ?? "核实方案前提"}。允许核对输入、实际工具能力或制作独立小样；不能铺开正式工作、修改原件或扩大权限。报告实际证据、限制和结论，随后重新汇总方案并复核。工具审批遵循应用全局策略。`, `Do only one bounded preliminary verification: ${state.reason ?? "verify the plan's premises"}. You may check inputs, actual tool capabilities or make an independent small sample; you may not roll out the formal work, modify originals or widen permissions. Report the actual evidence, limits and conclusion; the plan is then re-summarized and reviewed. Tool approvals follow the app's global policy.`),
    waiting: p("等待必要信息或恢复条件，不擅自执行。", "Wait for the necessary information or recovery conditions; don't execute on your own."),
    ready: p("方案讨论已经结束。", "The plan discussion has ended.")
  };
  return [
    p(`当前是分工前共同讨论阶段：${state.phase}，第${state.round}轮。${leader ? "你是Leader，负责引导和收敛，也要独立思考。" : "你是参与方案制定和复核的成员。"}`, `This is the joint discussion stage before assigning work: ${state.phase}, round ${state.round}. ${leader ? "You are the Leader, responsible for guiding and converging, and you should also think independently." : "You are a member who helps draft and review the plan."}`),
    stages[state.phase],
    state.phase === "probe" ? p("这是有限验证，不是正式执行。", "This is a bounded verification, not formal execution.") : state.phase === "synthesize" || (state.phase === "ideas" && leader) ? p("本轮只允许只读核对，不修改文件、不正式执行。不要声称已经看过未实际读取的文件。", "This turn only allows read-only checks: don't modify files or formally execute. Don't claim to have looked at files you didn't actually read.") : p("本轮只沟通，没有工具；不要从本轮工具限制推断自己的执行能力或任务权限。不要声称已经看过未实际读取的文件。", "This turn is communication only, with no tools; don't infer your execution capabilities or task permissions from this turn's tool limits. Don't claim to have looked at files you didn't actually read."),
    p("讨论聚焦会改变方案、质量或分工的实质分歧。已明确的范围不反复复述；普通格式解析、输入合法性检查和工具可用性检查默认由执行者在任务中完成，不自动升级为全队前置验证。只有不先核实就无法选择方案的关键事实才提出 probe，并尽早提出；评审通过后不为已回答的事项重开讨论。", "Focus the discussion on substantive disagreements that would change the plan, quality or division of work. Don't keep restating scope that's already clear; ordinary format parsing, input validity checks and tool availability checks are done by the executor during the task by default and aren't automatically escalated into a team-wide preliminary verification. Only propose a probe for key facts without which a plan can't be chosen, and propose it early; after the review passes, don't reopen discussion on matters already answered."),
    p("所有实际观点和问题直接写成聊天正文，不加系统或流程包装。不要用空泛的‘都同意了’代替实际评审。不可用/超时成员不是赞成票。", "Write all actual views and questions directly as chat text, without system or process wrapping. Don't substitute a vague 'everyone agreed' for an actual review. Unavailable or timed-out members are not votes in favor."),
    p("只把确需真人决定的信息缺口或需求冲突交给主人，由Leader集中提出具体问题；应用权限由现有人工审核、Agent审核或无人值守策略处理，不制造新的审批环节。", "Only hand information gaps or requirement conflicts that truly need a human decision to the task owner, with the Leader raising the specific questions in one place; app permissions are handled by the existing human review, Agent review or unattended policy — don't create new approval steps."),
    p("分工之后按能力、本人实际可用的工具、已知剩余额度、同类实际工作的可比速度证据和工作量动态安排，包括Leader自己；配额未知不能猜。某工具、skill或方法只被一位成员实际核实时，默认只有该成员已证明能执行，不能因为另一成员短回复更快就把这条路线转交给他。不要为了凑并行把独立工作串上无关依赖。", "After assigning work, schedule dynamically by capability, the tools each member actually has, known remaining quota, comparable speed evidence from similar actual work, and workload, including the Leader; unknown quota can't be guessed. When a tool, skill or method has only been actually verified by one member, by default only that member has proven they can execute it; don't hand that route to another member just because their short replies are faster. Don't chain independent work onto unrelated dependencies just to make up parallelism."),
    leader && ["synthesize","decide"].includes(state.phase) && state.turnDurationsMs ? p(`本会话讨论阶段的观测耗时：${Object.entries(state.turnDurationsMs).map(([id,times])=>`${id}=${Math.round(times.reduce((a,b)=>a+b,0)/times.length/1000)}秒`).join("；")}。这些回合的角色和工作量不同（Leader可能实际读文件/工具，同伴可能只写意见），原始秒数不可直接比较为执行速度，更不能覆盖工具与质量能力；仅把超时/无结果当作不宜独占关键前置工作的风险证据。`, `Observed durations in this conversation's discussion stage: ${Object.entries(state.turnDurationsMs).map(([id,times])=>`${id}=${Math.round(times.reduce((a,b)=>a+b,0)/times.length/1000)} s`).join("; ")}. These turns differ in role and workload (the Leader may actually read files/use tools, while peers may only write views), so the raw seconds can't be compared directly as execution speed, let alone override tool and quality capability; only treat timeouts/no result as evidence of risk against giving that member sole ownership of critical preliminary work.`) : "",
    state.reason ? p(`本阶段补充要求：${state.reason}`, `Additional requirement for this stage: ${state.reason}`) : "",
    leader && state.phase==="synthesize" && state.evidenceReady ? p("你已在上一并行阶段实际完成只读核对和待定短计划。本轮直接复用，只结合新收到的同伴意见做增量修正，不从头重新分析，也不再调用工具或重复核对相同事实。若已有已验证且能满足验收的路线，同伴仅提出一个尚未验证的新工具不构成probe理由：明确暂不采用即可；只有现有路线不能满足验收且该事实会改变可行性时，才申请更窄的probe。", "You already actually finished the read-only checks and a tentative short plan in the previous parallel stage. Reuse them directly this turn, only making incremental corrections based on newly received peer views; don't re-analyze from scratch, and don't call tools again or re-check the same facts. If there's already a verified route that meets acceptance, a peer merely proposing an unverified new tool isn't a reason for a probe: just say clearly it's not adopted for now; only request a narrower probe when the existing route can't meet acceptance and that fact would change feasibility.") : "",
    leader && state.phase==="ideas" ? p(`只读核对完成后，回复必须从一份完整的待定机器计划开始：{"control":{"action":"plan","work":[{"id":"W1","assignment":"具体步骤","candidates":["成员id"],"dependsOn":[],"outputs":["具体文件或单星号模式"],"acceptance":"实物验收标准","readOnly":false}]}}。control总长不超过2400字符，id只用ASCII（如W1），列3–5项，每项assignment不超过120字、acceptance不超过60字，省略false的preAgreed；当前Leader id是${state.leaderId}，local:me不是Agent。你本轮亲自核实的工具链应由你承担关键首样；其他成员只承担其本人意见已证明能做且不阻塞的工作，除非后续意见提供了相同工具能力的实际证据。完整闭合JSON后，用不超过500字记录证据、限制和首样选择。该control此刻只是待定计划，不代表系统已经执行。`, `After the read-only checks, your reply must start with a complete tentative machine plan: {"control":{"action":"plan","work":[{"id":"W1","assignment":"specific steps","candidates":["member id"],"dependsOn":[],"outputs":["specific file or single-asterisk pattern"],"acceptance":"acceptance criteria on real outputs","readOnly":false}]}}. The control must be at most 2400 characters in total, ids use ASCII only (e.g. W1), list 3–5 items, each assignment at most 120 characters and acceptance at most 60 characters, and omit preAgreed when false; the current Leader id is ${state.leaderId}, and local:me is not an Agent. The toolchain you personally verified this turn should be used by you for the critical first sample; other members only take on work their own views have proven they can do and that doesn't block, unless later views provide actual evidence of the same tool capability. After the fully closed JSON, record the evidence, limits and first-sample choice in no more than 500 words. At this point the control is only a tentative plan and doesn't mean the system has executed it.`) : "",
    state.attempts ? p(`本阶段重试${state.attempts}/2。${state.attempts>=2 ? "这是最后一次自动重试；请在正文明确说明具体障碍、未完成事项和下一步，不要只说继续讨论或SKIP。" : "结合已保存内容修正本轮问题，不重复完整讨论。"}`, `Retry ${state.attempts}/2 for this stage. ${state.attempts>=2 ? "This is the last automatic retry; state clearly in the text the specific obstacle, what's unfinished and the next step — don't just say continue discussing or SKIP." : "Fix this turn's problem using what's already saved; don't repeat the whole discussion."}`) : "",
    leader ? p('必要时使用 {"control":{"action":"brainstorm","decision":"ask","reason":"需要主人回答的具体问题"}}；需要限定前置验证用decision="probe"并说明输入、单项操作和输出。重要方案变化用decision="revise"并说明变化。', 'When needed, use {"control":{"action":"brainstorm","decision":"ask","reason":"the specific question the task owner needs to answer"}}; for a bounded preliminary verification use decision="probe" and state the inputs, the single operation and the output. For important plan changes use decision="revise" and state the change.') : p("成员用自然语言提出疑虑，无需特定格式或控制块。", "Members raise doubts in natural language, with no particular format or control block needed."),
    leader && ["synthesize","decide"].includes(state.phase) ? p(`收敛控制：操作任务的方法、验收和分工都已明确时，优先直接用 {"control":{"action":"plan","work":[{"id":"W1","assignment":"具体步骤","candidates":["成员id"],"dependsOn":[],"outputs":["具体文件或单星号模式"],"acceptance":"实物验收标准","readOnly":false}]}}；这会直接进入执行，不再另开一轮复述计划。机器control必须放在回复第一个字符开始，总长不超过2400字符，完整闭合后才可写不超过300字正文；不得用代码围栏。工作id只能用ASCII字母、数字、下划线或短横线（如W1、audit_2），绝不能把中文标题写进id。列3–5项，每项assignment不超过120字、acceptance不超过60字，只写已讨论路线的执行要点；完整背景会从同一任务聊天和同一Agent session自动共享，不要在每项里复述。省略值为false的preAgreed。宁可完全不写聊天正文，也绝不能截断或写坏control。candidates只能写当前Agent成员的精确id或唯一名称；当前Leader的精确id是 ${state.leaderId}，local:me是人类主人，绝不能作为工作候选。计划应一次包含Leader可立即承担的实质工作，并让独立核查与关键制作并行；只有产物确实必须读取上游结果才写dependsOn，先验收样张不等于清单、工具盘点等所有工作都必须阻塞关键样张。非Leader默认 preAgreed=false，只有该成员已经明确复核完全相同的工具、步骤、边界和失败路线才可为true。普通交流用 {"control":{"action":"organize"}} 结束共同讨论、回到普通群聊；已完成交流可stop。仍有会改变方法的实质分歧才用brainstorm revise继续复核。不要为了固定轮数继续讨论。`, `Convergence control: when the method, acceptance and division of work for an operational task are all clear, prefer using {"control":{"action":"plan","work":[{"id":"W1","assignment":"specific steps","candidates":["member id"],"dependsOn":[],"outputs":["specific file or single-asterisk pattern"],"acceptance":"acceptance criteria on real outputs","readOnly":false}]}} directly; this goes straight to execution without another round restating the plan. The machine control must start at the very first character of the reply and be at most 2400 characters in total; only after it's fully closed may you write at most 300 words of text; don't use code fences. Work ids may only use ASCII letters, digits, underscores or hyphens (e.g. W1, audit_2); never put a Chinese or other non-ASCII title in an id. List 3–5 items, each assignment at most 120 characters and acceptance at most 60 characters, writing only the execution points of the discussed route; the full background is shared automatically from the same task chat and the same Agent session, so don't restate it in each item. Omit preAgreed when its value is false. It's better to write no chat text at all than to truncate or break the control. candidates may only contain the exact ids or unique names of current Agent members; the current Leader's exact id is ${state.leaderId}, and local:me is the task owner (a human) and must never be a work candidate. The plan should include, in one go, substantive work the Leader can take on right away, and run independent checks in parallel with critical production; only write dependsOn when an output really must read upstream results — accepting a sample first doesn't mean lists, tool inventories and all other work must block on the critical sample. Non-Leaders default to preAgreed=false; it can be true only if that member has explicitly reviewed exactly the same tools, steps, scope and failure route. For ordinary conversation use {"control":{"action":"organize"}} to end the joint discussion and go back to normal group chat; a finished conversation can stop. Only use brainstorm revise to keep reviewing when there's still a substantive disagreement that would change the method. Don't keep discussing just to reach a fixed number of rounds.`) : p("本阶段不接受assign、plan、batch或直接进入执行；系统会自动安排下一阶段。", "This stage doesn't accept assign, plan, batch or going directly into execution; the system arranges the next stage automatically.")
  ].filter(Boolean).join("\n");
}

interface Deps {
  store: Store;
  ready(agent: UserRef): boolean;
  active(conversationId: string): boolean;
  run(conversation: Conversation, agent: UserRef): Promise<{ok: boolean; control?: LeaderControl; reason?: string; durationMs?: number}>;
  /** Ends the joint discussion with the Leader's closing control: plan starts the work, stop ends the task, organize just returns to normal chat. */
  proceed(conversation: Conversation, control: LeaderControl): Promise<void>;
  log(event: string, detail: Record<string, unknown>): Promise<void>;
}

/** Durable, bounded review barrier. Member turns run in parallel; replies never fan out recursively. */
export class BrainstormCoordinator {
  private readonly running = new Map<string, {cancelled: boolean; restart: boolean; done?: Promise<void>}>();
  constructor(private readonly deps: Deps) {}

  cancel(conversationId: string): void { const run = this.running.get(conversationId); if (run) run.cancelled = true; }

  async settle(): Promise<void> { await Promise.allSettled([...this.running.values()].map(run=>run.done)); }

  start(conversationId: string): void {
    const current = this.running.get(conversationId);
    if (current) { current.restart = true; return; }
    const run: {cancelled:boolean;restart:boolean;done?:Promise<void>} = {cancelled:false, restart:false};
    this.running.set(conversationId,run);
    run.done = this.loop(conversationId,()=>!run.cancelled && this.deps.active(conversationId)).catch(async error=> {
      await this.deps.log("brainstorm-failed",{conversation:conversationId,error:String(error)});
      const conversation=await this.deps.store.getConversation(conversationId);
      if (conversation?.brainstorm && !run.cancelled) await this.save(conversation,{phase:"waiting",reason:p(`讨论流程未完成：${String(error)}`, `The discussion process didn't finish: ${String(error)}`)});
    }).finally(()=> {
      this.running.delete(conversationId);
      if (run.restart && this.deps.active(conversationId)) this.start(conversationId);
    }).catch(()=>undefined); // A failed diagnostic/state write must not crash the desktop process.
  }

  private async save(conversation: Conversation, patch: Partial<BrainstormState>): Promise<Conversation> {
    const next = await this.deps.store.updateConversation(conversation.conversationId,{brainstorm:{...conversation.brainstorm!,...patch}});
    await this.deps.log("brainstorm-stage",{conversation:conversation.conversationId,phase:next.brainstorm!.phase,round:next.brainstorm!.round,revision:next.brainstorm!.revision,reason:patch.reason});
    if (patch.phase==="waiting" && patch.reason && next.members.some(m=>m.userId===next.brainstorm!.leaderId)) {
      await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:next.brainstorm!.leaderId,
        type:"SYSTEM",internal:true,content:p(`方案讨论暂缓，尚未进入正式执行：${patch.reason}`, `Plan discussion is on hold and formal execution hasn't started: ${patch.reason}`)});
    }
    return next;
  }

  private async inputSeq(conversation: Conversation): Promise<number> {
    return (await this.latestInput(conversation)).seq;
  }

  /** The latest owner input that a discussion would answer, and whether an Agent already answered it directly. */
  private async latestInput(conversation: Conversation): Promise<{seq: number; answered: boolean}> {
    const humans=await humanMemberIds(this.deps.store,conversation);
    const messages=await this.deps.store.listMessages(conversation.conversationId,{limit:1000});
    const seq=messages.filter(m=>isHumanInput(m,humans) && !m.mentions?.length && (m.type==="USER" || /^(?:(?:任务|会话)指示已更新。|(?:Task|Conversation) instructions updated\.)/.test(m.content))).at(-1)?.seq ?? 0;
    return {seq,answered:seq>0 && inputAnswered(messages,seq)};
  }

  private async loop(conversationId: string, active: ()=>boolean): Promise<void> {
    while (active()) {
      let conversation=await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.paused || conversation.status!=="ACTIVE") return;
      const agents: UserRef[]=[];
      for (const member of conversation.members) {
        const user=await this.deps.store.getUser(member.userId);
        if (user?.isAgent && !member.paused && member.role!=="OBSERVER") agents.push(user);
      }
      const leader=agents.find(a=>conversation!.members.some(m=>m.userId===a.userId && m.role==="LEADER"));
      // A Leader hosted on another computer is coordinated there: that computer receives the same input.
      // Writing shared discussion state here would mark the Leader unavailable and stall its own computer.
      if (leader?.remote) return;
      const input=await this.latestInput(conversation);
      const inputSeq=input.seq;
      // Starting or reviving a discussion for input an Agent already answered would make the team
      // reply to a finished topic (for example when a Leader comes back online days later).
      if (input.answered && (!conversation.brainstorm || conversation.brainstorm.phase==="waiting")) {
        if (conversation.brainstorm) {
          await this.deps.store.updateConversation(conversationId,{brainstorm:{...conversation.brainstorm,phase:"ready",reason:undefined}});
          await this.deps.log("brainstorm-stale-dropped",{conversation:conversationId,inputSeq,revision:conversation.brainstorm.revision});
        }
        return;
      }
      if (!conversation.brainstorm) {
        if (agents.length<=1) return;
        conversation=await this.deps.store.updateConversation(conversationId,{brainstorm:{phase:"ideas",revision:1,round:1,probes:0,attempts:0,leaderId:leader?.userId ?? "",inputSeq,participants:agents.filter(a=>this.deps.ready(a)).map(a=>a.userId),responses:{},turnDurationsMs:{},evidenceReady:false}});
      }
      let state=conversation.brainstorm!;
      if (state.phase==="ready") return;
      if (!leader || !this.deps.ready(leader)) {
        if (state.phase!=="waiting" || !leaderUnavailable(state.reason)) await this.save(conversation,{phase:"waiting",reason:p(LEADER_UNAVAILABLE_ZH, LEADER_UNAVAILABLE_EN)});
        return;
      }
      // Waiting only because the Leader was unavailable: resume once it is ready, without requiring new input.
      const recovered=state.phase==="waiting" && leaderUnavailable(state.reason);
      if (inputSeq>state.inputSeq || leader.userId!==state.leaderId || recovered) {
        const fresh=inputSeq>state.inputSeq || leader.userId!==state.leaderId;
        conversation=await this.save(conversation,{phase:"ideas",revision:state.revision+1,round:1,probes:0,attempts:0,leaderId:leader.userId,inputSeq,participants:agents.filter(a=>this.deps.ready(a)).map(a=>a.userId),responses:{},turnDurationsMs:{},evidenceReady:false,confirmedParticipants:[],lastRevisionReason:undefined,stalledRevisions:0,reason:fresh ? p("结合主人最新输入并行更新独立视角；保留已发表的观点，不重复无变化内容。", "Update independent perspectives in parallel based on the task owner's latest input; keep views already expressed and don't repeat unchanged content.") : undefined});
        state=conversation.brainstorm!;
      }
      if (state.phase==="waiting") return;
      const team=agents.filter(a=>this.deps.ready(a));
      const peers=team.filter(a=>a.userId!==leader.userId);
      const missing=state.participants.filter(id=>!team.some(a=>a.userId===id));
      const parallel=state.phase==="ideas" || state.phase==="review";
      const targets=state.phase==="ideas" ? team : parallel ? peers : [leader];
      let writes=Promise.resolve();
      await Promise.all(targets.filter(a=>!state.responses[a.userId]).map(async agent=> {
        let result: BrainstormState["responses"][string];
        try { result=await this.deps.run(conversation!,agent); }
        catch(error) { result={ok:false,reason:String(error)}; }
        if (!active()) return;
        writes=writes.then(async()=> {
          const fresh=await this.deps.store.getConversation(conversationId);
          if (!fresh?.brainstorm || fresh.brainstorm.revision!==state.revision || fresh.brainstorm.phase!==state.phase) return;
          const durations={...(fresh.brainstorm.turnDurationsMs??{})};
          if(result.durationMs!==undefined)durations[agent.userId]=[...(durations[agent.userId]??[]),result.durationMs].slice(-4);
          await this.deps.store.updateConversation(conversationId,{brainstorm:{...fresh.brainstorm,responses:{...fresh.brainstorm.responses,[agent.userId]:result},turnDurationsMs:durations}});
        });
        await writes;
      }));
      await writes;
      if (!active()) return;
      conversation=await this.deps.store.getConversation(conversationId);
      if (!conversation?.brainstorm) return;
      state=conversation.brainstorm;
      if (await this.inputSeq(conversation)>state.inputSeq || !conversation.members.some(m=>m.userId===state.leaderId && m.role==="LEADER")) continue;
      const failed=Object.entries(state.responses).filter(([,r])=>!r.ok).map(([id,r])=>p(`${id}：${r.reason ?? "无有效意见"}`, `${id}: ${r.reason ?? "no useful input"}`));
      const omissions=[...missing.map(id=>p(`${id}：当前不可用/已移出`, `${id}: currently unavailable/removed`)),...failed];
      let caveat=omissions.length ? p(`以下成员未提供有效意见，不能当作同意：${omissions.join("；")}`, `The following members gave no useful input, which can't be treated as agreement: ${omissions.join("; ")}`) : undefined;
      const response=state.responses[leader.userId];
      const move=async(phase: BrainstormState["phase"],extra:Partial<BrainstormState>={})=>this.save(conversation!,{phase,responses:{},attempts:0,revision:state.revision+1,reason:caveat,...extra});
      if (!parallel && !response?.ok) {
        if (state.phase==="probe") {
          // A bounded probe is evidence gathering, not a blind retry loop. Its
          // partial tool evidence is already durable in chat. Let synthesis use
          // that evidence and request a narrower second probe only if the method
          // genuinely still cannot be chosen.
          await move(state.afterProbe ?? "synthesize",{reason:p(`有限验证未形成最终答复，已保留本轮过程证据且不原样重跑。综合现有证据继续收敛；仍缺少会改变方法的事实时，说明差异后再申请更窄的验证。${response?.reason ?? ""}`, `The bounded verification didn't produce a final reply; this turn's process evidence is kept and it won't be rerun as-is. Keep converging with the existing evidence; if facts that would change the method are still missing, explain the difference and then request a narrower verification. ${response?.reason ?? ""}`)});
          continue;
        }
        const attempts=state.attempts+1;
        await this.save(conversation,{phase:attempts<3 ? state.phase : "waiting",attempts,responses:{},reason:p(`Leader讨论回复失败（${attempts}/3），尚未形成可执行方案。${response?.reason ?? ""}`, `The Leader's discussion reply failed (${attempts}/3); no executable plan has been formed yet. ${response?.reason ?? ""}`)});
        if (attempts>=3) return;
        continue;
      }
      const control=response?.control;
      if(control?.action==="plan" && control.work?.length){
        const normalized=await normalizeWorkCandidates(this.deps.store,conversation,control.work);
        if(JSON.stringify(normalized)!==JSON.stringify(control.work))await this.deps.log("brainstorm-plan-candidates-normalized",{conversation:conversationId});
        control.work=normalized;
      }
      if(state.phase==="ideas" && control?.action==="brainstorm"){
        if(control.decision==="ask"){
          await move("waiting",{evidenceReady:!!response?.ok,reason:control.reason});
          return;
        }
        if(control.decision==="probe" && state.probes<2){
          await move("probe",{probes:state.probes+1,afterProbe:"synthesize",evidenceReady:!!response?.ok,reason:control.reason});
          continue;
        }
      }
      if(state.phase==="ideas" && control?.action==="plan" && control.work?.length && peers.every(peer=>!state.responses[peer.userId]?.ok)){
        const leaderMissing=control.work.length>1 && !control.work.some(work=>work.candidates.includes(leader.userId));
        const failedPeerIds=new Set(peers.filter(peer=>!state.responses[peer.userId]?.ok).map(peer=>peer.userId));
        const requiredIds=new Set(control.work.flatMap(work=>work.dependsOn));
        const failedPeerPrerequisites=control.work.filter(work=>requiredIds.has(work.id) && work.candidates.every(id=>failedPeerIds.has(id)));
        if(!leaderMissing && !failedPeerPrerequisites.length){
          await this.deps.log("brainstorm-draft-plan-promoted",{conversation:conversationId,reason:caveat,work:control.work.map(work=>work.id)});
          conversation=await move("ready",{evidenceReady:true,reason:caveat});
          const current=await this.deps.store.getConversation(conversationId);
          if(!current)return;
          if(await this.inputSeq(current)>state.inputSeq || !current.members.some(m=>m.userId===state.leaderId && m.role==="LEADER")){
            await this.save(current,{phase:"ideas",revision:state.revision+2,responses:{},reason:p("最终确认期间收到新的输入或Leader变化，重新并行核对方案。", "New input or a Leader change arrived during final confirmation; re-checking the plan in parallel.")});
            continue;
          }
          if(active())await this.deps.proceed(conversation,control);
          return;
        }
        if(leaderMissing)await this.deps.log("brainstorm-plan-leader-missing",{conversation:conversationId,leader:leader.userId,candidates:control.work.map(work=>({id:work.id,candidates:work.candidates}))});
        if(failedPeerPrerequisites.length){
          const ids=failedPeerPrerequisites.map(work=>work.id).join("、");
          caveat=p(`${caveat ? `${caveat}。` : ""}待定计划中的 ${ids} 仅由本轮无有效意见的成员承担，却是其他工作的前置依赖；不可直接采用。请只做紧凑重排：Leader或已响应成员守住关键路径，无响应成员仅承担不阻塞的清单、边界或独立复核。`, `${caveat ? `${caveat}. ` : ""}In the tentative plan, ${ids} are taken on only by members who gave no useful input this turn, yet they are prerequisites for other work; the plan can't be adopted as-is. Just rearrange it compactly: the Leader or members who responded hold the critical path, and members who didn't respond only take on non-blocking lists, edge work or independent reviews.`);
          await this.deps.log("brainstorm-draft-plan-critical-peer-unresponsive",{conversation:conversationId,work:failedPeerPrerequisites.map(work=>work.id)});
        }
      }
      if (!parallel && control?.action==="brainstorm") {
        if (control.decision==="ask") { await move("waiting",{reason:control.reason}); return; }
        if (control.decision==="probe" && state.phase!=="probe" && state.probes<2) { await move("probe",{probes:state.probes+1,afterProbe:state.phase==="frame" ? "ideas" : "synthesize",reason:control.reason}); continue; }
        if (control.decision==="revise" && ["synthesize","decide"].includes(state.phase)) {
          const reason=control.reason!.trim().replace(/\s+/g," ");
          const stalled=reason===state.lastRevisionReason ? (state.stalledRevisions??0)+1 : 0;
          if (stalled>=2) {
            await move("waiting",{reason:p(`讨论连续重复同一修订理由，尚未出现可改变方案的新问题或证据：${reason}`, `The discussion keeps repeating the same revision reason, with no new question or evidence that could change the plan: ${reason}`),lastRevisionReason:reason,stalledRevisions:stalled});
            return;
          }
          // The normal path needs only three steps: the Leader defines the problem, members give input, and the Leader converges.
          // Only when the Leader points out a new substantive disagreement do members review and move to the next round of decision.
          await move("review",{round:state.round+1,reason:control.reason,lastRevisionReason:reason,stalledRevisions:stalled,confirmedParticipants:[]});
          continue;
        }
      }
      if (state.phase==="synthesize" || state.phase==="decide") {
        if (control?.action==="plan" && control.work!.length>1 && !control.work!.some(work=>work.candidates.includes(leader.userId))) {
          const attempts=state.attempts+1;
          await this.deps.log("brainstorm-plan-leader-missing",{conversation:conversationId,leader:leader.userId,candidates:control.work!.map(work=>({id:work.id,candidates:work.candidates}))});
          await this.save(conversation,{phase:attempts<3 ? state.phase : "waiting",attempts,responses:{},reason:attempts<3
            ? p("最终计划包含多项工作，却没有登记Leader承担任何实质工作。请一次补齐当前阶段计划：Leader守住适合自己的关键制作或独立核验，其他成员并行承担不阻塞关键路径的工作；不要进入执行后再补派。", "The final plan contains several work items but doesn't register any substantive work for the Leader. Complete the current stage's plan in one go: the Leader holds critical production or independent verification suited to them, and other members work in parallel on things that don't block the critical path; don't add assignments after execution starts.")
            : p("Leader连续三次提交多项计划但未承担任何实质工作，尚未形成有效的多Agent协作方案。", "The Leader submitted a multi-item plan three times in a row without taking on any substantive work; no valid multi-Agent collaboration plan has been formed.")});
          if(attempts>=3)return;
          continue;
        }
        if (control?.action==="plan" || control?.action==="organize" || control?.action==="stop") {
          conversation=await move("ready",{reason:control.reason});
          const current=await this.deps.store.getConversation(conversationId);
          if (!current) return;
          if (await this.inputSeq(current)>state.inputSeq || !current.members.some(m=>m.userId===state.leaderId && m.role==="LEADER")) {
            await this.save(current,{phase:"ideas",revision:state.revision+2,responses:{},reason:p("最终确认期间收到新的输入或Leader变化，重新并行核对方案。", "New input or a Leader change arrived during final confirmation; re-checking the plan in parallel.")});
            continue;
          }
          if (active()) await this.deps.proceed(conversation,control);
          return;
        }
        const attempts=state.attempts+1;
        await this.save(conversation,{phase:attempts<3 ? state.phase : "waiting",attempts,responses:{},reason:attempts<3 ? p(`尚未收到明确阶段决定。${response?.reason ? `协议诊断：${response.reason}。` : ""}请用紧凑且完整的control进入下一阶段，或指出会改变方法的具体分歧；不要重新长篇复述。`, `No clear stage decision has been received yet. ${response?.reason ? `Protocol diagnostics: ${response.reason}. ` : ""}Use a compact and complete control to move to the next stage, or point out the specific disagreement that would change the method; don't restate everything at length again.`) : p("Leader连续三次未给出明确阶段决定，讨论未完成，等待补充信息或重试。", "The Leader gave no clear stage decision three times in a row; the discussion isn't finished and is waiting for more information or a retry.")});
        if (attempts>=3) return;
        continue;
      }
      const next: Partial<Record<BrainstormState["phase"],BrainstormState["phase"]>>={frame:"ideas",ideas:"synthesize",review:"decide",probe:state.afterProbe ?? "synthesize"};
      const confirmed=state.phase==="review" ? Object.entries(state.responses)
        .filter(([,result])=>result.ok && result.control?.action==="brainstorm" && result.control.decision==="agree")
        .map(([id])=>id) : state.confirmedParticipants;
      await move(next[state.phase]!,{confirmedParticipants:confirmed,evidenceReady:state.phase==="ideas" ? !!state.responses[leader.userId]?.ok : state.evidenceReady});
    }
  }
}
