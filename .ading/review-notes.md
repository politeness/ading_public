# For reviewers: these are load-bearing

Why the code is written the way it is is explained in comments in place. This file only lists things that **break silently if changed and are hard to catch in tests**.
Skim this list before reading the diff.

## Conversation model

- **One task = one piece of work**, not "a chat window with someone". You can open several with the same Agent at once.
  So `createConversation` **deliberately has no idempotency**, and the backend `conversations` table deliberately has no member-pair fingerprint.
  Anyone who "just adds dedup" turns the model back into chat windows. `TaskTypeTest` pins this down.
- **One task × one Agent = one independent thread**, never reused across tasks. This is the basis for "different conversations never cross-talk".
- **A task can have only one LEADER**. The demotion in `setMemberRole` is not defensive code, it is an invariant:
  with two LEADERs, whoever `buildPrompt` finds depends on array order, and the control block lets both through.

## Permissions and sandbox

- The review/summary round is always `fullAccess: false`. **This guarantee has not been verified on a real machine yet** —
  whether `codex exec resume` inherits the permissions of the round that created the session is unknown. So there is an escape alert:
  if a read-only round reports side effects, it shouts in the group. **Don't delete that alert as noise.**
- In unattended mode (`--headless`), `ask` degrades to read-only. A dialog nobody can click is not "waiting for confirmation", it is a hang.
- The task list does not grant `always` by default. If it is granted, a human should change it themselves; code should not escalate privileges on their behalf.

## Memory and skills

- Only humans can write the `user` layer. An agent that concludes "the boss likes X" after two remarks would have that follow the person into every conversation.
  The throw in `LocalStore.appendMemory` is a hard constraint.
- "Ad hoc" workspaces (`kind: inbox`) **have no shared fact pool**. Their conversations are unrelated; sharing would just be another path to cross-talk.
- Skills go through peer review; facts go straight into the store. The boundary is not arbitrary: a skill is "always do it this way from now on" (if wrong, the impact persists),
  a fact is "this project is like this" (verifiable, small blast radius, obvious to a human at a glance).
- **codex and Qoder read the same `AGENTS.md`**. So the sync layer groups by **target file** and writes each file only once.
  If it goes back to writing per agent, the two overwrite each other's managed blocks, and the result differs every round.
- Claude Code skills live in the `.claude/skills/` directory. Deletion **must satisfy both** conditions:
  the directory name starts with `ading-` **and** it contains a `.ading-managed` marker. Missing either one may delete the user's own skills.

## Front-end pitfalls

- `renderer.ts` is loaded via `<script type="module">` and compiled by `tsconfig.renderer.json` into browser ES modules; it cannot import Node.js modules or CommonJS `require`. The main process and preload are built separately.
- `el("#x")` throws if the element is not found, and the whole UI goes blank. When adding an id, remember to change both sides.
- The title bar is a draggable region; buttons inside it must have `-webkit-app-region: no-drag`, or they can't be clicked.

## Ones I've stepped on myself

- When using two `s.index()` calls to locate a span of text to delete, **assert `end > start` first**.
  If the order is reversed it won't error; it will **duplicate** the span in between. I hit this twice on `index.html`, duplicating 600+ lines of CSS each time.

## Verification

`pnpm test` runs the core checks, `pnpm test:regressions` runs the regression checks, and `pnpm test:ui` runs the Electron UI checks. Environments that can't run Electron (e.g. Linux) can still run everything, because the orchestration layer is pure Node.
Anything that needs a real machine (launching Electron, running the three CLIs) can only be verified on macOS; logs are in `.ading/last-run.log`.
