import { p } from "../prompt-language";
/** Permanent filesystem failures need user action; repeating them cannot repair storage. */
export function retryableStoreError(error: unknown): boolean {
  const code = (error as {code?:string})?.code;
  return !["ENOSPC","EDQUOT","EACCES","EPERM","EROFS","ENOENT"].includes(code ?? "");
}
export function storeFailureReason(error: unknown): string {
  const code = (error as {code?:string})?.code;
  const reasons: Record<string,string> = {
    ENOSPC:p("磁盘空间不足，请释放空间后继续会话", "Not enough disk space; free up space and continue the conversation"),
    EDQUOT:p("存储配额已满，请增加可用空间后继续会话", "The storage quota is full; add available space and continue the conversation"),
    EACCES:p("数据目录无写入权限，请修复目录权限后继续会话", "No write permission on the data directory; fix the directory permissions and continue the conversation"),
    EPERM:p("系统拒绝写入数据目录，请检查目录访问权限后继续会话", "The system refused writes to the data directory; check the directory access permissions and continue the conversation"),
    EROFS:p("数据目录位于只读文件系统，请恢复可写存储后继续会话", "The data directory is on a read-only file system; restore writable storage and continue the conversation"),
    ENOENT:p("数据目录不存在，请恢复目录后继续会话", "The data directory doesn't exist; restore the directory and continue the conversation")
  };
  return reasons[code ?? ""] ?? `${error instanceof Error ? error.message : String(error)}`.slice(0,300);
}
