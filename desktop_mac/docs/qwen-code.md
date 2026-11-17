# Qwen Code adapter

The adapter targets Qwen Code CLI 0.26.1. The CLI is distinct from Qwen chat and
Qwen Code Desktop. The configuration source is native Qwen settings, shared by Desktop 0.26.1 provider setup and its bundled CLI; unsaved composer state is not assumed to be synchronized. Source checked: [QwenLM/qwen-code v0.26.1](https://github.com/QwenLM/qwen-code/tree/v0.26.1),
commit `b475278c4a300acebe6cfc990a9e1b1d18819bfc`.

## Installation and authentication

```sh
npm install -g --prefix ~/.local @qwen-code/qwen-code
qwen --version
qwen
```

ADing first installs the official Qwen Code Desktop App and reuses its bundled CLI. Login opens the App for provider setup and asks the user to return and check connectivity; opening the App alone is not authentication success. The commands above are the standalone CLI alternative.

Configure a provider with `/auth` inside the interactive CLI. Version 0.26.1 has
removed the standalone `qwen auth` command. ADing therefore displays instructions
instead of invoking an obsolete command or treating its zero exit code as a
successful login. There is no advertised standalone logout action.

Discovery probes the executable, including `~/.local/bin/qwen`. Verification uses
an isolated directory, safe mode, disabled tools, a zero tool-call budget, disabled
chat recording, and the existing macOS health-check sandbox. The real CLI reported
missing authentication on the development machine; external model completion has
not been verified.

## Execution and configuration

- Uses the shared `ExecutionAgent`, `ParallelExecutor`, stream parser, process
  cancellation and permission channel. Qwen-specific flags use `--approval-mode`,
  `--channel=SDK`, stream JSON and `--resume`.
- Reads JSON/JSONC CLI system defaults, user settings under `QWEN_HOME` or `.qwen`,
  workspace settings according to native folder trust, and system overrides.
  Model selection precedes auth-specific process environment model variables.
  Project `.env` loading and provider-specific generation options remain the CLI's
  responsibility; observed model events are reported separately from selections.
- ADing overrides use the shared configuration precedence. Reasoning tiers are
  passed in the SDK initialization request; an explicit rejected tier fails before
  the user prompt. Native `none` is accepted only when the CLI settings already disable reasoning; the SDK cannot apply a new `none` override. `fastModel` is an
  auxiliary model, not a Fast service tier: no Fast flag is invented. Explicit
  Fast=true or service-tier overrides are unsupported.
- Read-only and discussion runs use safe mode and exclude Qwen 0.26.1's non-read
  tools, including plan-file writes and shell tools that native plan mode alone
  can permit. Discussion runs additionally exclude the file-reading tools.
- Converts the shared MCP HTTP URL to Qwen's `httpUrl` field. The same loopback
  bridge serves scoped knowledge, shared parallel work and background computer
  tools. Qwen can defer MCP schemas until tool discovery; absence from the first
  model request is not evidence that the tool is unavailable.
- Native child messages cannot replace the parent session, final answer or model
  snapshot, or close the parent's input channel.
- Skills use `.qwen/skills` and the existing full-package ownership-safe sync.
  Memory replicas use `.qwen/ading-memories/qwen-code` and retain scope isolation.

## Validation

- `pnpm build`, `pnpm test` (73 files), `pnpm test:regressions`, existing complete
  `pnpm test:ui` suite, plus `test/qwen-ui.test.cjs` in Chinese and English.
- `test/qwen-code.test.mjs`: configuration precedence/trust/JSONC/corruption,
  native flags, unsupported Fast, auth classification, parent/child output
  ownership, resume, permission allow/deny, cancellation, skill update/withdrawal,
  user-file protection and scoped memory cleanup.
- `test/parallel-routing.test.mjs` includes Qwen in direct/group shared routing.
- `node test/qwen-native.test.mjs /absolute/path/to/qwen`: installed CLI against
  a loopback OpenAI-compatible fixture, with isolated settings and automatic
  cleanup. Covers real protocol handshake, reasoning initialization, restricted
  tool schemas, resume, approved/denied file writes, MCP knowledge/parallel/
  computer dispatch and cancellation. The computer helper is a fixture; this
  does not claim new macOS GUI permission or real GUI operation verification.
- Backend `mvn -Dtest=AgentServiceTest test`; iOS simulator Debug compilation.

The cloud accepts the new `QWEN_CODE` type after deploying the corresponding
backend change. Existing installed desktop/mobile applications also need an
updated build. No package, deployment, version increment, commit or push is part
of this implementation.

## Icon provenance

The desktop and iOS Qwen icons are unchanged copies of
`packages/live-host/resources/icon.png` in the official source revision above
(Apache-2.0 repository). They were copied during this implementation, not generated.

## October 28 validation

The official Desktop 0.26.1 bundled CLI passed local-model-server integration tests for handshake, observed model, reasoning payload, session resume, approved/denied writes, restricted tools, MCP knowledge/parallel/computer dispatch and cancellation. Same-name providers are distinguished by native `model.baseUrl`: ADing omits redundant `--model` to preserve that selection, while explicit different-model overrides remain supported. Native reasoning aliases and runtime model IDs are normalized consistently. This is real CLI protocol validation against a controlled server, not an authenticated external-provider business test.
