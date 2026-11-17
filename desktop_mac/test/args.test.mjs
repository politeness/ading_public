// Command-line argument assembly. On a real machine these errors only show up after a full turn; here a single assertion pins them down
import path from "node:path";
const { ClaudeCodeAdapter } = await import(path.resolve("dist/agents/claude.js"));
const { QoderAdapter } = await import(path.resolve("dist/agents/qoder.js"));
const { QoderCnAdapter } = await import(path.resolve("dist/agents/qoder-cn.js"));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const input = (over = {}) => ({
  prompt: "你好", workspacePath: "/tmp/ws", fullAccess: false,
  onProgress: () => {}, ...over
});
const after = (args, flag) => args[args.indexOf(flag) + 1];

for (const [label, Adapter, deny, allow] of [
  ["Claude Code", ClaudeCodeAdapter, "dontAsk", "bypassPermissions"],
  ["Qoder", QoderAdapter, "dont_ask", "bypass_permissions"],
  ["Qoder CN", QoderCnAdapter, "dont_ask", "bypass_permissions"]
]) {
  const a = new Adapter();
  const ro = a.buildArgs(input());
  const rw = a.buildArgs(input({ fullAccess: true }));

  check(`${label}: non-interactive mode`, ro.includes("-p") && after(ro, "-p") === "你好", ro);
  check(`${label}: requires stream-json`, after(ro, "--output-format") === "stream-json");
  check(
    `${label}: --verbose matches the local CLI's capability`,
    ro.includes("--verbose") === (label === "Claude Code"),
    ro
  );
  check(`${label}: read-only level`, after(ro, "--permission-mode") === deny, ro);
  check(`${label}: full-access level`, after(rw, "--permission-mode") === allow, rw);

  // The most critical one: never pass --resume without a threadId,
  // otherwise the first turn tries to resume a session that doesn't exist
  check(`${label}: new session has no --resume`, !ro.includes("--resume"), ro);
  const resumed = a.buildArgs(input({ threadId: "s-42" }));
  check(`${label}: resume carries the id`, after(resumed, "--resume") === "s-42", resumed);
  // Permission arguments are still required when resuming — without them the permissions from the session-creating turn would carry over
  check(`${label}: resume still passes permissions`, after(resumed, "--permission-mode") === deny, resumed);

  const fastSteered = a.buildArgs(input({fullAccess:true,steerable:true,permissionMode:'unattended'}));
  check(`${label}: unattended mode keeps streaming interjections`,after(fastSteered,"--input-format")==="stream-json",fastSteered);
  check(`${label}: unattended mode uses native fast authorization`,after(fastSteered,"--permission-mode")===allow,fastSteered);
  check(`${label}: unattended mode keeps the approval channel for ADing to auto-approve`,after(fastSteered,"--permission-prompt-tool")==="stdio",fastSteered);
  check(`${label}: unattended mode still uses the vendor bypass fast authorization`,/bypass/i.test(after(fastSteered,"--permission-mode")??""),fastSteered);
  // Parallel children are neither steerable nor given a host callback, yet they
  // hit the same vendor checks; they need the channel as much as the parent does.
  const fastChild = a.buildArgs(input({fullAccess:true,steerable:false,permissionMode:'unattended'}));
  check(`${label}: unattended parallel sub-channels also attach the approval channel`,after(fastChild,"--input-format")==="stream-json"&&after(fastChild,"--permission-prompt-tool")==="stdio",fastChild);
  const manualSteered = a.buildArgs(input({fullAccess:true,steerable:true,permissionMode:'manual',onPermission:async()=>true}));
  check(`${label}: with streaming input, Claude Code echoes interjections delivered to the model`,fastSteered.includes("--replay-user-messages")===(label==="Claude Code")&&!ro.includes("--replay-user-messages"),fastSteered);
  check(`${label}: manual mode keeps the per-item approval tool`,after(manualSteered,"--permission-prompt-tool")==="stdio",manualSteered);

  // The prompt must be passed as its own argv element, not concatenated into a string the shell would split
  check(`${label}: prompt is a separate argument`, ro.filter((x) => x === "你好").length === 1);
}

// Qoder only: pass the working directory explicitly
check("Qoder passes --cwd", after(new QoderAdapter().buildArgs(input()), "--cwd") === "/tmp/ws");
check("Qoder CN passes --cwd", after(new QoderCnAdapter().buildArgs(input()), "--cwd") === "/tmp/ws");
check("Claude Code doesn't pass --cwd (uses the process cwd)",
  !new ClaudeCodeAdapter().buildArgs(input()).includes("--cwd"));

// Identity excludes the install path — a changed path must not become a new contact
const kinds = [
  [ClaudeCodeAdapter, "claude-code"],
  [QoderAdapter, "qoder"],
  [QoderCnAdapter, "qoder-cn"]
];
for (const [Adapter, kind] of kinds) {
  check(`${kind} kind matches`, new Adapter().kind === kind);
}

console.log(`args: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
