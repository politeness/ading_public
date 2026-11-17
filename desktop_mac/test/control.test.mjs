// Parsing of leader control blocks. This is most easily broken by agents' creative output, so focus on edge cases
import path from "node:path";
const { controlProtocolIssue, parseLeaderControl: parse } = await import(path.resolve("dist/orchestration/control.js"));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

// No control block
check("Plain speech not misjudged", parse("我觉得应该先看日志。").control === undefined);
check("Plain speech returned as-is", parse("我觉得应该先看日志。").visible === "我觉得应该先看日志。");
check("The word control in body text is not misjudged",
  parse("这个 control 参数要改一下。").control === undefined);

// The basic three
const stop = parse('结论已经有了。\n{"control":{"action":"stop","reason":"不用再展开"}}');
check("stop parsed", stop.control?.action === "stop", stop.control);
check("stop with reason", stop.control?.reason === "不用再展开");
check("stop leaves human text after stripping", stop.visible === "结论已经有了。", stop.visible);

const assign = parse('阿测你去看看。\n{"control":{"action":"assign","to":"阿测","assignment":"验证日志"}}');
check("assign parsed", assign.control?.action === "assign" && assign.control?.to === "阿测");
check("assign with task", assign.control?.assignment === "验证日志");

const refocus = parse('跑题了。\n{"control":{"action":"refocus","topic":"回到重复扣款"}}');
check("refocus parsed", refocus.control?.topic === "回到重复扣款");

// Code fences
const fenced = parse('先打住。\n```json\n{"control":{"action":"stop"}}\n```');
check("Control block inside fence", fenced.control?.action === "stop", fenced.control);
check("Fenced version stripped cleanly", fenced.visible === "先打住。", fenced.visible);

// Task description containing braces -- a sloppy regex breaks here
const braces = parse('改一下配置。\n{"control":{"action":"assign","to":"阿码","assignment":"把 {\\"a\\":1} 换成 {\\"a\\":2}"}}');
check("Still parses with braces in task", braces.control?.action === "assign", braces.control);
check("assignment content intact", braces.control?.assignment === '把 {"a":1} 换成 {"a":2}', braces.control?.assignment);
check("Human text correct with braces", braces.visible === "改一下配置。", braces.visible);

// Invalid and missing fields
check("Unknown action rejected", parse('{"control":{"action":"explode"}}').control === undefined);
check("assign without a named target rejected", parse('{"control":{"action":"assign","assignment":"干活"}}').control === undefined);
check("Bad JSON does not throw", parse('好的。\n{"control":{action:stop}}').control === undefined);
check("No control key rejected", parse('{"foo":"bar"}').control === undefined);
check("Empty string", parse("").control === undefined);

// Only a control block with no human text -- must not send an empty message
const onlyControl = parse('{"control":{"action":"stop"}}');
check("Pure control block does not leak into chat", onlyControl.visible === "", onlyControl.visible);

// Case tolerance
check("Uppercase action also accepted", parse('{"control":{"action":"STOP"}}').control?.action === "stop");

// Multiple JSON objects, take the last one
const multi = parse('先看这个 {"note":"x"}\n{"control":{"action":"stop"}}');
check("Takes the trailing object", multi.control?.action === "stop", multi.control);

const leading = parse('{"control":{"action":"organize","mode":"execution"}}\n结论正文即使随后被截断，已完成的控制块也应生效。');
check("Complete leading control block parses",leading.control?.action==="organize",leading.control);
check("Body after leading control block is kept",leading.visible==="结论正文即使随后被截断，已完成的控制块也应生效。",leading.visible);
const leadingPlan=JSON.stringify({control:{action:"plan",work:[{id:"sample",assignment:"制作样张",candidates:["Codex"],dependsOn:[],outputs:["drafts/sample.png"],acceptance:"实图复核",readOnly:false}]}})+'\n方案正文写到一半';
check("Complete leading plan is unaffected by later body",parse(leadingPlan).control?.work?.[0]?.id==="sample",parse(leadingPlan).control);
check("Stray closing brace after leading control does not enter the feed",parse(JSON.stringify({control:{action:"stop",reason:"done"}})+'}\n\n可见结论').visible==='可见结论',parse(JSON.stringify({control:{action:"stop",reason:"done"}})+'}\n\n可见结论').visible);
check("Truncated plan is diagnosed, not executed",controlProtocolIssue('{"control":{"action":"plan","work":[{"id":"W1","assignment":"x"')==="incomplete"&&!parse('{"control":{"action":"plan","work":[{"id":"W1","assignment":"x"').control,controlProtocolIssue('{"control":{"action":"plan","work":[{"id":"W1","assignment":"x"'));
const unicodeIdPlan=JSON.stringify({control:{action:"plan",work:[{id:"W1_样张",assignment:"x",candidates:["a"],dependsOn:[],outputs:["x"],acceptance:"x",readOnly:false}]}});
check("Chinese work id gets an accurate diagnosis",controlProtocolIssue(unicodeIdPlan)==="invalid-plan-id",controlProtocolIssue(unicodeIdPlan));

check("leader can decide collaboration strategy", parse('{"control":{"action":"organize","mode":"discussion"}}').control?.mode === "discussion");
check("Unknown strategy has no effect", parse('{"control":{"action":"organize","mode":"other"}}').control === undefined);
check("Batch assignment can carry the execution decision", parse('{"control":{"action":"assign","mode":"execution","to":"阿码"}}').control?.mode === "execution");
const interruptDecision={action:"interrupt",workId:"work1",assignmentId:"v1",evidence:"read result mismatch",reason:"discuss new method"};
check("interrupt requires evidence and direction",parse(JSON.stringify({control:interruptDecision})).control?.action==="interrupt");
for (const field of ["workId","assignmentId","evidence","reason"]) {
  check(`interrupt rejects missing ${field}`,!parse(JSON.stringify({control:{...interruptDecision,[field]:""}})).control);
}
console.log(`\nleader control block tests: passed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
