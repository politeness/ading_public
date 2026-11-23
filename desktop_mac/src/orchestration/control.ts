/**
 * Parses the control block the LEADER appends to the end of a reply.
 *
 * Extracted separately because this part is the easiest to get wrong: task descriptions containing braces, agents wrapping it in code fences,
 * the word "control" happening to appear in the preceding text — each can make a sloppy regex match the wrong thing.
 * So instead of using a regex to "frame" it, we do bracket matching backwards from the end.
 */
export interface ParsedControl {
  /** The text actually posted to the group after removing the control block */
  visible: string;
  control?: LeaderControl;
}

export type ControlProtocolIssue = "incomplete" | "invalid-json" | "invalid-plan-id" | "invalid-fields";

/** Explain why an explicit control-looking reply was not accepted. This is
 * diagnostic only: malformed or truncated plans are never repaired/executed. */
export function controlProtocolIssue(reply: string): ControlProtocolIssue | undefined {
  const text=reply.trim().replace(/^```(?:json)?\s*/i,"");
  const match=text.match(/\{\s*"control"\s*:/);
  if(!match)return undefined;
  const start=match.index!;
  const end=findBalancedObjectEnd(text,start);
  if(end<0)return "incomplete";
  let parsed:{control?:unknown};
  try{parsed=JSON.parse(text.slice(start,end+1)) as {control?:unknown};}
  catch{return "invalid-json";}
  const raw=parsed.control as Record<string,unknown>|undefined;
  if(raw?.action==="plan" && Array.isArray(raw.work) && raw.work.some(item=>{
    const id=(item as Record<string,unknown>|null)?.id;
    return typeof id!=="string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id);
  }))return "invalid-plan-id";
  return normalize(parsed.control) ? undefined : "invalid-fields";
}

const ACTIONS: LeaderAction[] = ["interrupt", "brainstorm", "batch", "plan", "review", "organize", "stop", "assign", "refocus", "accept", "revise", "blocked"];

export function parseLeaderControl(reply: string): ParsedControl {
  const text = reply.trim();
  if (!text) return { visible: text };

  // Long provider replies are sometimes cut off after they have already
  // emitted a complete decision.  Accept a complete control object at the
  // beginning as well as the traditional object at the end, so prompts can
  // put the non-negotiable machine decision before expendable prose.
  const leading = parseLeadingControl(text);
  if (leading) return leading;

  // Strip a possible code fence first
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```\s*$/);
  const tail = fence ? fence[1].trim() : text;
  const bodyBeforeFence = fence ? text.slice(0, fence.index).trim() : null;

  const start = findLastBalancedObject(tail);
  if (start < 0) return repairBlockedTail(text, tail, bodyBeforeFence);

  const candidate = tail.slice(start);
  let parsed: { control?: unknown };
  try {
    parsed = JSON.parse(candidate) as { control?: unknown };
  } catch {
    return repairBlockedTail(text, tail, bodyBeforeFence);
  }

  const control = normalize(parsed.control);
  if (!control) return repairBlockedTail(text, tail, bodyBeforeFence);

  const visible =
    bodyBeforeFence !== null
      ? bodyBeforeFence
      : tail.slice(0, start).trim();
  // When only a control block is attached with no human-readable text, don't send an empty message
  return { visible, control };
}

function parseLeadingControl(text: string): ParsedControl | undefined {
  const fenced = text.match(/^```(?:json)?\s*\n?/i);
  const offset = fenced?.[0].length ?? 0;
  if (text.slice(offset).trimStart()[0] !== "{") return undefined;
  const whitespace = text.slice(offset).length - text.slice(offset).trimStart().length;
  const start = offset + whitespace;
  const end = findBalancedObjectEnd(text,start);
  if (end < 0) return undefined;
  try {
    const parsed=JSON.parse(text.slice(start,end+1)) as {control?:unknown};
    const control=normalize(parsed.control);
    if (!control) return undefined;
    let after=end+1;
    if (fenced) {
      const close=text.slice(after).match(/^\s*```/);
      if (!close) return undefined;
      after+=close[0].length;
    }
    // Some providers append one extra closing brace after an otherwise complete
    // leading control object. It is protocol debris, not user-facing prose.
    const visible=text.slice(after).trimStart().replace(/^(?:}\s*(?:\r?\n|$))+/,"").trim();
    return {control,visible};
  } catch { return undefined; }
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth=0,inString=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const ch=text[i];
    if(inString){
      if(escaped)escaped=false;
      else if(ch==="\\")escaped=true;
      else if(ch==='"')inString=false;
      continue;
    }
    if(ch==='"')inString=true;
    else if(ch==="{")depth++;
    else if(ch==="}" && --depth===0)return i;
  }
  return -1;
}

/** Only repair missing closing braces of an explicit, complete blocked receipt.
 * Never invent fields/strings or repair actions that execute, approve or stop work. */
function repairBlockedTail(text: string, tail: string, before: string | null): ParsedControl {
  const matches = [...tail.matchAll(/(?:^|\n)\s*(\{\s*"control"\s*:\s*\{)/g)];
  const match = matches.at(-1);
  if (!match) return { visible: text };
  const start = match.index! + match[0].indexOf("{");
  const candidate = tail.slice(start).trim();
  let depth = 0, quoted = false, escaped = false;
  for (const ch of candidate) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return { visible: text };
  }
  if (quoted || depth < 1 || depth > 2) return { visible: text };
  try {
    const control = normalize(JSON.parse(candidate + "}".repeat(depth)).control);
    if (control?.action === "blocked") return { visible: before ?? tail.slice(0,start).trim(), control };
  } catch { /* Other malformed JSON stays ordinary text. */ }
  return { visible: text };
}

/**
 * Finds the start of the last "bracket-balanced" JSON object from the end.
 * Uses matching rather than a regex, so { } in task descriptions won't cut it off.
 */
function findLastBalancedObject(text: string): number {
  const end = text.lastIndexOf("}");
  if (end < 0) return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      // When scanning backwards, whether a quote is escaped depends on how many consecutive backslashes precede it
      if (ch === '"' && countPrecedingBackslashes(text, i) % 2 === 0) {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      depth -= 1;
      if (depth === 0) return i;
    }
    void escaped;
  }
  return -1;
}

function countPrecedingBackslashes(text: string, index: number): number {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count += 1;
  return count;
}

function normalize(value: unknown): LeaderControl | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const action = String(raw.action ?? "").toLowerCase() as LeaderAction;
  if (!ACTIONS.includes(action)) return undefined;

  const control: LeaderControl = { action };
  if (action === "brainstorm") {
    if (!["revise", "ask", "probe", "agree"].includes(String(raw.decision)) || typeof raw.reason !== "string" || !raw.reason.trim()) return undefined;
    control.decision = raw.decision as LeaderControl["decision"];
  }
  if (action === "batch") {
    if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > 20) return undefined;
    // Check before recursion: nested batches and hidden stop/permission actions are never accepted.
    if (!raw.actions.every(a => a && ["plan", "review"].includes(String(a.action).toLowerCase()) && a.mode === undefined)) return undefined;
    const actions = raw.actions.map(normalize);
    if (actions.some(a => !a)) return undefined;
    control.actions = actions as LeaderControl[];
  }
  if (action === "plan") {
    if (!Array.isArray(raw.work) || !raw.work.length || raw.work.length > 100) return undefined;
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string" && !!x.trim());
    if (!raw.work.every(w => w && typeof w.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(w.id) &&
      typeof w.assignment === "string" && !!w.assignment.trim() && strings(w.candidates) && w.candidates.length &&
      strings(w.dependsOn) && strings(w.outputs) && typeof w.acceptance === "string" && !!w.acceptance.trim() && typeof w.readOnly === "boolean")) return undefined;
    if (raw.work.some(w => w.preAgreed !== undefined && typeof w.preAgreed !== "boolean")) return undefined;
    control.work = raw.work.map(w => ({id:w.id, assignment:w.assignment.trim(), candidates:w.candidates.map((s:string)=>s.trim()), dependsOn:w.dependsOn, outputs:w.outputs, acceptance:w.acceptance.trim(), readOnly:w.readOnly,
      ...(w.preAgreed === true ? {preAgreed:true} : {})}));
  }
  if (action === "interrupt") {
    if (typeof raw.workId !== "string" || !raw.workId.trim() || typeof raw.assignmentId !== "string" || !raw.assignmentId.trim() || typeof raw.evidence !== "string" || !raw.evidence.trim() || typeof raw.reason !== "string" || !raw.reason.trim()) return undefined;
    control.workId = raw.workId.trim();
    control.evidence = raw.evidence.trim();
  }
  if (action === "review") {
    if (typeof raw.workId !== "string" || !["pass", "retry"].includes(String(raw.verdict)) || typeof raw.evidence !== "string" || !raw.evidence.trim()) return undefined;
    control.workId = raw.workId;
    control.verdict = raw.verdict as "pass" | "retry";
    control.evidence = raw.evidence.trim();
  }
  if (typeof raw.assignmentId === "string") control.assignmentId = raw.assignmentId.trim();
  if (Array.isArray(raw.assignments)) {
    control.assignments = raw.assignments.filter((entry): entry is {to: string; assignment: string} =>
      !!entry && typeof entry.to === "string" && !!entry.to.trim() && typeof entry.assignment === "string" && !!entry.assignment.trim()
    ).map(entry => ({to: entry.to.trim(), assignment: entry.assignment.trim()}));
  }
  if (typeof raw.to === "string" && raw.to.trim()) control.to = raw.to.trim();
  if (typeof raw.assignment === "string" && raw.assignment.trim()) {
    control.assignment = raw.assignment.trim();
  }
  if (typeof raw.topic === "string" && raw.topic.trim()) control.topic = raw.topic.trim();
  if (typeof raw.reason === "string" && raw.reason.trim()) {
    control.reason = raw.reason.trim();
  }
  // assign must name a person, otherwise the instruction can't be executed
  if (action === "assign" && !control.to && !control.assignments?.length) return undefined;
  if ((action === "accept" || action === "revise" || action === "blocked") && !control.assignmentId) return undefined;
  if (action === "blocked" && !control.reason) return undefined;
  return control;
}
