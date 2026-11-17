# Kiro, Copilot and Antigravity adapters

Validation date: 2026-10-28. These adapters are included in the upcoming pre-release; authenticated production model calls remain unverified as noted below.

## Installed CLI versions

| Agent | Version | Transport | Sign-in |
| --- | --- | --- | --- |
| Kiro | 2.34.2 | ACP v1 with explicit `--agent-engine=v2` | `kiro-cli login` |
| GitHub Copilot | 1.0.104 | ACP over stdio | `copilot login --device-code` |
| Antigravity | 1.4.8 | Native stream-json stdin/stdout | Interactive `agy` |

Installation prefers official CLIs and reuses an already usable runtime, including one bundled with an existing App. It does not require a desktop App download. Codex, Claude Code, Qoder, Qoder CN, Qwen Code and Copilot use their official npm packages; Kiro and Antigravity CLI downloads verify official manifest hashes. Existing applications, configuration and authentication are preserved.

## Implementation

All three use the existing `ExecutionAgent` pipeline, shared parallel scheduler, central knowledge tools and process ownership. Backend registration, desktop catalog, Chinese/English names, icons and iOS agent types include all three. Native adapters own transport differences; they do not implement another scheduler or use another vendor to perform the task.

ACP routes updates and approvals by session ID, ignores replay while loading, responds with offered one-time permission choices, restores sessions and closes the owned process on cancellation. Kiro uses a unique temporary agent profile per execution lane. Copilot applies tool and effort flags at ACP server startup. Models returned in ACP metadata are observed values; a launch argument alone is not recorded as a confirmed model.

Antigravity uses its documented PreToolUse hook to obtain ADing's decision. It never launches with `--dangerously-skip-permissions`. A reference-counted workspace lease adds owned entries to `.agents/hooks.json` and `.agents/mcp_config.json`. Each process gets separate authenticated loopback endpoints through its environment. Last release restores untouched original files or removes only unchanged owned entries while preserving concurrent user changes. User-owned entry-name conflicts and symlinks fail explicitly. If cleanup finds malformed or redirected configuration, it leaves that file untouched, retains the helper and reports the path instead of removing a referenced script. Read-only calls are restricted to known file/search tools; discussion calls deny tools. The native CLI's own policy can still deny a call.

Shared MCP provides knowledge, parallel work and computer tools when enabled by the existing pipeline. The stdio helper forwards to that same service. Installer and execution paths have cancellation and bounded process lifetime. In-flight steering is explicitly unsupported; subsequent turns resume the original session. Internal session-free `askOnce` is unsupported to avoid hidden task-naming sessions. Explicit connection checks can create native probe sessions after login because these CLIs lack a verified no-save mode.

## Native configuration and skills

| Agent | Model selection read | Effort | Global / workspace skill directories |
| --- | --- | --- | --- |
| Kiro | Effective `kiro-cli settings chat.defaultModel --format json` | Selected model's `chat.modelDefaults` via the native CLI; explicit `--effort` | `~/.kiro/skills` / `.kiro/skills` |
| Copilot | `COPILOT_MODEL`, then `$COPILOT_HOME/settings.json` or `~/.copilot/settings.json` | Explicit `--reasoning-effort`; native persisted effort not verified | `$COPILOT_HOME/skills` or `~/.copilot/skills` / `.github/skills` |
| Antigravity | `model` label from `~/.gemini/antigravity-cli/settings.json` | Explicit `--effort`; native `/effort` persists a model variant | `~/.gemini/antigravity-cli/skills` / `.agents/skills` |

ADing explicit field overrides take precedence; explicit `Fast=false` is retained. None of these adapters maps a separate Fast service tier. `Fast=true` and service-tier overrides return a diagnostic. Fast-named models and Antigravity `/boost` are not equivalent to a Fast service switch. Missing configuration stays unspecified; malformed configuration produces a visible diagnostic. Native defaults not exposed by documented settings remain native defaults, not a claimed synchronized selection. Actual authenticated model/effort verification remains pending.

Skills use the existing complete-package writer and owner markers. Memory copies use existing central knowledge scopes and vendor-specific directories. No central knowledge was replaced by vendor copies.

## Verification and remaining limits

Automated coverage includes ACP creation/resume, parent-versus-child output ownership, replay suppression, normal allow/deny, discussion/read-only/unattended policies, MCP dispatch, cancellation and busy-state cleanup. Antigravity fixtures test documented NDJSON, incomplete output, session restoration, cancellation, actual helper execution, bridge authentication, parallel lane isolation, idempotent release, immediate reacquisition and preservation of concurrent config edits. Configuration fixtures cover model changes, selected-model effort, partial overrides, `Fast=false`, missing/corrupt settings and secret exclusion. Skill ownership and all three memory scopes use the shared writers. Shared parallel-routing tests include all three kinds.

Validation passed: 75 desktop unit-test files, the full desktop UI suite, architecture/runtime/handshake/recovery/probe regressions, and 5 AgentService tests (zero failures, errors or skips). Targeted protocol and shared-routing tests were repeated after the final adapter changes. AgentService registration tests pass for the new cloud types. iOS simulator-target compilation passes; there is no installed simulator runtime or connected device for visual iOS validation. Desktop Chinese/English catalog screenshots were reviewed using an isolated Electron fixture running the updated renderer.

Native CLI execution was attempted, not inferred from mocks: Kiro exits with a sign-in requirement; Copilot's real `initialize` reports ACP v1, session loading and HTTP MCP, then rejects session creation as unauthenticated; Antigravity reports authentication required. Therefore authenticated replies, real tool approvals, actual selected models, real MCP invocation by the model, browser/computer use, file/image work and single/group-chat business workflows are **not yet verified**. Fake protocol tests do not prove those native capabilities. Complete these checks after account authorization before declaring the adapters production-ready.

## Primary references and asset provenance

- [Kiro ACP](https://kiro.dev/docs/cli/acp/) and [v2/v3 differences](https://kiro.dev/docs/cli/v3/acp-migration/)
- [Kiro effort and settings](https://kiro.dev/docs/models/effort/)
- [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [Copilot model precedence](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- [Antigravity headless protocol](https://antigravity.google/docs/cli/headless), [hooks](https://antigravity.google/docs/hooks), [settings schema](https://antigravity.google/schemas/v1/settings.json) and [CLI skill locations](https://antigravity.google/docs/skills)
- Kiro icon: official `https://kiro.dev/apple-icon.png`.
- Antigravity icon: official `https://antigravity.google/assets/image/antigravity-logo.png`.
- Copilot icon: GitHub Primer Octicons `icons/copilot-24.svg`, rendered as PNG; [MIT license](https://github.com/primer/octicons/blob/main/LICENSE). Vendor marks identify the corresponding products and remain their owners' trademarks.

## October 28 adaptation fixes

ACP supports standard `configOptions` and `config_option_update` for model and thought level alongside older model metadata. Dependent options are re-read after a model change and server responses are checked before sending the task. Antigravity preserves startup ERROR events with empty conversation IDs, tool failures and native cancellation states.

Kiro authentication status uses its native `whoami --format json`. Copilot successful login is followed by the existing single model verification, without a duplicate status model request. Device codes and URLs remain visible in each Agent row until the login completes or is cancelled; reopening the panel retains active instructions.

Dedicated `acp-adaptation.test.mjs` and `antigravity-adaptation.test.mjs` cover these changes. Real Copilot initialize/session creation and Kiro whoami confirm the current machine is not authenticated; isolated real Antigravity execution confirms its authentication-error protocol. This does not establish authenticated business end-to-end success.
