import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

/** Official desktop apps of each vendor; the single list behind both "the
 * vendor's app is installed" and bundled-CLI discovery. ADing only detects and
 * reuses them; it never installs them (default installation is CLI-first).
 * Qoder.app (com.qoder.app) and the renamed Qoder IDE.app (com.qoder.ide) only
 * ship the ~/.qoder/entry dispatcher, not a CLI. Kiro CLI.app is the official
 * CLI bundle that carries kiro-cli. */
export const DESKTOP_APP_NAMES: Record<AgentKind, string[]> = {
  codex: ["ChatGPT.app", "Codex.app"], "claude-code": ["Claude.app"],
  qoder: ["Qoder.app", "Qoder IDE.app"], "qoder-cn": ["Qoder CN.app", "Qoder CN IDE.app"],
  "qwen-code": ["Qwen Code Desktop.app"], copilot: ["GitHub Copilot.app"],
  kiro: ["Kiro.app", "Kiro CLI.app"], antigravity: ["Antigravity.app"]
};
export function desktopAppPaths(kind: AgentKind, roots = ["/Applications", path.join(os.homedir(), "Applications")]): string[] {
  return roots.flatMap(root => DESKTOP_APP_NAMES[kind].map(name => path.join(root, name)));
}
export async function findDesktopApp(kind: AgentKind, roots?: string[]): Promise<string | undefined> {
  for (const file of desktopAppPaths(kind, roots)) {
    if (await stat(path.join(file, "Contents/Info.plist")).then(s => s.isFile(), () => false)) return file;
  }
  return undefined;
}
