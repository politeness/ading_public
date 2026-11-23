// stream-json parsing for Claude Code / Qoder. The parser is deliberately lenient:
// on a version mismatch it should degrade, rather than show the user "response data incomplete"
import path from "node:path";
const m = await import(path.resolve("dist/agents/stream-json.js"));
const { parseStreamJson: parse, cleanAgentOutput: clean, describeStreamEvent: describe, countStreamMetrics: count } = m;

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const J = (o) => JSON.stringify(o);
const init = J({ type: "system", subtype: "init", session_id: "s-1" });
const say = (t) => J({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const tool = (name, input) => J({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const done = (t) => J({ type: "result", subtype: "success", result: t, session_id: "s-1" });

// ---- A normal turn ----
const ok = parse([init, say("先看看日志"), tool("Bash", { command: "tail -n 50 app.log" }), done("是 MQ 重复投递")].join("\n"));
check("gets the session id", ok.threadId === "s-1", ok);
check("final reply uses result", ok.message === "是 MQ 重复投递", ok.message);
check("no error", ok.error === undefined);

// result is the authoritative answer; intermediate process narration must not leak into the group
check("process narration is not spliced into the reply", !ok.message.includes("先看看日志"));

// ---- Late interjection: the CLI starts the next turn itself in the same process, and both results belong to this reply ----
const twoTurns = parse([init, done("APPLE"), J({type:"system",subtype:"init",session_id:"s-1"}), done("BANANA")].join("\n"));
check("results of both turns are merged in order without losing the first turn's answer", twoTurns.message === "APPLE\n\nBANANA", twoTurns.message);
const restated = parse([init, done("APPLE"), done("APPLE\nBANANA")].join("\n"));
check("when the next turn restates the previous one, only the complete copy is kept", restated.message === "APPLE\nBANANA", restated.message);
const skipped = parse([init, done("APPLE"), done("SKIP")].join("\n"));
check("SKIP in the next turn does not enter the reply", skipped.message === "APPLE", skipped.message);

// ---- No result event (different version / truncated) ----
const noResult = parse([init, say("第一段"), say("最后一段")].join("\n"));
check("falls back to the last assistant text", noResult.message === "最后一段", noResult.message);
check("still gets the session id when degraded", noResult.threadId === "s-1");

// Direct chats must retain an answer emitted before a later tool call/result.
const translation='译文：第二次提交已通过，文件仍待上传。';
const attachment='附件已经准备好。';
const multi=[init,say(translation),J({type:'assistant',message:{content:[{type:'thinking',thinking:'private reasoning'}]}}),tool('Read',{file_path:'example.txt'}),say(attachment),done(attachment)];
check('Direct chat keeps the text before tools, final body not duplicated',parse(multi.join('\n'),undefined,true).message===translation+'\n\n'+attachment);
const retained=multi.map(m.retainStreamLine).filter(Boolean).join('\n');
check('Real process retention pipeline keeps earlier text and leaks neither thinking nor tool arguments',parse(retained,undefined,true).message===translation+'\n\n'+attachment && !retained.includes('private reasoning') && !retained.includes('example.txt'));
check('When the result restates all text of the turn, only one copy is kept',parse([...multi.slice(0,-1),done(translation+'\n\n'+attachment)].join('\n'),undefined,true).message===translation+'\n\n'+attachment);
check('Coordination protocol still takes only the final reply',parse(retained).message===attachment);
check('Without a result event, direct chat still keeps every emitted segment',parse([say(translation),say(attachment)].join('\n'),undefined,true).message===translation+'\n\n'+attachment);
check('A repeated result is not appended twice',parse([say(translation),done(translation)].join('\n'),undefined,true).message===translation);
check('A failed direct chat keeps the earlier reply without mixing in the error echo',parse([say(translation),say('quota limit'),J({type:'result',is_error:true,result:'quota limit'})].join('\n'),undefined,true).message===translation);

// ---- CLI reports its own error ----
const errored = parse([init, J({ type: "result", subtype: "error", is_error: true, result: "credit balance too low", session_id: "s-1" })].join("\n"));
check("recognizes is_error", errored.error === "credit balance too low", errored);
check("returns the session id on error too", errored.threadId === "s-1");

const erroredWithArray = parse(J({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["You've reached your credit usage limit."],
  session_id: "s-2"
}));
check("recognizes the errors array of newer CLIs", erroredWithArray.error === "You've reached your credit usage limit.", erroredWithArray);

// Qwen emits a failed API request as assistant text AND as the error result.
// It is diagnostic text, not completed work that should block context recovery.
const apiError='[API Error: Engine protocol predict request returned 400: {"error":{"message":"prompt exceeds the context window","code":"context_length_exceeded"}}]';
const apiFailure=J({type:'result',is_error:true,error:apiError,session_id:'s-1'});
const rejected=parse([init,say(apiError),apiFailure].join('\n'));
check("echoed API error is not treated as a partial reply",rejected.message===undefined,rejected);
check("original API error text is kept",rejected.error===apiError,rejected);
const partialThenError=parse([init,say('已完成第一项'),say(apiError),apiFailure].join('\n'));
check("actual work reply before the error is still kept",partialThenError.message==='已完成第一项',partialThenError);
const earlierTurnThenError=parse([init,done('已交付上一轮'),say(apiError),apiFailure].join('\n'));
check("complete result before the error is still kept",earlierTurnThenError.message==='已交付上一轮',earlierTurnThenError);

// ---- Alternate field name spelling ----
check("accepts camelCase sessionId",
  parse(J({ type: "system", subtype: "init", sessionId: "s-2" })).threadId === "s-2");

// ---- Dirty output ----
const dirty = parse(["warning: something", "", "not json at all", init, done("好了")].join("\n"));
check("parses even when mixed with non-JSON logs", dirty.message === "好了" && dirty.threadId === "s-1", dirty);
check("returns empty when everything is garbage", parse("nonsense\n").message === undefined);

// ---- Model protocol leakage ----
check("removes complete think blocks", clean("<think>内部推理</think>最终答案") === "最终答案");
check("takes the body after a lone closing tag", clean("内部推理\n</think>\n\n最终答案") === "最终答案");
check("Qoder duplicated body keeps only the content after the closing tag", clean("回答\n</think>\n\n回答") === "回答");
check("when only SKIP follows think, the protocol word is kept for upstream interception", clean("内部推理\n</think>\n\nSKIP") === "SKIP");
check("SKIP at the end of the body is not shown", clean("有必要补一句\n\nSKIP") === "有必要补一句");
check("removes tool protocol closing tags leaked by Qoder CN",
  clean("最终回答\n</parameter>\n</invoke>") === "最终回答");
check("removes tool protocol closing tags with escaped slashes",
  clean("最终回答\n\\</parameter>\n\\</invoke>") === "最终回答");
check("keeps protocol tags used for explanation in the body",
  clean("`</parameter>` 是一个协议闭标签。") === "`</parameter>` 是一个协议闭标签。");

// ---- Continuation: if the new turn gets no id, reuse the previous one ----
check("keeps the previous id when none is available", parse("nonsense", "s-old").threadId === "s-old");

// ---- Progress text ----
check("init has progress", describe(init) === "已连接");
check("commands have progress", describe(tool("Bash", { command: "pnpm  test" })) === "正在执行命令：pnpm test");
check("file edits have progress", describe(tool("Edit", { file_path: "/a/b/c.ts" })) === "正在修改文件：b/c.ts", describe(tool("Edit", { file_path: "/a/b/c.ts" })));
check("file reads have progress", describe(tool("Read", { file_path: "/a/b/c.ts" })) === "正在查看文件：b/c.ts");
check("non-JSON is not misreported", describe("hello") === null);
check("user messages produce no progress", describe(J({ type: "user", message: { content: [] } })) === null);

// ---- Threshold counting ----
const metrics = { iterations: 0, sideEffects: false };
for (const line of [init, say("想一下"), tool("Read", { file_path: "a.ts" }), done("完成")]) count(line, metrics);
check("counts only assistant turns", metrics.iterations === 2, metrics);
check("pure reads are not side effects", metrics.sideEffects === false, metrics);

const metrics2 = { iterations: 0, sideEffects: false };
count(tool("Bash", { command: "rm -rf /tmp/x" }), metrics2);
check("running commands is a side effect", metrics2.sideEffects === true);
const metrics3 = { iterations: 0, sideEffects: false };
count(tool("Write", { file_path: "a.ts" }), metrics3);
check("writing files is a side effect", metrics3.sideEffects === true);
const usageMetrics={iterations:0,sideEffects:false};
count(J({type:'result',usage:{input_tokens:10,cache_read_input_tokens:70,cache_creation_input_tokens:20,output_tokens:5}}),usageMetrics);
check("CLI token usage includes separate cache fields",usageMetrics.tokenUsage?.inputTokens===100&&usageMetrics.tokenUsage?.cachedInputTokens===70&&usageMetrics.tokenUsage?.totalTokens===105,usageMetrics.tokenUsage);

// Shapes below are copied from a real qoderclicn --output-format stream-json run:
// credits ride on each assistant message and the result event carries none, so
// reading usage only from the result left credit-billed providers uncounted.
const creditMetrics={iterations:0,sideEffects:false};
count(J({type:'assistant',message:{content:[{type:'text',text:'hi'}],usage:{input_tokens:0,output_tokens:0,credits:2.69,original_credits:6.73,context_usage_ratio:0.1116}}}),creditMetrics);
count(J({type:'assistant',message:{content:[{type:'text',text:'ok'}],usage:{input_tokens:0,output_tokens:0,credits:1.31,original_credits:3.27,context_usage_ratio:0.4}}}),creditMetrics);
count(J({type:'result',usage:{input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,context_usage_ratio:0.4}}),creditMetrics);
check("credit-billed provider accumulates actual charge and list price",
  Math.abs((creditMetrics.providerCredits?.spent??0)-4)<1e-9&&Math.abs((creditMetrics.providerCredits?.listPrice??0)-10)<1e-9,
  creditMetrics.providerCredits);
check("provider with all-zero tokens does not fake token usage",creditMetrics.tokenUsage===undefined,creditMetrics.tokenUsage);
check("records peak context usage",creditMetrics.contextUsagePeak===0.4,creditMetrics.contextUsagePeak);

const claudeMetrics={iterations:0,sideEffects:false};
count(J({type:'assistant',message:{content:[{type:'text',text:'hi'}],usage:{input_tokens:5,output_tokens:7}}}),claudeMetrics);
check("token-billed provider produces no credits field",claudeMetrics.providerCredits===undefined,claudeMetrics.providerCredits);

// Numbers from a real claude --output-format stream-json run that spawned one
// subagent: result.usage equals the top-level transcript alone, while modelUsage
// adds the subagent (cache writes 7305 + 23890 = 31195).
const delegated={iterations:0,sideEffects:false};
count(J({type:'result',usage:{input_tokens:34,output_tokens:162,cache_read_input_tokens:49693,cache_creation_input_tokens:7305},
  modelUsage:{'claude-opus-5':{inputTokens:36,outputTokens:166,cacheReadInputTokens:49693,cacheCreationInputTokens:31195,costUSD:0.25}}}),delegated);
check("sub-agent usage counts toward this turn's tokens",delegated.tokenUsage?.inputTokens===36+49693+31195&&delegated.tokenUsage?.outputTokens===166&&delegated.tokenUsage?.cacheWriteInputTokens===31195,delegated.tokenUsage);
const multiModel={iterations:0,sideEffects:false};
count(J({type:'result',usage:{input_tokens:1,output_tokens:1},modelUsage:{a:{inputTokens:10,outputTokens:5},b:{inputTokens:3,outputTokens:2}}}),multiModel);
check("usage of multiple models adds up",multiModel.tokenUsage?.inputTokens===13&&multiModel.tokenUsage?.outputTokens===7,multiModel.tokenUsage);

// modelUsage is the cumulative value for the whole vendor session: a second result after steer in the same process replaces the previous one instead of adding up
const steered={iterations:0,sideEffects:false};
count(J({type:'result',modelUsage:{a:{inputTokens:10,outputTokens:5}}}),steered);
count(J({type:'result',modelUsage:{a:{inputTokens:30,outputTokens:9}}}),steered);
check("cumulative values are not added twice",steered.tokenUsage?.inputTokens===30&&steered.tokenUsage?.outputTokens===9,steered.tokenUsage);
const perRun={iterations:0,sideEffects:false};
count(J({type:'result',usage:{input_tokens:2,output_tokens:1}}),perRun);
count(J({type:'result',usage:{input_tokens:3,output_tokens:1}}),perRun);
check("provider without modelUsage still adds per run",perRun.tokenUsage?.inputTokens===5,perRun.tokenUsage);

console.log(`stream-json: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
