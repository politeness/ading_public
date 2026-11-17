import { bestEffortSync } from "../knowledge/sync-failure";
import type { AgentRegistry } from "../agents/registry";
import type { WorkspaceResolution } from "../orchestration/workspace";
import type { Store } from "../store/store";
import type { SkillSyncer } from "./sync";
import { p } from "../prompt-language";

/**
 * Post-turn capture: skills go through peer review, facts go straight into the store.
 *
 * The two get different levels of scrutiny because **the cost of being wrong differs**:
 *   A skill is "always do it this way from now on" — a wrong one keeps affecting all future work, so other eyes must check it
 *   A fact is "this project works like this" — verifiable, affects only this workspace, obviously wrong at a glance, and a person can just delete it
 * Putting facts through a voting process would cost far more than it gains.
 *
 * Key design: **the review happens in the group as real messages, not through a hidden channel.**
 *
 * First, the summary is itself part of the conversation — an agent that just ran 20 rounds of debugging
 *   has all its context in its own thread; asking in a clean thread throws all of that away;
 *   continuing the original thread with exec resume is actually cheaper, needing just one new message.
 * Second, reviewers need project context to judge "is this rule right".
 * Third, people can see the whole discussion — which is how this product is meant to look anyway.
 *
 * Cost: reviews stay permanently in each agent's thread and accumulate.
 * This is offset by keeping frequency low with a threshold (≥10 iterations + side effects).
 */
export const DEFAULT_THRESHOLD: CaptureThreshold = {
  minIterations: 10,
  requireSideEffects: true
};

export interface CaptureContext {
  conversation: Conversation;
  agent: UserRef;
  /**
   * The workspace scope resolved for this conversation.
   *
   * Only conversations with sharesKnowledge true reach automatic capture — the caller in
   * main.ts already filters out "Scratch" conversations: what's learned there has no anchor to attach to,
   * and forcing it into a global skill would let a one-off experience affect all future work.
   */
  resolution: WorkspaceResolution;
  evidenceFromSeq: number;
  evidenceToSeq: number;
  steps: string[];
  metrics: TurnMetrics;
}

/** Provided by main: have an agent in the conversation say something continuing its own thread */
export interface CaptureDeps {
  /** After central writes, attempt native synchronization without blocking normal work. */
  afterKnowledgeSaved?():Promise<void>;
  runInConversation(
    conversation: Conversation,
    agent: UserRef,
    prompt: string
  ): Promise<AgentTurnOutcome>;
  /** Post content into the group as a real message */
  post(
    conversationId: string,
    senderId: string,
    content: string,
    type?: MessageType
  ): Promise<Message>;
  resolveDiscovered(userId: string): DiscoveredAgent | undefined;
}

interface DraftProposal {
  name: string;
  description: string;
  content: string;
}

/** The two things asked of an agent after a turn: one skill to review, and some facts to store directly */
interface TurnHarvest {
  skill: DraftProposal | null;
  facts: string[];
}

interface Critique {
  problems: string[];
  suggestion?: string;
}

export class SkillCapture {
  constructor(
    private readonly store: Store,
    private readonly registry: AgentRegistry,
    private readonly syncer: SkillSyncer,
    private readonly deps: CaptureDeps,
    private readonly threshold: CaptureThreshold = DEFAULT_THRESHOLD
  ) {}

  meetsThreshold(metrics: TurnMetrics): boolean {
    if (metrics.iterations < this.threshold.minIterations) return false;
    if (this.threshold.requireSideEffects && !metrics.sideEffects) return false;
    return true;
  }

  /** Called after a turn. Bothers nobody at all if the threshold isn't met */
  async afterTurn(context: CaptureContext): Promise<void> {
    if (!this.meetsThreshold(context.metrics)) return;

    const harvest = await this.askForHarvest(context);
    if (!harvest) return;

    // Facts **skip peer review**; the agent writes them directly.
    //
    // A skill is "always do it this way" — a wrong one keeps affecting all future work, so it needs other eyes.
    // A fact is "this project works like this" — verifiable, scoped to this workspace, obviously wrong at a glance;
    // having three agents queue up to vote on "payment callbacks go through RocketMQ" costs far more than it gains.
    // The safety net is people: facts are listed one by one on the Knowledge page and can be deleted anytime.
    await this.recordFacts(context, harvest.facts);

    const draft = harvest.skill;
    if (!draft) return;

    const existing = (await this.store.listSkills([{ scope: "workspace", ownerId: context.resolution.knowledgeOwnerId }])).find(
      (skill) => skill.scope === "workspace" && skill.ownerId === context.resolution.knowledgeOwnerId && skill.name.trim() === draft.name.trim()
    );
    // Principle: auto-created skills may be auto-updated; human-created ones need a human to start an update.
    // The agent's observation isn't lost — it's still recorded as a proposal, just skipping peer review and going to the human queue.
    const humanOwned = existing?.authorKind === "human";

    const proposal = await this.store.createProposal({
      kind: existing ? "update" : "create",
      targetSkillId: existing?.skillId,
      proposerUserId: context.agent.userId,
      conversationId: context.conversation.conversationId,
      name: draft.name,
      description: draft.description,
      scope: "workspace",
      ownerId: context.resolution.knowledgeOwnerId,
      content: draft.content,
      evidenceFromSeq: context.evidenceFromSeq,
      evidenceToSeq: context.evidenceToSeq,
      evidenceSteps: context.steps,
      state: humanOwned ? "needs_human" : "reviewing",
      blockedReason: humanOwned
        ? p("这条技能是人写的，按规则只能由人发起更新", "This skill was written by a person, so by the rules only a person can start an update")
        : undefined
    });

    // Post the proposal itself as a group message so everyone (including you) can see it
    await this.deps.post(
      context.conversation.conversationId,
      context.agent.userId,
      [
        p(`【技能提案】${draft.name}`, `[Skill proposal] ${draft.name}`),
        draft.description ? p(`何时使用：${draft.description}`, `When to use: ${draft.description}`) : "",
        "",
        draft.content
      ]
        .filter(Boolean)
        .join("\n"),
      "SKILL"
    );

    if (humanOwned) {
      await this.deps.post(
        context.conversation.conversationId,
        context.agent.userId,
        p(`「${draft.name}」是你写的技能，按规则要由你来决定改不改。`, `"${draft.name}" is a skill you wrote, so by the rules it's up to you whether to change it.`),
        "SYSTEM"
      );
      return;
    }

    await this.runReview(proposal, context);
  }

  // -------------------------------------------------------------------------

  /** Have the proposer self-assess, continuing its own thread, whether this turn has reusable experience */
  private async askForHarvest(
    context: CaptureContext
  ): Promise<TurnHarvest | null> {
    const prompt = [
      p("刚才这一轮干完了，有两样东西要你回头看一眼。", "That round of work just finished; there are two things for you to look back on."),
      "",
      p("**一、值得沉淀成「团队技能」的可复用经验**（会经其他 Agent 复核后进公共库）", "**1. Reusable experience worth turning into a \"team skill\"** (it goes into the shared library after review by other Agents)"),
      p("必须同时满足才提出：", "Only propose it if all of these hold:"),
      p("- 是关于「该怎么做事」的规则，不是这次的具体结论", "- It's a rule about \"how to do things\", not this time's specific conclusion"),
      p("- 换个会话、换个人来做也用得上", "- It would still be useful in another session or for someone else"),
      p("- 有本轮的实际证据支撑，不是推测", "- It's backed by actual evidence from this round, not speculation"),
      p("明确不要提出：例行操作、个人偏好、一次性的临时故障。", "Explicitly don't propose: routine operations, personal preferences, one-off temporary failures."),
      "",
      p("**二、关于这个项目的事实**（直接记下来，以后这个工作区的每个会话都会看到）", "**2. Facts about this project** (recorded directly; every future session in this workspace will see them)"),
      p("只记「换个会话也还成立、而且当时会想知道」的：技术选型、约定、坑、关键位置。", "Only record things that \"still hold in another session and that you'd have wanted to know\": technology choices, conventions, pitfalls, key locations."),
      p("不要记：这次的进度、你做了什么、下一步打算、任何会随时间失效的东西。", "Don't record: this time's progress, what you did, next-step plans, or anything that goes stale over time."),
      p("每条一句话，最多 3 条。没有就给空数组。", "One sentence each, at most 3. If there are none, give an empty array."),
      "",
      p("严格按下面的 JSON 回复，不要有任何别的文字：", "Reply strictly in the JSON below, with no other text:"),
      p('{"skill":{"name":"短名称","description":"一句话说明什么时候该用这条","content":"规则正文，Markdown"},"facts":["…"]}', `{"skill":{"name":"short name","description":"one sentence on when to use it","content":"rule body, Markdown"},"facts":["…"]}`),
      p("技能没有值得提的就把 skill 设成 null。两样都没有就回复：NONE", "If there's no skill worth proposing, set skill to null. If there's neither, reply: NONE")
    ].join("\n");

    const outcome = await this.deps.runInConversation(
      context.conversation,
      context.agent,
      prompt
    );
    if (!outcome.ok) return null;
    const parsed = parseJson<{
      skill?: DraftProposal | null;
      facts?: unknown;
    }>(outcome.message);
    if (!parsed) return null;

    const draft = parsed.skill;
    const skill =
      draft?.name && draft.content
        ? {
            name: draft.name.trim().slice(0, 60),
            description: (draft.description ?? "").trim().slice(0, 200),
            content: draft.content.trim().slice(0, 10_000)
          }
        : null;

    const facts = Array.isArray(parsed.facts)
      ? parsed.facts
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 400))
          .filter(Boolean)
          .slice(0, 3)
      : [];

    return { skill, facts };
  }

  /**
   * Facts go straight into the store, no voting.
   *
   * The only gate is dedup: agents may restate the same thing every turn;
   * without blocking, "this project uses RocketMQ" would pile up twenty copies in memory,
   * and each incremental injection would stuff them all back into the prompt.
   */
  private async recordFacts(
    context: CaptureContext,
    facts: string[]
  ): Promise<void> {
    const ownerId = context.resolution.knowledgeOwnerId;
    if (!ownerId || !facts.length) return;

    const existing = await this.store.listMemories("workspace", ownerId, {
      limit: 500
    });
    const seen = new Set(existing.map((entry) => normalize(entry.content)));

    const written: string[] = [];
    for (const fact of facts) {
      const key = normalize(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.store.appendMemory({
        scope: "workspace",
        ownerId,
        content: fact,
        authorKind: "agent",
        authorUserId: context.agent.userId
      });
      written.push(fact);
    }
    if (!written.length) return;
    await this.deps.afterKnowledgeSaved?.();

    // Announce it in the group. An automatic write people can't see means they have no veto
    await this.deps.post(
      context.conversation.conversationId,
      context.agent.userId,
      p(`记下了${written.length}条关于这个工作区的事实：\n`, `Recorded ${written.length} facts about this workspace:\n`) +
        written.map((fact) => `· ${fact}`).join("\n") +
        p("\n（在「知识」页可以改或删）", "\n(You can edit or delete them on the Knowledge page)"),
      "SYSTEM"
    );
  }


  /** Other agents in the conversation look for problems in the group */
  private async runReview(
    proposal: SkillProposal,
    context: CaptureContext
  ): Promise<void> {
    const reviewers: UserRef[] = [];
    for (const member of context.conversation.members) {
      if (member.userId === proposal.proposerUserId) continue;
      if (member.role === "OBSERVER" || member.paused) continue;
      const user = await this.store.getUser(member.userId);
      if (!user?.isAgent) continue;
      if (!this.deps.resolveDiscovered(user.userId)) continue;
      reviewers.push(user);
    }

    if (reviewers.length === 0) {
      await this.store.setProposalState(
        proposal.proposalId,
        "needs_human",
        p("这个会话里没有其他 Agent 可以复核", "There are no other Agents in this session to review it")
      );
      await this.deps.post(
        proposal.conversationId,
        proposal.proposerUserId,
        p(`群里没有别的 Agent 能复核「${proposal.name}」，需要你来定。`, `There's no other Agent in the group to review "${proposal.name}"; you need to decide.`),
        "SYSTEM"
      );
      return;
    }

    const prompt = this.buildCritiquePrompt(proposal);
    const blockers: string[] = [];
    let unclear = false;

    for (const reviewer of reviewers) {
      const outcome = await this.deps.runInConversation(
        context.conversation,
        reviewer,
        prompt
      );
      const raw = outcome.ok ? outcome.message.trim() : "";

      // Review comments are also posted in the group — they're part of the discussion, not a background vote
      if (raw) {
        await this.deps.post(
          proposal.conversationId,
          reviewer.userId,
          stripTrailingJson(raw),
          "SKILL"
        );
      }

      const critique = parseJson<Critique>(raw);
      let verdict: ReviewVerdict;
      let problems: string[] = [];

      if (!critique || !Array.isArray(critique.problems)) {
        // Unparseable counts as neither approval nor objection — let a person read the original
        verdict = "unclear";
        unclear = true;
      } else {
        problems = critique.problems
          .map((item) => String(item).trim())
          .filter(Boolean)
          .slice(0, 10);
        verdict = problems.length ? "blocked" : "pass";
        if (problems.length) {
          blockers.push(
            `${reviewer.displayName}：${problems.join("；")}` +
              (critique.suggestion ? p(`（建议：${critique.suggestion}）`, ` (suggestion: ${critique.suggestion})`) : "")
          );
        }
      }

      await this.store.recordReview(proposal.proposalId, {
        reviewerUserId: reviewer.userId,
        verdict,
        problems,
        suggestion: critique?.suggestion?.trim().slice(0, 500),
        raw: raw.slice(0, 4000),
        reviewedAt: new Date().toISOString()
      });
    }

    if (blockers.length > 0 || unclear) {
      const reason = blockers.length
        ? blockers.join("\n")
        : p("有复核意见没法解析，请看群里的原文", "Some review comments couldn't be parsed; please see the original text in the group");
      await this.store.setProposalState(proposal.proposalId, "needs_human", reason);
      await this.deps.post(
        proposal.conversationId,
        proposal.proposerUserId,
        p(`「${proposal.name}」有复核意见，等你裁决：\n${reason}`, `"${proposal.name}" has review comments awaiting your decision:\n${reason}`),
        "SYSTEM"
      );
      return;
    }

    await this.applyProposal(proposal, context, reviewers.length);
  }

  /**
   * The review prompt.
   *
   * This is an **analysis task** (finding problems), not a social judgment (do you agree) —
   * the latter triggers agreement bias, the former is what models are good at. An empty problem list means pass;
   * don't presume "reject by default", which would block everything, flood the human queue, and waste the automation.
   */
  private buildCritiquePrompt(proposal: SkillProposal): string {
    return [
      p("刚才群里提了一条要进团队公共技能库的规则。", "A rule was just proposed in the group for the team's shared skill library."),
      p("这个库多个 Agent 共用，一条写错的规则会持续影响所有人的每一次工作，", "This library is shared by multiple Agents; a wrongly written rule will keep affecting everyone's work every time,"),
      p("所以请认真挑毛病。", "so please look hard for problems."),
      "",
      p("【提案】", "[Proposal]"),
      p(`名称：${proposal.name}`, `Name: ${proposal.name}`),
      p(`何时使用：${proposal.description}`, `When to use: ${proposal.description}`),
      p("正文：", "Body:"),
      proposal.content,
      "",
      p("请从这几个角度找问题：", "Please look for problems from these angles:"),
      p("- 过度泛化：它把一个特例当成普遍规则了吗？", "- Overgeneralization: does it treat a special case as a general rule?"),
      p("- 缺前提：它成立需要什么条件？这些条件写清楚了吗？", "- Missing preconditions: what conditions does it need to hold? Are they written clearly?"),
      p("- 事实冲突：和你了解的情况有矛盾吗？", "- Factual conflict: does it contradict what you know?"),
      p("- 表述含糊：会不会被后来的人误用？", "- Vague wording: could people later misapply it?"),
      p("- 已有重复：和现有技能重复或打架吗？", "- Duplication: does it duplicate or conflict with existing skills?"),
      "",
      p("先用一两句话说说你的看法，然后**最后一行**严格按这个 JSON 输出，不要有别的：", "First give your view in a sentence or two, then output strictly this JSON on the **last line**, with nothing else:"),
      p('{"problems":["问题1","问题2"],"suggestion":"如果只是表述问题，给出你建议的改法（可选）"}', `{"problems":["problem 1","problem 2"],"suggestion":"if it's only a wording problem, give your suggested rewrite (optional)"}`),
      "",
      p("problems 为空数组表示你认为可以收录。确实没问题就给空数组，不用硬找。", "An empty problems array means you think it can be included. If there's really no problem, give an empty array; don't force yourself to find one.")
    ].join("\n");
  }

  private async applyProposal(
    proposal: SkillProposal,
    context: CaptureContext,
    reviewerCount: number
  ): Promise<void> {
    if (proposal.kind === "update" && proposal.targetSkillId) {
      const target = await this.store.getSkill(proposal.targetSkillId);
      if (!target || target.scope !== proposal.scope || target.ownerId !== proposal.ownerId || target.name.trim() !== proposal.name.trim()) {
        await this.store.setProposalState(proposal.proposalId, "needs_human", p("技能归属已变化", "The skill's ownership has changed"));
        return;
      }
      await this.store.updateSkill(proposal.targetSkillId, {
        description: proposal.description,
        content: proposal.content
      });
    } else {
      await this.store.createSkill({
        name: proposal.name,
        description: proposal.description,
        scope: proposal.scope,
        ownerId: proposal.ownerId,
        content: proposal.content,
        authorKind: "agent",
        authorUserId: proposal.proposerUserId,
        targets: proposal.targets
      });
    }
    await this.store.setProposalState(proposal.proposalId, "applied");

    this.syncer.invalidate();
    if(this.deps.afterKnowledgeSaved)await this.deps.afterKnowledgeSaved();
    else {
      const kinds = uniqueKinds(context.conversation, this.deps.resolveDiscovered);
      await bestEffortSync(()=>this.syncer.ensureSynced(context.resolution, kinds),[]);
    }

    await this.deps.post(
      proposal.conversationId,
      proposal.proposerUserId,
      p(`技能「${proposal.name}」已收录进公共库（${reviewerCount} 位 Agent 复核无异议）。`, `The skill "${proposal.name}" has been added to the shared library (${reviewerCount} Agents reviewed it with no objections).`),
      "SYSTEM"
    );
  }
}

/** For dedup: ignore whitespace and punctuation differences so the same thing reworded isn't stored again */
function normalize(text: string): string {
  return text.replace(/[\s，。、；：!！?？.,;:]/g, "").toLowerCase();
}

function uniqueKinds(
  conversation: Conversation,
  resolve: (userId: string) => DiscoveredAgent | undefined
): AgentKind[] {
  const kinds = new Set<AgentKind>();
  for (const member of conversation.members) {
    const discovered = resolve(member.userId);
    if (discovered) kinds.add(discovered.kind);
  }
  return [...kinds];
}

/** When posting review comments to the group, strip the trailing machine-readable JSON so it reads cleanly */
export function stripTrailingJson(raw: string): string {
  const withoutFence = raw.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/, "").trim();
  if (withoutFence !== raw.trim()) return withoutFence || raw.trim();
  const start = raw.lastIndexOf("{");
  if (start <= 0) return raw.trim();
  const tail = raw.slice(start);
  if (tail.includes('"problems"')) return raw.slice(0, start).trim() || raw.trim();
  return raw.trim();
}

/** Agents often wrap JSON in explanations or code fences; extract it as best we can */
export function parseJson<T>(raw: string): T | null {
  const text = raw.trim();
  if (!text || text.toUpperCase().startsWith("NONE")) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
