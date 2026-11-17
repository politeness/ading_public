import os from "node:os";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MAX_ATTACHMENTS, mimeFromName } from "../store/attachments";
import { p } from "../prompt-language";

/** `image` marks embeds and image links: their delivery failures are reported.
 * Other links may be plain citations, so only workspace files become attachments. */
interface FileReference { start: number; end: number; label: string; file: string; image: boolean }

/** Only explicit delivery links are attachments. Bare paths, code examples and
 * files merely inspected by a provider tool are not permission to publish files. */
export function localReplyAttachments(content: string): FileReference[] {
  const hidden = new Uint8Array(content.length);
  let fence: string | undefined;
  let offset = 0;
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      hidden.fill(1, offset, offset + line.length);
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) {
      fence = marker;
      hidden.fill(1, offset, offset + line.length);
    } else if (/^(?: {4}|\t)/.test(line)) hidden.fill(1, offset, offset + line.length);
    offset += line.length;
  }
  // Mask inline code before scanning links (including multiline code spans).
  for (const match of content.matchAll(/(`+)([\s\S]*?)\1(?!`)/g)) {
    if (!hidden[match.index!]) hidden.fill(1, match.index!, match.index! + match[0].length);
  }
  const escaped = (at: number) => {
    let slashes = 0;
    while (at > 0 && content[--at] === "\\") slashes++;
    return slashes % 2 === 1;
  };
  const references: FileReference[] = [];
  const opening = /!?\[((?:\\.|[^\]\\\n])*)\]\(/g;
  for (let match; (match = opening.exec(content));) {
    const start = match.index;
    if (hidden[start] || escaped(start) || (content[start - 1] === "!" && escaped(start - 1))) continue;
    let at = opening.lastIndex, depth = 1;
    const angle = content[at] === "<";
    let angleClosed = !angle;
    for (; at < content.length; at++) {
      if (content[at] === "\n" || hidden[at]) break;
      if (escaped(at)) continue;
      if (angle && !angleClosed) { if (content[at] === ">") angleClosed = true; continue; }
      if (content[at] === "(") depth++;
      if (content[at] === ")" && --depth === 0) break;
    }
    if (depth !== 0) continue;
    opening.lastIndex = at + 1;
    let destination = content.slice(match.index + match[0].length, at).trim();
    if (destination.startsWith("<")) {
      const end = destination.indexOf(">");
      if (end < 0 || !/^(?:\s+["'][\s\S]*["'])?$/.test(destination.slice(end + 1))) continue;
      destination = destination.slice(1, end);
    } else destination = destination.replace(/\s+["'][^"']*["']$/, "");
    destination = destination.replace(/\\([\\()[\]<> ])/g, "$1");
    let file: string;
    if (/^file:/i.test(destination)) {
      try { file = fileURLToPath(destination); } catch { continue; }
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith("//") || destination.startsWith("#")) continue;
      // A fragment addresses a place inside the file (`notes.md#L3`), not part of its name.
      const local = destination.replace(/#.*$/s, "");
      try { file = decodeURIComponent(local); } catch { file = local; }
    }
    // Source citations address a line, not a deliverable file.
    if (!file || /[\u0000-\u001f]/.test(file) || /:\d+(?::\d+)?$/.test(file)) continue;
    const image = content[start] === "!" || mimeFromName(file).startsWith("image/");
    references.push({ start, end: at + 1, label: match[1].replace(/\\(.)/g, "$1"), file, image });
  }
  return references;
}

/** Import once before appendMessage retries. The ordinary attachment queue then
 * uploads the bytes before publishing the message, including for Agent senders. */
export async function prepareReplyAttachments(input: {
  content: string;
  references: FileReference[];
  workspacePath: string;
  attachments?: Attachment[];
  importAttachment(file: string): Promise<Attachment>;
}): Promise<{ content: string; attachments?: Attachment[] }> {
  if (!input.references.length) return { content: input.content, attachments: input.attachments };
  const attachments = [...(input.attachments ?? [])];
  const imported = new Map<string, Attachment>();
  const failures: string[] = [];
  const replacements: { start: number; end: number; text: string }[] = [];
  // Agents deliver what they made in the conversation workspace; links elsewhere
  // (absolute, ~/, ../ or a symlink out) would publish unrelated local files.
  const workspace = await realpath(input.workspacePath).catch(() => undefined);
  for (const ref of input.references) {
    const file = ref.file.startsWith("~/") ? path.join(os.homedir(), ref.file.slice(2)) : path.resolve(input.workspacePath, ref.file);
    try {
      const canonical = await realpath(file);
      const relative = workspace === undefined ? "" : path.relative(workspace, canonical);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("ATTACHMENT_OUTSIDE_WORKSPACE");
      let attachment = imported.get(canonical);
      if (!attachment) {
        if (!(await stat(canonical)).isFile()) throw new Error("ATTACHMENT_NOT_FILE");
        if (attachments.length >= MAX_ATTACHMENTS) throw new Error("ATTACHMENT_TOO_MANY");
        attachment = await input.importAttachment(canonical);
        imported.set(canonical, attachment);
        attachments.push(attachment);
      }
      // Preserve captions, but don't leave a machine-local URL in the message.
      replacements.push({ ...ref, text: ref.label || attachment.name });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || (error instanceof Error ? error.message : "");
      // A non-image link to a file outside the workspace, a missing path or a
      // directory is a citation, not a delivery: keep it exactly as written.
      if (!ref.image && ["ATTACHMENT_OUTSIDE_WORKSPACE", "ENOENT", "ENOTDIR", "ATTACHMENT_NOT_FILE"].includes(code)) continue;
      // A failed delivery must not remain a clickable machine-local URL on
      // another client. Keep its caption and the explicit failure notice.
      replacements.push({ ...ref, text: ref.label || path.basename(file) });
      const reason = code === "ATTACHMENT_TOO_MANY"
        ? p(`每条消息最多 ${MAX_ATTACHMENTS} 个附件`, `at most ${MAX_ATTACHMENTS} attachments per message`)
        : code === "ATTACHMENT_TOO_LARGE" ? p("文件超过大小限制", "file exceeds the size limit")
        : code === "ATTACHMENT_OUTSIDE_WORKSPACE" ? p("文件不在会话工作区内", "the file is outside the conversation workspace")
        : code === "ATTACHMENT_NOT_FILE" ? p("路径不是文件", "the path is not a file")
        : p("无法读取或保存文件", "could not read or save the file");
      failures.push(p(`附件未发送：${path.basename(file)}（${reason}）。`, `Attachment not sent: ${path.basename(file)} (${reason}).`));
    }
  }
  let content = input.content;
  for (const replacement of replacements.reverse()) content = content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
  if (failures.length) content += "\n\n" + [...new Set(failures)].join("\n");
  return { content, attachments: attachments.length ? attachments : undefined };
}
