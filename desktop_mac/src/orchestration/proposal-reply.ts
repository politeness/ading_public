import { parseLeaderControl } from "./control";

export interface ProposalReply {
  action: "accept" | "revise" | "clarify";
  source: "control" | "language" | "discussion";
  visible: string;
}

/** Only interprets a reply to the speaker's current proposal, never a result or permission grant. */
export function interpretProposalReply(reply: string, assignmentId: string): ProposalReply {
  let parsed = parseLeaderControl(reply);
  // Providers may put the optional control before prose, or in a fenced block in the middle.
  if (!parsed.control) {
    const candidates = [...reply.matchAll(/```(?:json)?\s*[\s\S]*?```|^\s*\{[^\n]+\}\s*$/gm)]
      .map(match => ({ match, parsed: parseLeaderControl(match[0]) })).filter(c => c.parsed.control);
    if (candidates.length > 1) return { action: "clarify", source: "control", visible: reply.trim() };
    if (candidates.length === 1) {
      const c = candidates[0];
      parsed = { control: c.parsed.control, visible: (reply.slice(0,c.match.index) + reply.slice(c.match.index! + c.match[0].length)).trim() };
    }
  }
  const visible = parsed.visible.trim();
  if (parsed.control) {
    const c = parsed.control;
    if (c.assignmentId === assignmentId && (c.action === "accept" || c.action === "revise")) {
      return { action: c.action, source: "control", visible: visible || c.reason || "" };
    }
    // A stale id or different control must not be repaired by guessing which work it means.
    return { action: "clarify", source: "control", visible: reply.trim() };
  }
  // Common provider variants remain scoped to the exact current assignment.
  const loose = reply.match(/control\s*:?\s*\{\s*"action"\s*:\s*"(accept|revise)"\s*,\s*"assignmentId"\s*:\s*"([^"\n]+)"\s*\}/i)
    ?? reply.match(/control\s+action=(accept|revise)\s*,\s*assignmentId=([\w-]+)/i);
  if (loose) {
    if (loose[2] !== assignmentId) return {action:"clarify",source:"control",visible:reply.trim()};
    return {action:loose[1].toLowerCase() as "accept"|"revise",source:"control",visible:reply.replace(loose[0], "").trim()};
  }
  if (/"assignmentId"\s*:/.test(reply)) return { action: "clarify", source: "control", visible: reply.trim() };
  // Tool-looking text is discussion only: never execute XML, JSON or quoted commands.
  const prose = visible.replace(/```[\s\S]*?```/g, "").replace(/<[^>]+>[\s\S]*$/g, "").trim();
  const uncertain = /不[能会要行]|不(?:同意|接受)|无法|不能|做不到|拒绝|暂不|尚未|先确认|等待|等(?:你|您|负责人|leader).{0,20}(?:确认|批准|授权|回复)|确认.{0,16}(?:再|后)|再决定|需要.{0,20}(?:确认|澄清|权限|帮助)|建议|但是|不过|但|如果|是否|能否|[?？]|\b(?:cannot|can't|unable|not|but|if|before|clarif\w*|unsure)\b/i;
  const affirmative = /同意(?:此|本)?分工|直接执行|方案同意|确认接受(?:分工)?|(?:^|[。！\n，,：:]\s*)(?:没问题|可以[，。！]|同意|接受|确认接单|我(?:同意|接受|来负责|来处理|会按|将按)|按.{0,12}(?:执行|处理|开始))|^(?:好的|好|可以)[。！.!]?\s*$|\b(?:I accept|I agree|accepted|agreed|sounds good|looks good|confirmed|will proceed|happy to proceed|ready to (?:start|proceed|execute)|I(?:'ll| will) (?:handle|take|proceed|start))\b/i;
  // An agreed verification target ("核实第8题是否完整") or a promise to
  // report future difficulties is not an objection to accepting the work.
  // Keep actual questions, conditions, and inability statements intact.
  const acceptanceProse = prose
    .replace(/(?:无法|不能)(?:确定|辨认|识别)时[^。；\n]{0,60}(?:保留未定结论|标注|报告|说明|不猜补)/g, "按约定报告不确定性")
    .replace(/确认后(?:可安排|准备|进入|开始)执行(?:轮)?|等待执行轮/g, "进入执行轮")
    .replace(/没有(?:任何)?(?:疑问|问题|冲突)|无(?:疑问|问题|冲突)|不(?:涉及|存在|会产生)[^，。；\n]{0,30}冲突/g, "范围明确")
    .replace(/(?:题号|原文|内容)[^，。；\n]{0,20}(?:模糊|不可辨认)时[^。；\n]{0,60}(?:不推断|不猜测|不猜补)/g, "按约定标注不确定内容")
    // Similar phrasings under the English UI: promising to report problems truthfully, or declaring no questions, are not reservations about accepting the assignment
    .replace(/\b(?:if|when)\b[^.;\n]{0,80}\bI(?:'ll| will) (?:report|flag|note|mark)\b[^.;\n]{0,60}/gi, "遇到问题会如实报告")
    .replace(/\b(?:I(?:'ll| will) (?:report|flag|note|mark))\b[^.;\n]{0,60}\b(?:if|when)\b[^.;\n]{0,80}/gi, "遇到问题会如实报告")
    .replace(/\bno (?:questions|concerns|conflicts?|issues)\b/gi, "范围明确")
    .split(/([，,。；;\n：:])/).map(clause => {
    // A decision inside the agreed work is not a decision whether to accept it.
    // Keep acceptance, authorization, external prerequisites and real questions ambiguous.
    if (/^(?:我(?:会|将))?先(?:核实|核查|检查|测量)[^?？]{1,60}再决定是否(?:需要)?(?:清除|裁剪|裁边|测量|保留|标注|修复)[^?？]{0,20}$/.test(clause.trim()) &&
        !/请|等待|权限|批准|授权|帮助|接受|接单|同意|执行|开始|才能|不能|无法/.test(clause)) return "按检查结果选择具体处理步骤";
    if (/^(?:我(?:会|将))?(?:重点)?(?:核实|核查|检查|辨认|判断)[^?？]{1,60}是否[^?？]{1,60}$/.test(clause.trim()) &&
        !/请|需要|等待|再决定|才能|权限/.test(clause)) return clause.replace(/是否/g, "");
    if (/^(?:若|如)?遇到[^?？]{1,60}(?:会|将)(?:如实|明确)?(?:报告|说明|指出)[^?？]{0,20}$/.test(clause.trim()) &&
        !/请|需要|帮助|权限|建议|再执行|再决定|才能|不同意|不接受|不执行|暂停|等你/.test(clause)) return "遇到问题会如实报告";
    return clause;
  }).join("");
  if (prose && !uncertain.test(acceptanceProse) && affirmative.test(prose)) return { action: "accept", source: "language", visible };
  // Meaningful questions/objections go to the leader intact; not a protocol failure or proof of incapability.
  if (prose && !/^(?:skip[.!]?|ok[.!]?)$/i.test(prose)) return { action: "revise", source: "discussion", visible };
  return { action: "clarify", source: "discussion", visible };
}
