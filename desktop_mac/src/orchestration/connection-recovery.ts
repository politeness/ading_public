/** Authentication, quotas, policy denials and business failures must not be retried here. */
export function isConnectionFailure(error: string): boolean {
  if (/unauthori[sz]ed|forbidden|quota|rate.?limit|permission|审批|授权|配额|余额|登录/i.test(error)) return false;
  return /stream disconnected|websocket.*closed|connection (?:reset|closed)|ECONNRESET|ETIMEDOUT|socket hang up|network error|连接(?:中断|重置)|断流/i.test(error);
}

/**
 * The session context is full: continuing the original session will certainly keep failing; open a new session and hand the task history to the Agent again.
 * On 2026-09-18 Qoder reported "Context exceeds the limit and automatic context recovery is unavailable.
 * Run /compact or /clear, then retry.", after which ADing kept continuing the original session and the task got stuck.
 */
export function isContextOverflow(error: string): boolean {
  return /context (?:window )?(?:exceeds|exceeded|is too long|length exceeded)|exceeds? (?:the )?(?:maximum )?context|context_length_exceeded|maximum context length|prompt is too long|input is too long for requested model|run \/compact|上下文(?:已满|超出|超过|过长)/i.test(error);
}

/**
 * The app can retain a provider thread after the vendor has removed its local
 * transcript. Retrying that identifier can never succeed; rebuild from ADing's
 * durable conversation ledger instead. Keep these signatures deliberately
 * narrow so ordinary provider/business "not found" errors are not replayed.
 */
export function isProviderSessionMissing(error: string): boolean {
  return /INVALID_SESSION_IDENTIFIER|NO_SESSIONS_FOUND|invalid session identifier|no conversation found with session id/i.test(error);
}

export async function recoveryDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, {once:true});
  });
}
