import path from "node:path";
import { access, constants } from "node:fs/promises";
import { log } from "../orchestration/diagnostics";

/** Native copies are best-effort. Never use this around a central data mutation. onError only reports; it cannot fail the operation. */
export async function bestEffortSync<T>(operation: () => Promise<T>, fallback: T, onError?: (error: unknown) => Promise<void> | void): Promise<T> {
  try { return await operation(); }
  catch (error) {
    await log("knowledge-sync-failed", { error: String(error) }).catch(() => {});
    try { await onError?.(error); } catch { /* reporting is best-effort too */ }
    return fallback;
  }
}

/** Native skill locations per Agent, used to tell which Agent a path-bearing error (EACCES, ENOENT…) belongs to. */
export type SkillPathsResolver = () => Promise<Array<{ kind: AgentKind; paths: string[] }>>;

const DETAIL_LIMIT = 300;
const FAILURE_LIMIT = 20;

/** Tag an error with the Agent whose copy failed, so the user sees which Agent lacks the knowledge. */
export function withAgentKind(error: unknown, kind: AgentKind): Error {
  const tagged = error instanceof Error ? error : new Error(String(error));
  try { Object.defineProperty(tagged, "agentKind", { value: kind, configurable: true }); } catch { /* frozen errors stay unattributed */ }
  return tagged;
}

function leaves(error: unknown): unknown[] {
  return error instanceof AggregateError && error.errors.length ? error.errors.flatMap(leaves) : [error];
}

function message(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || String(error);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

function mentions(text: string, kind: AgentKind): boolean {
  return new RegExp(`(?<![\\w-])${kind.replace(/[-]/g, "\\-")}(?![\\w-])`).test(text);
}

/** An access check is evidence about the directory only; EPERM can still be a per-file or system policy denial. */
async function permissionFailure(error: unknown): Promise<KnowledgeSyncFailure["permission"]> {
  const value=error as NodeJS.ErrnoException|undefined;
  const raw=error instanceof Error ? error.message : String(error);
  const code=value?.code ?? raw.match(/^(EPERM|EACCES):/)?.[1];
  if(code!=="EPERM"&&code!=="EACCES")return undefined;
  const failedPath=typeof value?.path==="string" ? value.path : raw.match(/, (?:open|mkdir|access|scandir|unlink|rename|stat|lstat|chmod) ['"]([\s\S]+)['"]$/)?.[1];
  if(!failedPath)return undefined;
  const paths=path.win32.isAbsolute(failedPath)&&!path.posix.isAbsolute(failedPath) ? path.win32 : path;
  if(!paths.isAbsolute(failedPath))return undefined;
  const temporary=failedPath.search(/[\\/]\.ading-candidate-[^\\/]+/);
  const syscall=value?.syscall ?? raw.match(/, (\w+) ['"]/)?.[1];
  const directory=temporary>=0 ? failedPath.slice(0,temporary) : ["access","mkdir","scandir"].includes(syscall??"") ? failedPath : paths.dirname(failedPath);
  let directoryWritable:boolean|undefined;
  try {await access(directory,constants.W_OK);directoryWritable=true;}
  catch(cause){if(["EACCES","EPERM"].includes((cause as NodeJS.ErrnoException).code??""))directoryWritable=false;}
  return {code,path:failedPath,directory,platform:process.platform,...(directoryWritable===undefined ? {} : {directoryWritable})};
}

/**
 * Split one sync error into per-Agent failures. Attribution order: an explicit tag, then the
 * longest native path the message mentions, then an Agent kind named in the message; otherwise
 * every Agent of that pass, since the copy reached none of them.
 */
export async function describeSyncFailures(category: KnowledgeSyncFailure["category"], error: unknown, kinds: AgentKind[], skillPaths?: SkillPathsResolver): Promise<KnowledgeSyncFailure[]> {
  const all = [...new Set(kinds)];
  let paths: Array<{ kind: AgentKind; paths: string[] }> | undefined;
  const failures: KnowledgeSyncFailure[] = [];
  for (const leaf of leaves(error)) {
    const detail = message(leaf);
    const raw = leaf instanceof Error ? leaf.message : String(leaf);
    const tagged = (leaf as { agentKind?: AgentKind } | null)?.agentKind;
    let agents: AgentKind[] = tagged ? [tagged] : [];
    if (!agents.length && skillPaths) {
      paths ??= await skillPaths().catch(() => []);
      let best = 0;
      for (const entry of paths) for (const candidate of entry.paths) {
        if (!candidate || !raw.includes(candidate) || candidate.length < best) continue;
        if (candidate.length > best) { best = candidate.length; agents = []; }
        agents.push(entry.kind);
      }
    }
    if (!agents.length) agents = all.filter(kind => mentions(raw, kind));
    if (!agents.length) agents = all;
    const merged = failures.find(item => item.detail === detail && item.agents.join() === [...new Set(agents)].join());
    if (!merged) {
      const permission=await permissionFailure(leaf);
      failures.push({ category, agents: [...new Set(agents)], detail, ...(permission ? {permission} : {}) });
    }
  }
  return failures.slice(0, FAILURE_LIMIT);
}
