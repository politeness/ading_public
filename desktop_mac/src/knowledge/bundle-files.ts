import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir, readFile, mkdir, writeFile, open, rename, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { p } from "../prompt-language";

export interface PackageFile { path: string; bytes: Uint8Array; mode?: number }
const MAX_BYTES = 256 * 1024 * 1024;
const fail = (zh: string, en: string): never => { throw new Error(p(zh, en)); };
export function safePackagePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[a-z]:/i.test(value) || value.split("/").some(part => !part || part === "." || part === ".."))
    return fail("技能包包含不安全的文件路径", "The skill package contains an unsafe file path");
  return value;
}
export function validatePackageFiles(files: PackageFile[]): void {
  const seen = new Set<string>(); let total = 0;
  for (const file of files) {
    safePackagePath(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) fail("技能包包含重复文件路径", "The skill package contains duplicate file paths");
    seen.add(key); total += file.bytes.byteLength;
    if (key === ".ading-managed" || key.startsWith(".ading-managed/") || key === ".ading-meta.json") fail("技能包使用了阿钉保留文件名", "The skill package uses a reserved ADing file name");
  }
  for (const file of files) {
    const parts = file.path.split("/"); parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/").normalize("NFC").toLowerCase())) fail("技能包的文件与目录路径冲突", "The skill package has conflicting file and directory paths");
      parts.pop();
    }
  }
  if (!files.some(file => file.path === "SKILL.md")) fail("技能包根目录缺少 SKILL.md", "The skill package root is missing SKILL.md");
  if (total > MAX_BYTES || files.length > 10000) fail("技能包超过大小限制", "The skill package exceeds the size limit");
}
export function packageManifest(files: PackageFile[]): SkillPackageSource["files"] {
  return files.map(file => ({ path: file.path, size: file.bytes.byteLength, sha256: createHash("sha256").update(file.bytes).digest("hex"), mode: (file.mode ?? 0o644) & 0o777 })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function fingerprintPackageFiles(files: PackageFile[]): string {
  return createHash("sha256").update(JSON.stringify(packageManifest(files))).digest("hex");
}
export async function readPackageDirectory(source: string): Promise<PackageFile[]> {
  const files: PackageFile[] = []; let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const ds = await lstat(dir);
    if (ds.isSymbolicLink() || !ds.isDirectory()) fail("技能包不允许符号链接或特殊文件", "Skill packages do not allow symbolic links or special files");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      safePackagePath(rel);
      const full = path.join(dir, entry.name); const st = await lstat(full);
      if (st.isSymbolicLink()) fail("技能包不允许符号链接", "Skill packages do not allow symbolic links");
      if (st.isDirectory()) await walk(full, rel);
      else if (st.isFile()) {
        total += st.size;
        if (total > MAX_BYTES || files.length >= 10000) fail("技能包超过大小限制", "The skill package exceeds the size limit");
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { files.push({ path: rel, bytes: await handle.readFile(), mode: st.mode & 0o777 }); } finally { await handle.close(); }
      } else fail("技能包不允许特殊文件", "Skill packages do not allow special files");
    }
  };
  await walk(source, ""); return files;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function readPackageZip(bytes: Buffer): PackageFile[] {
  let eocd = -1;
  for (let pos=bytes.length-22;pos>=Math.max(0,bytes.length-65557);pos--) if (bytes.readUInt32LE(pos)===0x06054b50 && pos+22+bytes.readUInt16LE(pos+20)===bytes.length) { eocd=pos; break; }
  if (eocd<0) fail("技能 ZIP 文件损坏", "The skill ZIP archive is invalid");
  const count=bytes.readUInt16LE(eocd+10), size=bytes.readUInt32LE(eocd+12), start=bytes.readUInt32LE(eocd+16);
  if (bytes.readUInt16LE(eocd+4) || bytes.readUInt16LE(eocd+6) || bytes.readUInt16LE(eocd+8)!==count || count===65535 || start+size!==eocd) fail("不支持此技能 ZIP 格式", "This skill ZIP format is unsupported");
  const files: PackageFile[]=[]; const seen=new Set<string>(); let pos=start, total=0;
  for(let i=0;i<count;i++) {
    if(pos+46>eocd || bytes.readUInt32LE(pos)!==0x02014b50) fail("技能 ZIP 文件损坏", "The skill ZIP archive is invalid");
    const flags=bytes.readUInt16LE(pos+8), method=bytes.readUInt16LE(pos+10), crc=bytes.readUInt32LE(pos+16), compressed=bytes.readUInt32LE(pos+20), uncompressed=bytes.readUInt32LE(pos+24), nameSize=bytes.readUInt16LE(pos+28), extra=bytes.readUInt16LE(pos+30), comment=bytes.readUInt16LE(pos+32), attrs=bytes.readUInt32LE(pos+38), offset=bytes.readUInt32LE(pos+42);
    const end=pos+46+nameSize+extra+comment;
    if(end>eocd || flags&0x41 || ![0,8].includes(method) || bytes.readUInt16LE(pos+34)!==0) fail("不支持此技能 ZIP 格式", "This skill ZIP format is unsupported");
    const raw=bytes.subarray(pos+46,pos+46+nameSize); const name=raw.toString("utf8");
    if (!Buffer.from(name,"utf8").equals(raw)) fail("技能 ZIP 的文件名编码无效", "The skill ZIP archive has invalid filename encoding");
    const isDir=name.endsWith("/"); const rel=safePackagePath(isDir ? name.slice(0,-1) : name);
    const key=rel.normalize("NFC").toLowerCase();
    if(seen.has(key)) fail("技能 ZIP 包含重复条目", "The skill ZIP archive contains duplicate entries"); seen.add(key);
    const type=(attrs>>>16)&0o170000;
    if(type && type!==0o100000 && type!==0o040000) fail("技能 ZIP 不允许符号链接或特殊文件", "Skill ZIP archives do not allow symbolic links or special files");
    if((type===0o040000 && !isDir) || (type===0o100000 && isDir)) fail("技能 ZIP 的文件类型与路径不一致", "The skill ZIP entry's file type does not match its path");
    if (isDir && uncompressed) fail("技能 ZIP 目录条目无效", "The skill ZIP archive has an invalid directory entry");
    if(offset+30>start || bytes.readUInt32LE(offset)!==0x04034b50) fail("技能 ZIP 文件损坏", "The skill ZIP archive is invalid");
    const ln=bytes.readUInt16LE(offset+26), le=bytes.readUInt16LE(offset+28), data=offset+30+ln+le;
    if(data+compressed>start || !bytes.subarray(offset+30,offset+30+ln).equals(raw) || bytes.readUInt16LE(offset+8)!==method || bytes.readUInt16LE(offset+6)!==flags) fail("技能 ZIP 文件损坏", "The skill ZIP archive is invalid");
    total+=uncompressed;
    if(total>MAX_BYTES || count>10000) fail("技能包超过大小限制", "The skill package exceeds the size limit");
    const packed=bytes.subarray(data,data+compressed); const output=method===0 ? packed : inflateRawSync(packed,{maxOutputLength:MAX_BYTES});
    if(output.length!==uncompressed || crc32(output)!==crc) fail("技能 ZIP 校验失败", "Skill ZIP verification failed");
    if(!isDir) files.push({path:rel,bytes:output,mode:((attrs>>>16)&0o777)||0o644});
    pos=end;
  }
  if(pos!==eocd) fail("技能 ZIP 文件损坏", "The skill ZIP archive is invalid");
  // Common archives wrap one complete package in a single directory.
  if(!files.some(f=>f.path==="SKILL.md")) {
    const root=files[0]?.path.split("/")[0];
    if(root && files.every(f=>f.path.startsWith(`${root}/`)) && files.some(f=>f.path===`${root}/SKILL.md`)) for(const file of files) file.path=file.path.slice(root.length+1);
  }
  validatePackageFiles(files); return files;
}
export async function readSkillPackage(source: string): Promise<PackageFile[]> {
  const st=await lstat(source);
  if(st.isSymbolicLink()) fail("技能来源不允许符号链接", "Skill sources do not allow symbolic links");
  if(st.isFile() && st.size>MAX_BYTES) fail("技能包超过大小限制", "The skill package exceeds the size limit");
  const files=st.isDirectory() ? await readPackageDirectory(source) : st.isFile() && /\.zip$/i.test(source) ? readPackageZip(await readFile(source)) : fail("请选择技能目录或 ZIP 文件", "Choose a skill directory or ZIP archive");
  validatePackageFiles(files); return files;
}
export async function writePackageCandidate(target: string, files: PackageFile[]): Promise<void> {
  validatePackageFiles(files); await mkdir(target, { recursive: false });
  try {
    for(const file of files) {
      const destination=path.join(target,file.path); await mkdir(path.dirname(destination),{recursive:true});
      await writeFile(destination,file.bytes,{flag:"wx",mode:(file.mode??0o644)&0o777});
      await chmod(destination,(file.mode??0o644)&0o777);
    }
    if(fingerprintPackageFiles(await readPackageDirectory(target))!==fingerprintPackageFiles(files)) fail("技能候选文件校验失败", "Skill candidate file verification failed");
  } catch(error) { await rm(target,{recursive:true,force:true}); throw error; }
}
export async function replaceDirectory(candidate: string, target: string): Promise<void> {
  const backup=`${target}.ading-backup-${randomUUID()}`; let had=false;
  try { await lstat(target); had=true; } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  if(had) await rename(target,backup);
  try { await rename(candidate,target); } catch(error) { if(had) await rename(backup,target); throw error; }
  if(had) await rm(backup,{recursive:true,force:true});
}
