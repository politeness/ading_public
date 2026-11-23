/**
 * Runs the desktop unit tests in order (`pnpm test`), stopping at the first failure, same as the old && chain.
 *
 * Tests that only hold on a specific OS are listed in macOnly: skipped on other systems, with the reason shown.
 * The tests themselves are unchanged -- they test behavior only that OS has; failing elsewhere does not indicate a problem.
 * When adding a test, consider whether it depends on the OS; if so, add it to the matching list.
 */
import { spawnSync } from "node:child_process";

const tests = [
  "test/codex-session-home.test.mjs",
  "test/message-history.test.mjs",
  "test/cloud-error-text.test.mjs",
  "test/infinite-list.test.mjs",
  "test/link-preview.test.mjs",
  "test/message-math.test.mjs",
  "test/block.test.mjs",
  "test/agent-models.test.mjs",
  "test/agent-model-relay.test.mjs",
  "test/parse.test.mjs",
  "test/control.test.mjs",
  "test/local-scheduler.test.mjs",
  "test/human-mention.test.mjs",
  "test/message-reply.test.mjs",
  "test/leader-sessions.test.mjs",
  "test/group-context.test.mjs",
  "test/permanent-mentions.test.mjs",
  "test/mention-boundaries.test.mjs",
  "test/agent-verification-queue.test.mjs",
  "test/conversation-coordination.test.mjs",
  "test/team-dispatch.test.mjs",
  "test/work-plan.test.mjs",
  "test/conversation-reliability.test.mjs",
  "test/permission-flow.test.mjs",
  "test/permission-grants.test.mjs",
  "test/permission-policy.test.mjs",
  "test/assignment-permissions.test.mjs",
  "test/user-message.test.mjs",
  "test/message-delivery.test.mjs",
  "test/scheduler-shutdown.test.mjs",
  "test/quick-conversation.test.mjs",
  "test/brainstorm.test.mjs",
  "test/team-coordination.test.mjs",
  "test/stale-input.test.mjs",
  "test/direct-chat.test.mjs",
  "test/reply-attachments.test.mjs",
  "test/conversation-concurrency.test.mjs",
  "test/steer-dedup.test.mjs",
  "test/steer-late.test.mjs",
  "test/inbox-concurrency.test.mjs",
  "test/collaboration-speed.test.mjs",
  "test/protocol-recovery.test.mjs",
  "test/proposal-reply.test.mjs",
  "test/message-retention-idle.test.mjs",
  "test/connection-recovery.test.mjs",
  "test/reconnect-continuation.test.mjs",
  "test/workspace.test.mjs",
  "test/streamjson.test.mjs",
  "test/stream-permissions.test.mjs",
  "test/process-runner.test.mjs",
  "test/lifecycle.test.mjs",
  "test/native-install.test.mjs",
  "test/download-progress.test.mjs",
  "test/desktop-app-registry.test.mjs",
  "test/agent-adapter.test.mjs",
  "test/cli-executable-refresh.test.mjs",
  "test/qwen-code.test.mjs",
  "test/new-agents.test.mjs",
  "test/acp-adaptation.test.mjs",
  "test/antigravity-adaptation.test.mjs",
  "test/codex-approval.test.mjs",
  "test/tool-loop-guard.test.mjs",
  "test/parallel-work.test.mjs",
  "test/parallel-mcp.test.mjs",
  "test/computer-tools.test.mjs",
  "test/claude-parallel.test.mjs",
  "test/shared-agent-runtime.test.mjs",
  "test/qoder-config.test.mjs",
  "test/qoder-desktop-config.test.mjs",
  "test/execution-plan.test.mjs",
  "test/parallel-routing.test.mjs",
  "test/support.test.mjs",
  "test/save-attachment.test.mjs",
  "test/support-uploader.test.mjs",
  "test/telemetry.test.mjs",
  "test/telemetry-foreground.test.mjs",
  "test/log-archive.test.mjs",
  "test/log-recovery.test.mjs",
  "test/release-channel.test.mjs",
  "test/developer-contact.test.mjs",
  "test/account.test.mjs",
  "test/machine.test.mjs",
  "test/account-profiles.test.mjs",
  "test/diagnostics.test.mjs",
  "test/skilldir.test.mjs",
  "test/knowledge-source.test.mjs",
  "test/knowledge-tools.test.mjs",
  "test/knowledge-scope-removal.test.mjs",
  "test/knowledge-sync-failures.test.mjs",
  "test/memory-notify.test.mjs",
  "test/shared-isolation.test.mjs",
  "test/skill-fallback.test.mjs",
  "test/no-session-persistence.test.mjs",
  "test/context-budget.test.mjs",
  "test/knowledge-cloud-sync.test.mjs",
  "test/args.test.mjs",
  "test/store.test.mjs",
  "test/agent-names.test.mjs",
  "test/agent-name-migration.test.mjs",
  "test/legacy-rename.test.mjs",
  "test/cloud-store.test.mjs",
  "test/cloud-push.test.mjs",
  "test/mqtt.test.mjs",
  "test/conversation-control.test.mjs",
  "test/cloud-reconciler.test.mjs",
  "test/sleep-guard.test.mjs",
  "test/sleep-gate.test.mjs",
  "test/remote-message.test.mjs",
  "test/shared-agent-message.test.mjs",
  "test/unread.test.mjs",
  "test/seed.test.mjs",
  "test/readiness.test.mjs",
  "test/readiness-refresh.test.mjs",
  "test/app-update.test.mjs",
  "test/app-install.test.mjs",
  "test/i18n.test.mjs",
  "test/prompt-language.test.mjs"
];

/** Tests that only hold on macOS, with the reason */
const macOnly = {
  "test/download-progress.test.mjs": "uses the macOS downloader's /usr/bin/curl to test response headers and resumable downloads",
  "test/native-install.test.mjs": "the native CLI installer uses macOS curl, ditto and hdiutil",
  "test/permission-flow.test.mjs": "computer-use tools are only provided to agents on macOS",
  "test/codex-approval.test.mjs": "computer-use tools are only provided to agents on macOS",
  "test/computer-tools.test.mjs": "computer-use tools are only provided to agents on macOS",
  "test/qoder-desktop-config.test.mjs": "reading the Qoder desktop config uses macOS built-in /usr/bin/sqlite3"
};

const onMac = process.platform === "darwin";
const skipped = [];
let passed = 0;
for (const test of tests) {
  if (!onMac && macOnly[test]) {
    skipped.push(test);
    continue;
  }
  const result = spawnSync(process.execPath, [test], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n${test} failed (${result.status ?? result.signal})`);
    process.exit(result.status || 1);
  }
  passed++;
}
for (const test of skipped) console.log(`Skipped ${test}: macOS only (${macOnly[test]})`);
console.log(`\nUnit tests: ${passed} files passed${skipped.length ? `, ${skipped.length} macOS-only skipped` : ""}`);
