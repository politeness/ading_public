import { mkdtemp } from "./tmp.mjs";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { CodexAdapter } from "../dist/agents/codex.js";
import { ClaudeCodeAdapter } from "../dist/agents/claude.js";
import { QoderAdapter } from "../dist/agents/qoder.js";
import { QoderCnAdapter } from "../dist/agents/qoder-cn.js";
import {
  CODEX_HOST_CONTEXT_ENV_KEYS,
  codexChildEnvironment
} from "../dist/agents/codex-environment.js";

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-agent-contract-"));

{
  const source = {
    PATH: "/test/bin",
    CODEX_HOME: "/keep/user-config",
    ...Object.fromEntries(CODEX_HOST_CONTEXT_ENV_KEYS.map((key) => [key, "parent-host-value"]))
  };
  const child = codexChildEnvironment(source);
  check("Codex child process keeps the user environment", child.PATH === source.PATH && child.CODEX_HOME === source.CODEX_HOME, child);
  check(
    "Codex child process doesn't inherit the host session",
    CODEX_HOST_CONTEXT_ENV_KEYS.every((key) => !(key in child)),
    child
  );
}

async function executable(name, body) {
  const file = path.join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const codexPath = await executable("fake-codex", `
const args = process.argv.slice(2);
const prompt = args.at(-1) || "";
const id = "123e4567-e89b-42d3-a456-426614174000";
console.log(JSON.stringify({type:"thread.started",thread_id:id}));
if (prompt.includes("wait")) setTimeout(() => {}, 10000);
else if (prompt === "recover-stream") {
  console.log(JSON.stringify({type:"error",message:"Reconnecting... websocket closed"}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"恢复后的真实回复"}}));
  console.log(JSON.stringify({type:"turn.completed"}));
}
else if (prompt === "partial-stream") {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"草稿已写入，尚未验收"}}));
  console.log(JSON.stringify({type:"turn.failed",error:{message:"websocket closed by server"}}));
}
else if (prompt === "missing-completion") {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"不完整轮次"}}));
}
else if (prompt.includes("fail")) console.log(JSON.stringify({type:"turn.failed",error:{message:"fake failure"}}));
else {
  console.log(JSON.stringify({type:"turn.started"}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"过时的中间进展"}}));
  console.log(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"pnpm test"}}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Codex 最终回复"}}));
  console.log(JSON.stringify({type:"turn.completed"}));
}
`);

const streamPath = await executable("fake-stream-agent", `
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const resumeIndex = args.indexOf("--resume");
const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const id = resume && !resume.startsWith("--") ? resume : "stream-session-1";
console.log(JSON.stringify({type:"system",subtype:"init",session_id:id}));
if (prompt.includes("wait")) setTimeout(() => {}, 10000);
else if (prompt.includes("communication-hang")) {
  console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"已给出具体讨论意见"}]},session_id:id}));
  setTimeout(() => {}, 10000);
}
else if (prompt.includes("fail")) console.log(JSON.stringify({type:"result",subtype:"error",is_error:true,result:"fake failure",session_id:id}));
else {
  console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Read",input:{file_path:"src/main.ts"}}]}}));
  console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"中间分析"}]}}));
  console.log(JSON.stringify({type:"result",subtype:"success",result:"最终回复",session_id:id}));
}
`);

const makeAgent = (kind, executablePath) => ({
  localUuid: `${kind}@test`, kind, name: kind, version: "test", executablePath, nodeName: "test"
});
const input = (prompt, progress, extra = {}) => ({
  prompt,
  workspacePath: dir,
  fullAccess: false,
  onProgress: (text) => progress.push(text),
  ...extra
});

{
  const adapter = new CodexAdapter();
  adapter.readNativeConfiguration=async()=>({source:"fixture-native-default"});
  const progress = [];
  const outcome = await adapter.runTurn(makeAgent("codex", codexPath), input("work", progress));
  check("Codex fake CLI completes a turn", outcome.ok === true, outcome);
  check("Codex extracts thread id", outcome.threadId === "123e4567-e89b-42d3-a456-426614174000", outcome);
  check("Codex hands only the final reply to chat", outcome.message === "Codex 最终回复", outcome.message);
  check("Codex streams command progress", progress.some((text) => text.includes("pnpm test")), progress);
  check("Codex progress written to steps", outcome.steps.some((text) => text.includes("pnpm test")), outcome.steps);
  check("Codex detects side effects", outcome.metrics.sideEffects === true, outcome.metrics);

  const resumed = await adapter.runTurn(
    makeAgent("codex", codexPath),
    input("continue", [], { threadId: outcome.threadId })
  );
  check("Codex final reply doesn't include the process", outcome.message === "Codex 最终回复", outcome);
  check("Codex can resume the session", resumed.ok && resumed.threadId === outcome.threadId, resumed);

  const errored = await adapter.runTurn(makeAgent("codex", codexPath), input("fail", []));
  check("Codex in-stream error doesn't become incomplete data", !errored.ok && errored.error.includes("fake failure"), errored);
  const recovered = await adapter.runTurn(makeAgent("codex", codexPath), input("recover-stream", []));
  check("turn.completed after recovery clears transient connection errors", recovered.ok && recovered.message === "恢复后的真实回复", recovered);
  const partial = await adapter.runTurn(makeAgent("codex", codexPath), input("partial-stream", []));
  check("failed turn keeps visible text without posing as success", !partial.ok && partial.partialMessage === "草稿已写入，尚未验收", partial);
  const incomplete = await adapter.runTurn(makeAgent("codex", codexPath), input("missing-completion", []));
  check("missing completion event can't submit a result", !incomplete.ok && incomplete.partialMessage === "不完整轮次", incomplete);

  const waiting = adapter.runTurn(makeAgent("codex", codexPath), input("wait", []));
  await new Promise((resolve) => setTimeout(resolve, 80));
  check("Codex can be cancelled while running", adapter.cancel("codex@test") === true);
  const cancelled = await waiting;
  check("Codex cancellation result is recognizable", cancelled.cancelled === true, cancelled);
}

for (const [kind, Adapter] of [
  ["claude-code", ClaudeCodeAdapter],
  ["qoder", QoderAdapter],
  ["qoder-cn", QoderCnAdapter]
]) {
  const adapter = new Adapter();
  const progress = [];
  const outcome = await adapter.runTurn(makeAgent(kind, streamPath), input("work", progress));
  check(`${kind} fake CLI completes a turn`, outcome.ok === true, outcome);
  check(`${kind} extracts session id`, outcome.threadId === "stream-session-1", outcome);
  check(`${kind} delivers only the result final reply`, outcome.message === "最终回复", outcome.message);
  check(`${kind} gets the tool activity stream`, progress.some((text) => text.includes("查看文件")), progress);
  check(`${kind} doesn't mix intermediate analysis into the final reply`, !outcome.message.includes("中间分析"), outcome.message);

  const resumed = await adapter.runTurn(
    makeAgent(kind, streamPath),
    input("continue", [], { threadId: "stream-session-1" })
  );
  check(`${kind} can resume the session`, resumed.ok && resumed.threadId === "stream-session-1", resumed);

  const errored = await adapter.runTurn(makeAgent(kind, streamPath), input("fail", []));
  check(`${kind} extracts in-stream errors`, !errored.ok && errored.error.includes("fake failure"), errored);
  const salvaged = await adapter.runTurn(makeAgent(kind, streamPath), input("communication-hang", [], {communicationOnly:true,discussionOnly:true,timeoutMs:40}));
  check(`${kind} keeps the opinion when discussion text was given but exit timed out`, salvaged.ok && salvaged.message === "已给出具体讨论意见", salvaged);
}

// Exercise real adapter/process cancellation with independent task keys.
for (const [kind, Adapter, executablePath] of [
  ["codex", CodexAdapter, codexPath], ["claude-code", ClaudeCodeAdapter, streamPath],
  ["qoder", QoderAdapter, streamPath], ["qoder-cn", QoderCnAdapter, streamPath]
]) {
  const adapter = new Adapter();
  const a = {...makeAgent(kind, executablePath), localUuid: `${kind}@test::task:A`};
  const b = {...makeAgent(kind, executablePath), localUuid: `${kind}@test::task:B`};
  const old = adapter.runTurn(a, input("wait", []));
  await new Promise(resolve => setTimeout(resolve, 60));
  const hi = await adapter.runTurn(b, input("hi", []));
  check(`${kind} old task still running when new task completes`, hi.ok && adapter.isBusy(a.localUuid), hi);
  const parallel = adapter.runTurn(b, input("wait", []));
  await new Promise(resolve => setTimeout(resolve, 60));
  check(`${kind} two tasks run concurrently`, adapter.isBusy(a.localUuid) && adapter.isBusy(b.localUuid));
  adapter.cancel(a.localUuid);
  check(`${kind} cancelling task A doesn't affect B`, (await old).cancelled && adapter.isBusy(b.localUuid));
  adapter.cancel(b.localUuid);
  check(`${kind} task B can be cancelled independently`, (await parallel).cancelled);
}

// Qoder discovery: no fake "not connected" state; a launcher shell that won't run must give a reason; npm-installed qodercli must be found; CN must not cross over to the international build.
{
  const savedHome = process.env.HOME, savedPath = process.env.PATH;
  const home = await mkdtemp(path.join(os.tmpdir(), "ading-qoder-home-"));
  const bin = path.join(home, "prefix-bin");
  await mkdir(path.join(home, ".qoder/entry"), { recursive: true });
  await mkdir(bin, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = bin;
  try {
    const qoder = new QoderAdapter(), cn = new QoderCnAdapter();
    const shell = path.join(home, ".qoder/entry/qoder");
    await writeFile(shell, "#!/bin/sh\necho 'qodercli is not installed' >&2\nexit 3\n");
    await chmod(shell, 0o755);
    check("Qoder no longer shows the 'enable ADing access' notice", (await qoder.setupNotice()) === null);
    check("Qoder isn't considered installed when the launcher shell won't run", (await qoder.discover()).length === 0);
    const failure = qoder.lastDiscoveryFailure();
    check("Qoder detection failure reason comes from stderr", failure?.includes(shell) && failure.includes("qodercli is not installed"), failure);
    check("Qoder with launcher shell but no working CLI is judged 'CLI not installed'", await qoder.vendorAppInstalled());
    const cli = path.join(bin, "qodercli");
    await writeFile(cli, "#!/bin/sh\necho 9.9.9\n");
    await chmod(cli, 0o755);
    const found = await qoder.discover();
    check("Qoder finds qodercli on PATH", found[0]?.executablePath === await realpath(cli) && found[0]?.version === "9.9.9", found);
    check("Qoder clears the failure reason once found", qoder.lastDiscoveryFailure() === undefined);
    await mkdir(path.join(home, "Applications/Qoder CN.app"), { recursive: true });
    await cn.discover();
    check("Qoder CN with desktop app but no CLI is judged 'CLI not installed'", await cn.vendorAppInstalled());
    check("Qoder CN doesn't accept the international qodercli", (await cn.discover()).length === 0);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
  }
}

console.log(`agent-adapter: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
