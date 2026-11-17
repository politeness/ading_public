import { mkdtemp } from "./tmp.mjs";
import os from "node:os";
import path from "node:path";
import { chmod, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { retainStreamLine, parseStreamJson } from "../dist/agents/stream-json.js";
import { ProcessRunner } from "../dist/agents/process-runner.js";

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-runner-"));
async function executable(name, body) {
  const file = path.join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const outputCli = await executable("output", `
process.stdout.write("stdout-final");
process.stderr.write("auth-url-final");
`);
const lines = [], stderrLines = [];
const output = await new ProcessRunner().run("output", {
  executablePath: outputCli,
  args: [], cwd: dir, label: "output test", backgroundPriority: true, timeoutMs: 5000,
  onLine: (line) => lines.push(line),
  onStderrLine: (line) => stderrLines.push(line)
});
check("Keeps trailing partial stdout line", lines.includes("stdout-final"), lines);
check("Keeps trailing partial stderr line", stderrLines.includes("auth-url-final"), stderrLines);
check("Returns exit code", output.exitCode === 0, output);
check("Low-priority wrapper does not change the output protocol", output.stdout === "stdout-final", output);

const waitCli = await executable("wait", `setTimeout(() => {}, 10000);`);
const runner = new ProcessRunner();
const first = runner.run("same-action", {
  executablePath: waitCli,
  args: [], cwd: dir, label: "重复测试", timeoutMs: 2000,
  onLine: () => undefined
});
const duplicate = await runner.run("same-action", {
  executablePath: waitCli,
  args: [], cwd: dir, label: "重复测试", timeoutMs: 2000,
  onLine: () => undefined
});
check("The same action cannot be started twice", duplicate.failure.includes("已经在进行中"), duplicate);
check("A running action can be cancelled", runner.cancel("same-action") === true);
check("Cancelled result is clearly marked", (await first).cancelled === true);

const timed = await new ProcessRunner().run("timeout", {
  executablePath: waitCli,
  args: [], cwd: dir, label: "timeout test", timeoutMs: 40,
  onLine: () => undefined
});
check("Hard timeout terminates the process", timed.failure.includes("超过 1 秒"), timed);

const imageCli = await executable("images", `
const line=JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:'x'.repeat(1024*1024)}]}})+'\\n';
process.stdout.write(JSON.stringify({type:'system',session_id:'long-conversation'})+'\\n');
for(let i=0;i<25;i++) process.stdout.write(line);
process.stdout.write(JSON.stringify({type:'result',result:'final result'}));
`);
const images = await new ProcessRunner().run("images", {
  executablePath:imageCli,args:[],cwd:dir,label:"image stream",timeoutMs:5000,
  onLine:()=>{},retainLine:retainStreamLine
});
check("Image stream over 20MB still keeps the final result", !images.failure && parseStreamJson(images.stdout).message === 'final result', images.failure);
check("Keeps the initial session and drops image data", parseStreamJson(images.stdout).threadId === 'long-conversation' && images.stdout.length<1024);

if(process.platform !== 'win32') {
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  let descendant;
  const treeCli=await executable('tree', `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready:'+process.pid); setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
setInterval(()=>{},1000);
`);
  const treeRunner=new ProcessRunner();
  let running;
  try {
    running=treeRunner.run('tree',{executablePath:treeCli,args:[],cwd:dir,label:'process tree',timeoutMs:10000,onLine:line=>{if(line.startsWith('ready:'))descendant=Number(line.slice(6));}});
    for(let i=0;i<100&&!descendant;i++)await new Promise(r=>setTimeout(r,10));
    check('Descendant process started',!!descendant);
    treeRunner.cancel('tree');
    await running;
    await new Promise(r=>setTimeout(r,200));
    let alive=false;try{process.kill(descendant,0);alive=true;}catch{}
    check('Cancel cleans up descendants that refuse TERM',!alive);
    check('Does not stop processes unrelated to ADing',process.kill(unrelated.pid,0));
  } finally {unrelated.kill('SIGKILL');treeRunner.cancel('tree');await running;}
}

{
  // The stall watchdog must pause while children work, then re-arm. It used to
  // skip arming the timer whenever hasPendingWork() was true, and nothing armed
  // it again once that work drained, so a silent child ran forever.
  const silentCli = await executable("silent", `
process.stdout.write("started");
setInterval(()=>{}, 1000);
`);
  const runner = new ProcessRunner();
  let pending = true;
  const stalled = runner.run("watchdog", {
    executablePath: silentCli, args: [], cwd: dir, label: "watchdog",
    idleTimeoutMs: 200, hasPendingWork: () => pending, onLine: () => {}
  });
  await new Promise(r => setTimeout(r, 900));
  check("Not misjudged as stalled while parallel work runs", !(await Promise.race([stalled.then(() => true), Promise.resolve(false)])));
  pending = false;
  const result = await Promise.race([
    stalled,
    new Promise(r => setTimeout(() => r({ failure: "watchdog never re-armed" }), 5000))
  ]);
  check("Watchdog re-arms after parallel work ends", /长时间没有任何进度/.test(result.failure), result.failure);
  runner.cancel("watchdog");
}

// Before quitting or OTA restart, wait until child processes have really exited; do not blindly wait a fixed duration.
{
  const runner = new ProcessRunner();
  check("Returns immediately when there are no child processes", (await runner.waitForExit(5000)).length === 0);

  // A process that ignores SIGTERM: it must be reaped by SIGKILL, and waitForExit must wait until that moment
  const stubborn = await executable("stubborn", `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
process.stdout.write("started\\n");
`);
  // Wait for it to report ready itself: a freshly written script may take over 1 second to cold start, and SIGTERM before the handler is registered exits immediately
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const run = runner.run("stubborn", {
    executablePath: stubborn, args: [], cwd: dir,
    label: "stubborn", backgroundPriority: true, timeoutMs: 20000, onLine: line => { if (line.includes("started")) ready(); }
  });
  await started;
  check("busyIds includes it while the process runs", runner.busyIds().includes("stubborn"), runner.busyIds());

  // waitForExit only waits; terminating is cancel's job -- without cancel it should truthfully report it is still there
  const tooSoon = await runner.waitForExit(600);
  check("Truthfully returns still-running processes when not terminated", tooSoon.includes("stubborn"), tooSoon);

  // Real exit flow: cancel first (SIGTERM, then SIGKILL after 3 seconds), then wait until it really exits
  const cancelledAt = Date.now();
  runner.cancel("stubborn");
  const settled = await runner.waitForExit(8000);
  const waited = Date.now() - cancelledAt;
  check("After cancel, waits until the process really exits", settled.length === 0, settled);
  check("busyIds is empty after the process exits", runner.busyIds().length === 0, runner.busyIds());
  // This process ignores SIGTERM and can only be reaped by the SIGKILL after 3 seconds
  check("Really waited for SIGKILL to take effect", waited > 2500, waited);
  // But it should not blindly wait the full limit either: return as soon as it exits
  check("Does not idle until the limit", waited < 6000, waited);
  await run;
}

console.log(`process-runner: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
