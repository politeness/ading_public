import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { makeScratchDirectory } from "./scratch";
import { readJsoncSettings } from "../platform/jsonc-settings";
import type { TurnInput } from "./types";
import { p } from "../prompt-language";

// Self-contained helper: Electron can run it as Node too. No credentials or
// loopback bearer tokens are stored in workspace config or command arguments.
const HELPER = String.raw`
const readline = require('node:readline');
const mode = process.argv[2];
async function call(url, token, body) {
  if (!url || !token) throw new Error('ADing runtime is not active');
  const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
  if (!response.ok) throw new Error('ADing bridge unavailable');
  return response.status === 202 ? undefined : response.json();
}
if (mode === 'hook') {
  let input = '';
  process.stdin.on('data', chunk => {input += chunk; if(input.length > 1024*1024) process.exit(1);});
  process.stdin.on('end', async () => {
    let answer = {decision:'deny',reason:'ADing permission bridge unavailable'};
    try {
      if (!process.env.ADING_PERMISSION_URL) answer = {decision:'allow'};
      else answer = await call(process.env.ADING_PERMISSION_URL, process.env.ADING_PERMISSION_TOKEN, JSON.parse(input));
    } catch {}
    process.stdout.write(JSON.stringify(answer)+'\n');
  });
} else {
  const reader = readline.createInterface({input:process.stdin});
  reader.on('line', async line => {
    let request;
    try {
      request=JSON.parse(line);
      const config=JSON.parse(process.env.ADING_MCP_SERVER || '{}');
      if (!config.url) {
        if(request.id !== undefined) {
          const result=request.method==='initialize' ? {protocolVersion:request.params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'ading-inactive',version:'1'}} : request.method==='tools/list' ? {tools:[]} : undefined;
          process.stdout.write(JSON.stringify(result ? {jsonrpc:'2.0',id:request.id,result} : {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Runtime is inactive'}})+'\n');
        }
        return;
      }
      const answer=await call(config.url, (config.headers?.Authorization || '').replace(/^Bearer /,''), request);
      if(answer) process.stdout.write(JSON.stringify(answer)+'\n');
    } catch {
      if(request?.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'ADing bridge unavailable'}})+'\n');
    }
  });
}
`;

export async function stdioMcpServer(config: string) {
  const directory = await makeScratchDirectory("mcp-stdio");
  const file = path.join(directory, "bridge.cjs");
  await writeFile(file, HELPER, { mode: 0o600 });
  const value = Object.values(JSON.parse(config).mcpServers)[0];
  return { server: { name: "ading", command: process.execPath, args: [file, "mcp"], env: [
    { name: "ELECTRON_RUN_AS_NODE", value: "1" }, { name: "ADING_MCP_SERVER", value: JSON.stringify(value) }
  ] }, close: () => rm(directory, { recursive: true, force: true }) };
}

const READ_TOOLS = new Set(["view_file", "view_file_outline", "view_code_item", "list_dir", "grep_search", "find_by_name"]);
export async function nativeToolPermission(input: TurnInput, payload: any, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || input.discussionOnly) return false;
  const tool = payload.toolCall ?? {}, name = String(tool.name ?? "");
  if (!input.fullAccess) return READ_TOOLS.has(name);
  if (input.permissionMode === "unattended") return true;
  return !!await input.onPermission?.({ requestId: `${payload.conversationId}:${payload.stepIdx}`,
    toolName: name, input: tool.args ?? {}, workspacePath: input.workspacePath, signal });
}

interface Lease { count: number; directory: string; changes: Array<{ file: string; original?: string; installed: string; key: string; nested?: string }>; }
const leases = new Map<string, Promise<Lease>>();
const releasing = new Map<string, Promise<void>>();
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const quoted = String.raw`'((?:[^']|'\\'')*)'`;
const HOOK_COMMAND = new RegExp(`^ELECTRON_RUN_AS_NODE=1 ${quoted} ${quoted} hook$`);
// Helper directories carry the owning pid so a crashed instance's entries can be told apart from a live one's.
const HELPER_DIRECTORY = /^ading-native-tools-(?:(\d+)-)?[A-Za-z0-9]{6}$/;
const liveDirectories = new Set<string>();

/** Helper directory of an entry ADing installed whose owner is gone (crash, kill,
 * failed restore); undefined for user entries and entries of a running instance. */
async function staleHelper(entry: any, nested: string | undefined): Promise<string | undefined> {
  let helper: string | undefined;
  if (nested) {
    if (entry?.args?.length === 2 && entry.args[1] === "mcp" && typeof entry.args[0] === "string") helper = entry.args[0];
  } else {
    const hooks = entry?.PreToolUse;
    const command = Array.isArray(hooks) && hooks.length === 1 && hooks[0]?.hooks?.length === 1 ? hooks[0].hooks[0]?.command : undefined;
    const match = typeof command === "string" ? HOOK_COMMAND.exec(command) : null;
    if (match) helper = match[2].replaceAll("'\\''", "'");
  }
  if (!helper || !path.isAbsolute(helper) || path.basename(helper) !== "bridge.cjs") return undefined;
  const directory = path.dirname(helper), owner = HELPER_DIRECTORY.exec(path.basename(directory));
  if (!owner) return undefined;
  if (liveDirectories.has(directory)) return undefined;
  if (!await lstat(helper).then(() => true, () => false)) return directory;
  const pid = Number(owner[1]);
  // Entries without a pid predate owner marks; only a missing helper proves them stale.
  if (!pid) return undefined;
  if (pid === process.pid) return directory;
  try { process.kill(pid, 0); return undefined; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? directory : undefined; }
}

/** One provider-neutral helper per active workspace. Runtime credentials travel
 * only through each owned child process's environment. Restore owned entries
 * after the last lane exits, preserving unrelated edits and existing files. */
async function acquireWorkspace(workspace: string): Promise<() => Promise<void>> {
  for (;;) {
    // Acquisitions wait for the last release to finish restoring this workspace.
    while (releasing.has(workspace)) await releasing.get(workspace);
    const pending = leases.get(workspace) ?? createLease(workspace);
    let lease: Lease;
    try { lease = await pending; } catch (error) { if (leases.get(workspace) === pending) leases.delete(workspace); throw error; }
    // A release may have retired this lease while we awaited; never reuse a helper being removed.
    if (leases.get(workspace) !== pending) continue;
    lease.count++;
    let released = false;
    return async () => {
      if (released) return; released = true;
      if (--lease.count) return;
      // No new acquisition may use a helper being removed.
      leases.delete(workspace);
      const cleanup = releaseFiles(lease).finally(() => liveDirectories.delete(lease.directory));
      releasing.set(workspace, cleanup);
      try { await cleanup; } finally { releasing.delete(workspace); }
    };
  }
}
function createLease(workspace: string): Promise<Lease> {
  const pending = (async () => {
    const directory = await makeScratchDirectory("native-tools", String(process.pid));
    liveDirectories.add(directory);
    const lease: Lease = { count: 0, directory, changes: [] };
    const helper = path.join(directory, "bridge.cjs");
    await writeFile(helper, HELPER, { mode: 0o600 });
    const folder = path.join(workspace, ".agents");
    try {
      try { if ((await lstat(folder)).isSymbolicLink()) throw new Error(p("不能使用符号链接指向的 .agents 目录", "Refusing redirected .agents directory")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await mkdir(folder, { recursive: true });
      for (const spec of [
        { file: path.join(folder, "hooks.json"), key: "ading-runtime", nested: undefined, value: {
          PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(helper)} hook`, timeout: 86400 }] }]
        } },
        { file: path.join(folder, "mcp_config.json"), key: "ading", nested: "mcpServers", value: {
          command: process.execPath, args: [helper, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" }, timeoutSeconds: 86400
        } }
      ]) {
        let original: string | undefined;
        try { if ((await lstat(spec.file)).isSymbolicLink()) throw new Error(p("不能使用符号链接指向的运行配置", "Refusing redirected runtime config")); original = await readFile(spec.file, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const value = original === undefined ? {} : await readJsoncSettings(spec.file);
        const parent = spec.nested ? (value[spec.nested] ??= {}) : value;
        if (parent[spec.key] !== undefined) {
          const stale = await staleHelper(parent[spec.key], spec.nested);
          if (!stale) throw new Error(p("已有同名原生配置，请先移除冲突的 ading 项", "A native configuration already uses ADing's entry name; resolve that conflict first"));
          // Take over a leftover entry. That file was already rewritten by us, so the
          // rest is restored as-is; a file holding nothing else is removed on release.
          delete parent[spec.key];
          const rest = JSON.stringify(value, null, 2) + "\n";
          original = rest === JSON.stringify(spec.nested ? { [spec.nested]: {} } : {}, null, 2) + "\n" ? undefined : rest;
          if (path.dirname(stale) === tmpdir()) await rm(stale, { recursive: true, force: true }).catch(() => undefined);
        }
        parent[spec.key] = spec.value;
        const installed = JSON.stringify(value, null, 2) + "\n";
        await writeFile(spec.file, installed, { mode: 0o600 });
        lease.changes.push({ ...spec, original, installed });
      }
      return lease;
    } catch (error) { await releaseFiles(lease).finally(() => liveDirectories.delete(lease.directory)); throw error; }
  })();
  leases.set(workspace, pending);
  return pending;
}
async function releaseFiles(lease: Lease): Promise<void> {
  const unresolved: string[] = [];
  for (const change of [...lease.changes].reverse()) {
    try {
      const stat = await lstat(change.file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink()) { unresolved.push(change.file); continue; }
      const current = await readFile(change.file, "utf8");
      if (current === change.installed) {
        if (change.original === undefined) await rm(change.file, { force: true });
        else await writeFile(change.file, change.original);
      } else {
        // Preserve concurrent user edits; remove only the exact entry we own.
        const value = await readJsoncSettings(change.file);
        const parent = change.nested ? value[change.nested] : value;
        const installed = JSON.parse(change.installed);
        const expected = (change.nested ? installed[change.nested] : installed)[change.key];
        if (parent && JSON.stringify(parent[change.key]) === JSON.stringify(expected)) {
          delete parent[change.key];
          await writeFile(change.file, JSON.stringify(value, null, 2) + "\n");
        } else if (current.includes(lease.directory)) unresolved.push(change.file);
      }
    } catch { unresolved.push(change.file); }
  }
  // An edited/malformed config may still reference this helper. Retain it so
  // cleanup cannot leave a broken command; report the exact files for repair.
  if (unresolved.length) throw new Error(p("原生配置已改变，保留辅助文件供清理：", "Native configuration changed; retained helper for cleanup: ") + unresolved.join(", "));
  await rm(lease.directory, { recursive: true, force: true });
}

export async function startNativeToolBridge(input: TurnInput, mcpConfig?: string) {
  const release = await acquireWorkspace(input.workspacePath);
  const token = randomBytes(32).toString("hex"), scope = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, scope.signal]) : scope.signal;
  let waiting = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    let result = { decision: "deny" };
    try {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Request too large"); }
      waiting++;
      let allowed: boolean;
      try { allowed = await nativeToolPermission(input, JSON.parse(body), signal); } finally { waiting--; }
      result = { decision: allowed && !signal.aborted ? "auto_approve" : "deny" };
    } catch { /* Permission failures deny the operation. */ }
    if (!res.destroyed) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error(p("工具审批连接启动失败", "Permission bridge failed to start"));
    return { isWaiting: () => waiting > 0, env: { ...process.env, ADING_PERMISSION_URL: `http://127.0.0.1:${address.port}`, ADING_PERMISSION_TOKEN: token,
      ADING_MCP_SERVER: JSON.stringify(mcpConfig ? Object.values(JSON.parse(mcpConfig).mcpServers)[0] : {}) },
      close: async () => { scope.abort(); server.close(); server.closeAllConnections(); await release().catch(error => input.onProgress(String(error))); } };
  } catch (error) { server.close(); await release(); throw error; }
}
