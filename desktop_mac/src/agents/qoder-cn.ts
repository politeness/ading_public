import path from "node:path";
import os from "node:os";
import { skillRootMayExist } from "./cli-agent";
import { QoderAdapter } from "./qoder";
import { removeManagedBlock, writeManagedBlock } from "../skills/block";
import { removeSkillDirs, writeSkillDirs } from "../skills/skill-dir";
import type { SkillTarget } from "../skills/target";
import { p } from "../prompt-language";

/**
 * Qoder CN and international Qoder have separate accounts, config directories and npm packages.
 * The argument protocol is the same, so Qoder's run logic is reused, but identity and discovery paths must be fully separate.
 */
export class QoderCnAdapter extends QoderAdapter {
  readonly kind: AgentKind = "qoder-cn";
  protected readonly binary = "qodercn";
  // Must override: otherwise it inherits the international qodercli and merges the two into one
  protected readonly binaryAliases = ["qoderclicn"];
  readonly label = "Qoder CN";
  readonly installHint = "npm install -g @qodercn-ai/qoderclicn";
  readonly loginHint = "qodercn login";
  readonly logoutHint = undefined;
  readonly docsUrl = "https://docs.qoder.cn/cli";

  protected extraCandidates(): string[] {
    const home = os.homedir();
    return [
      path.join(home, ".qoder-cn/entry/qodercn"),
      path.join(home, ".qoder-cn/entry/qoder-cn"),
      path.join(home, ".local/bin/qodercn"),
      path.join(home, ".qoder-cn/bin/qoderclicn/qoderclicn")
    ];
  }

  // The desktop app and the CLI are separate components. With the app installed it should still clearly show "CLI not installed".
  async setupNotice(): Promise<AgentSetupNotice | null> {
    return null;
  }

  protected get configDir(): string { return process.env.QODERCN_CONFIG_DIR || path.join(os.homedir(), ".qoder-cn"); }

  async resolveSkillTarget(scope: Scope, workspacePath: string): Promise<SkillTarget | null> {
    const home = path.join(os.homedir(), ".qoder-cn");
    const base = scope === "workspace" ? workspacePath : home;
    if (!(await skillRootMayExist(base))) return null;
    const dirPath = scope === "workspace" ? path.join(base, ".qoder", "skills") : path.join(base, "skills");
    return { agentKind: this.kind, scope, style: "skill-dir", dirPath,
      compatibilityFilePath: path.join(base, "AGENTS.md"),
      humanNote: p(`同步完整技能包到 ${dirPath}`, `Syncs complete skill packages to ${dirPath}`) };
  }

  async syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    if (target.style === "managed-block" && target.filePath) {
      await writeManagedBlock(target.filePath, skills, { ownerFingerprint: target.ownerFingerprint }); return [target.filePath];
    }
    if (!target.dirPath) return [];
    return writeSkillDirs(target.dirPath, skills, { ownerFingerprint: target.ownerFingerprint });
  }

  async unsyncSkills(target: SkillTarget): Promise<string[]> {
    const cleared = target.dirPath ? await removeSkillDirs(target.dirPath, { ownerFingerprint: target.ownerFingerprint }) : [];
    const file = target.compatibilityFilePath ?? target.filePath;
    if (file && await removeManagedBlock(file, { ownerFingerprint: target.ownerFingerprint })) cleared.push(file);
    return cleared;
  }
}
