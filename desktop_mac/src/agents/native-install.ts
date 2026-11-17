import { downloadArchive, type InstallProgress } from "./download-progress";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, rm, chmod, link, symlink, lstat, stat, access, readlink, unlink } from "node:fs/promises";
import { makeScratchDirectory } from "./scratch";
import type { RunResult } from "./process-runner";
import { p } from "../prompt-language";

type Run = (executable: string, args: string[], timeoutMs?: number) => Promise<RunResult>;
// Only the vendor's own release paths; other buckets on a shared host are not trusted.
const RELEASE_LOCATIONS = {
  kiro: { host: "prod.download.cli.kiro.dev", path: "/stable/" },
  antigravity: { host: "storage.googleapis.com", path: "/antigravity-public/antigravity-cli/" }
} as const;

/** A broken symlink into ADing's own release directory is a leftover of a
 * removed or interrupted install; anything else may be the user's CLI. */
async function removeBrokenOwnedShim(target: string, owned: string): Promise<void> {
  let info;
  try { info = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink() && path.resolve(path.dirname(target), await readlink(target)).startsWith(owned + path.sep)
    && !(await access(target, constants.X_OK).then(() => true, () => false))) await unlink(target);
}

/** A directory is a mount point when it lives on a different device than its
 * parent. Anything but a clean "not there" counts as mounted, so the caller
 * never recursively deletes into a disk image it cannot rule out. */
export async function isMountPoint(directory: string): Promise<boolean> {
  try {
    const [own, parent] = await Promise.all([stat(directory), stat(path.dirname(directory))]);
    return own.dev !== parent.dev;
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Official native releases, verified against their official manifest. Never
 * execute a downloaded installer script, or remove a usable installation. */
export async function installNativeCli(kind: "kiro" | "antigravity", prefix: string, run: Run, onProgress: InstallProgress = () => {},
  mounted: (directory: string) => Promise<boolean> = isMountPoint): Promise<string> {
  if (process.platform !== "darwin") throw new Error(p("此原生安装器目前支持 macOS", "This native installer currently supports macOS"));
  const scratch = await makeScratchDirectory("install", kind);
  let attached = false, completed = false;
  let ownedDestination: string | undefined, ownedStaging: string | undefined;
  const mount = path.join(scratch, "mount");
  const label = kind === "kiro" ? "Kiro" : "Antigravity";
  const invoke = async (command: string, args: string[], timeoutMs?: number) => {
    const result = await run(command, args, timeoutMs);
    if (result.failure || result.cancelled) throw new Error(result.failure || p("安装已取消", "Installation cancelled"));
    return result.stdout;
  };
  try {
    onProgress(p(`${label}：正在获取版本信息`, `${label}: fetching release information`));
    const manifestUrl = kind === "kiro" ? "https://prod.download.cli.kiro.dev/stable/latest/manifest.json"
      : `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_${os.arch() === "arm64" ? "arm64" : "amd64"}.json`;
    const manifest = JSON.parse(await invoke("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location",
      "--proto", "=https", "--proto-redir", "=https", "--max-time", "60", manifestUrl]));
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.a-zA-Z0-9]*)?$/.test(manifest.version)) throw new Error(p("发布版本号无效", "Invalid release version"));
    const pkg = kind === "kiro" ? (Array.isArray(manifest.packages) ? manifest.packages : []).find((item: any) => item?.fileType === "dmg" && item?.os === "macos") : manifest;
    if (typeof (kind === "kiro" ? pkg?.download : pkg?.url) !== "string") throw new Error(p(`${label} 发布清单里没有 macOS 安装包`, `${label} release manifest has no macOS package`));
    const url = kind === "kiro" ? new URL(pkg.download, "https://prod.download.cli.kiro.dev/stable/").toString() : pkg.url;
    const parsed = new URL(url);
    const location = RELEASE_LOCATIONS[kind];
    if (parsed.protocol !== "https:" || parsed.hostname !== location.host || parsed.port || parsed.username || parsed.password
      || !parsed.pathname.startsWith(location.path)) throw new Error(p("发布包下载地址不符合预期", "Unexpected release host"));
    const archive = path.join(scratch, kind === "kiro" ? "release.dmg" : "release.tar.gz");
    try {
      await downloadArchive(url, archive, run, onProgress, label);
    } catch (error) {
      const bytes = await stat(archive).then(value => value.size, () => 0);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(p(`${label} 下载失败（已接收 ${(bytes / 1048576).toFixed(1)} MB）：${reason}`,
        `${label} download failed (received ${(bytes / 1048576).toFixed(1)} MB): ${reason}`));
    }
    onProgress(p(`${label}：正在校验下载文件`, `${label}: verifying the download`));
    const algorithm = kind === "kiro" ? "sha256" : "sha512", hash = createHash(algorithm);
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== pkg[algorithm]) throw new Error(p("下载文件校验失败", "Downloaded release checksum mismatch"));
    const binary = kind === "kiro" ? "kiro-cli" : "agy";
    const target = path.join(prefix, "bin", binary), owned = path.join(prefix, "lib", "ading-agents");
    await removeBrokenOwnedShim(target, owned);
    try { await lstat(target); throw new Error(p("安装目标已存在，请先检查现有 CLI", "The install target already exists; inspect the existing CLI first")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(target), { recursive: true });
    onProgress(p(`${label}：正在安装 CLI`, `${label}: installing CLI`));
    if (kind === "kiro") {
      const release = path.join(owned, `kiro-${manifest.version}`), destination = path.join(release, "Kiro CLI.app");
      // target is absent here, so this ADing-owned version is not installed; it is
      // what an interrupted or unlinked earlier install left behind.
      const leftover = await lstat(release).catch(() => undefined);
      if (leftover?.isDirectory()) await rm(release, { recursive: true });
      else if (leftover) throw new Error(p("发布包目录已存在", "Release directory already exists"));
      await mkdir(mount);
      // Set before attach: a cancelled or timed-out attach may already have mounted.
      attached = true;
      await invoke("/usr/bin/hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-owners", "off", "-mountpoint", mount]);
      await mkdir(path.dirname(destination), { recursive: true });
      ownedDestination = destination;
      await invoke("/usr/bin/ditto", [path.join(mount, "Kiro CLI.app"), destination]);
      await invoke(path.join(destination, "Contents/MacOS/kiro-cli"), ["--version"]);
      await symlink(path.join(destination, "Contents/MacOS/kiro-cli"), target);
    } else {
      await invoke("/usr/bin/tar", ["-xzf", archive, "-C", scratch, "antigravity"]);
      const file = path.join(scratch, "antigravity");
      const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(p("原生可执行文件无效", "Invalid native executable"));
      await chmod(file, 0o755); await invoke(file, ["--version"]);
      const staging = `${target}.ading-${path.basename(scratch)}`;
      ownedStaging = staging;
      // copy through ditto supports installations on another filesystem.
      await invoke("/usr/bin/ditto", [file, staging]);
      await link(staging, target); // Fails if another install created target meanwhile.
      await rm(staging);
    }
    completed = true;
    return p(`${label} ${manifest.version} 已安装`, `Installed ${label} ${manifest.version}`);
  } finally {
    if (!completed && ownedDestination) await rm(ownedDestination, { recursive: true, force: true });
    if (ownedStaging) await rm(ownedStaging, { force: true });
    // Detach first, then delete only once the mount point is confirmed gone:
    // never recursively delete into a still-mounted disk image. A failed detach
    // is logged by run and must not replace the install result.
    if (attached) await run("/usr/bin/hdiutil", ["detach", mount, "-quiet"], 30_000).catch(() => undefined);
    if (!attached || !await mounted(mount)) await rm(scratch, { recursive: true, force: true });
  }
}
