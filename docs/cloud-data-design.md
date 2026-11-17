# Online Edition Data Design (Cloud Is Authoritative After Login)

**Status: design draft.** The five questions in Section 8 have been confirmed. Once you have reviewed this version and confirmed it, it will be implemented in phases,
and each phase must run end to end on the NAS before moving on to the next.

---

## 1. Principles Already Settled

1. **When not logged in it is the standalone edition and local data is authoritative; after login it is the online edition and cloud data is authoritative.**
2. **The two sides' data are completely isolated and never shared, as if they were two accounts.** After login you cannot see standalone data; after logout you cannot see account data.
3. **The only exception: on first login, the user can choose to import standalone data into this account.** It is copied, not moved; standalone data stays as it is.
4. **Standalone features must not be harmed by the online edition.** All existing standalone tests must keep passing.
5. **The standalone and online editions differ only in how data is stored; business logic shares one codebase.**
   Rules for agent identity, installation status, detection and scheduling are exactly the same on both sides and implemented only once;
   the two data-layer implementations (LocalStore / CloudStore) only handle storage and retrieval and do not each carry business rules.
   When a defect is found in existing standalone logic, fix it directly in the shared code; do not let the two sides diverge.
6. **The app is layered MVC, and the data layer can be reloaded at runtime.** On login and logout the app does not quit or restart; if it takes time, a waiting screen is shown.
   Agents running at the time of the switch **stop immediately, without waiting to wrap up**, and the user is warned about this before logging in.
7. **Agents are bound to computers.** The same kind of agent on different computers (for example, both codex) are different agents and different contacts.
   Computers are identified by a **unique ID**, not by computer name (computer names may collide).
8. **No migration of old data.** There are no production users yet, so when the data structure or identifiers change, existing data is simply wiped
   (standalone data on this machine, the NAS development database). ECS is not touched.
9. During development the backend is deployed only to the NAS.

---

## 2. Overall Approach

### 2.1 Execution stays on this machine; the cloud only manages data

Agents run on the user's own computer; that does not change. The conductor is a **data hub, not an execution hub**
(consistent with the boundary described in `conductor/README.md`).

The early placeholder code in `src/store/remote.ts` and `conductor/docs/desktop-integration.md` envisioned
"the server handles online scheduling, and desktop nodes only execute turns dispatched by the server". That path would replace standalone scheduling entirely,
and it conflicts with principles 4 and 5: the standalone edition has no server, so scheduling must stay local; adding another one on the server means two sets of scheduling rules coexisting, which will eventually diverge.
**This design does not take that path**, and both of those were deleted with this implementation. Work dispatched from phones and other clients goes through "write cloud data + push notification + local scheduler dispatch"
(see `desktop_mac/test/remote-message.test.mjs`), so there is always only one set of scheduling code.

### 2.2 Only one new data-layer implementation is added; upper layers are unchanged

All desktop data reads and writes go through the `Store` interface (`src/store/store.ts`).
Verified: the scheduling layer (161 sites in `local-scheduler.ts`, 24 in `work-plan.ts`, 13 in `brainstorm.ts`)
reads and writes entirely through Store and never bypasses it to touch data files directly.

So the online edition only needs a new **`CloudStore`** (implementing the same `Store` interface).
`LocalScheduler`, `SkillSyncer`, `SkillCapture` and the UI code all stay unchanged:

| Login state | Data layer | Local directory |
| --- | --- | --- |
| Not logged in | `LocalStore` (existing, unchanged) | `userData/data/` |
| Logged in | `CloudStore` (new) | `userData/accounts/<account userId>/` (cache of cloud data and the pending-sync queue) |

When different accounts log in on the same computer, their cache directories are naturally isolated, so data does not leak between them.

### 2.3 On login / logout, reload the data layer in-process

Today the store, scheduler, skill sync, skill capture and permission review are each created once at startup,
hold references to each other, and cannot be replaced individually. This must become a structure that **can be closed and rebuilt**.

**Data session (DataSession)**: package "one set of data and the components that depend on it" into one object:

```
DataSession
  ├─ store            LocalStore or CloudStore
  ├─ scheduler        scheduler
  ├─ syncer           skill sync
  ├─ capture          skill capture
  ├─ permission review the part that depends on store
  └─ event subscriptions store → UI pushes (must be cancellable on close)
  open()   build the components above according to login state
  close()  immediately terminate running agents (without waiting for them to wrap up), cancel subscriptions, close the store
```

The main process holds only the "current data session". IPC handlers fetch the store and scheduler from the current session every time,
instead of referencing global variables assigned once at startup.

**Switch flow (the process and window stay up throughout):**

```
User confirms login / logout
  → UI shows a waiting overlay (spinner + "Switching to online edition…" / "Returning to standalone edition…")
  → Main process: oldSession.close()  — running agents are terminated immediately, without waiting to wrap up
  → Main process: build a new session for the new login state and open() it
       First open of the online edition: full pull from the cloud when there is no cache
  → Notify the UI "data reloaded"
  → UI clears old state, runs bootstrap again to fetch data, and closes the overlay
```

- IPC requests that depend on data and arrive during the switch: handled after the switch completes, so they never read half-old, half-new data.
- Switch failure (for example, the new session fails to open): stay in the original mode, close the overlay and show the reason; **it must never be left in a state that is neither standalone nor online**.
- Parts that do not belong to the data session stay untouched: windows, agent discovery and availability detection, the upload queue for support features, and logs.

**How running agents are handled:**

- On switch they are **terminated immediately**: the agent's process group is killed directly, without waiting for it to finish the current turn.
- The interrupted turn produces no reply. Messages already written into the conversation are unaffected and the conversation itself is not lost;
  when returning to that mode later, the user can continue in the conversation.
- **Warning before login**: when the login dialog opens and agents are running, show above the "Log in" button:
  "After login you'll switch to the online edition, and the N running agents will be stopped immediately."
  This line is not shown when no agents are running.
- The logout confirmation dialog states the same thing when agents are running (logging out also switches the data session).

---

## 3. How "Cloud Is Authoritative" Works (CloudStore)

### 3.1 Reads

- Read the local cache first so the UI has content immediately; pull increments from the cloud in the background and refresh the UI if anything changed.
- On first login, on a new computer, or when the cache is corrupted, do a full pull from the cloud to rebuild the cache. **A synced cache can be deleted at any time and fully restored.**

### 3.2 Writes: online

- ~~Write to the cloud first, then update the cache and notify the UI on success.~~
- **Adjusted during implementation on 2026-09-14: online and offline take the same path — write the local cache first and notify the UI immediately, while also enqueueing into the pending-sync queue, which is replayed to the cloud right away.**
  Reason: business rules (Leader assignment, member pause, message sequence numbers, etc.) are implemented only once in LocalStore; CloudStore wraps it as a cache
  instead of writing another set (principle: both editions share logic); the UI and scheduler also don't have to wait for the network.
  When online the queue usually drains within tens of milliseconds, which is effectively the same as "write to the cloud first"; if it can't upload, it automatically becomes the offline handling of 3.3.
- The queue keeps only one "sync it" entry per conversation or workspace: on replay it reads the latest state from the cache and reconciles with the cloud item by item (create if missing; fill in fields, members,
  read and processed watermarks). Each message is replayed individually.
- In phase 1 only one computer writes, so the message `seq` assigned by the cloud should match the local one; on mismatch, log it first (`cloud-seq-mismatch`) and handle it in phase 2 with multiple computers.

### 3.3 Writes: offline (stay logged in and keep working)

The user can stay logged in and keep using the online edition while offline:

- **All writes take effect as usual**: they are written to the local cache first and also recorded in the **pending-sync queue** (in order of occurrence), and the UI shows the result immediately.
  The UI marks unsynced content as "pending sync".
- Agents keep running locally (as long as the agents themselves can reach the network), and the replies and status changes they produce also go into the same queue.
- **Once back online, the queue is replayed to the cloud in order**, and the "pending sync" marks are cleared after everything succeeds.

**Replay rules:**

| Operation | How to guarantee no duplicates and no reordering |
| --- | --- |
| Create (conversation, message, skill, etc.) | The ID is generated locally and used as the idempotency key. The backend message API is already idempotent by `messageId`; other create APIs are implemented the same way |
| Update | Each operation carries a unique operation ID and the backend deduplicates by it; updates to the same object are replayed in order of occurrence, and the later write wins |
| Delete | Replay the delete; if the object no longer exists in the cloud, treat it as success |
| Message sequence numbers | Messages sent offline are first sorted and displayed locally with temporary sequence numbers; after replay they are re-sorted by the server-assigned `seq` |

**When the cloud rejects a replay** (for example, the conversation was deleted on another computer while offline, but messages were still sent to it here):
discard the operation, record it in the sync log, show a one-time UI notice "N changes could not be synced because the cloud data changed",
and allow viewing which ones they were. These are not retried, otherwise they would keep failing.

### 3.4 Logging out while offline

- **Logout is allowed.** It must be explicitly confirmed first:
  "Log out? You'll return to the standalone edition."
- If there are unsynced changes, the confirmation dialog must say so clearly:
  "N changes haven't been synced to the cloud. They'll stay on this computer and sync automatically the next time you log in to this account."
- The pending-sync queue lives in that account's own cache directory and is not deleted on logout.
- **Logging out while online also requires confirmation**, with the unsynced sentence removed from the prompt.

### 3.5 Push and catch-up pulls

- Change notifications are received via MQTT (see `conductor/docs/mqtt.md`).
- Message continuity is judged by `seq`: if a received `seq` is not the local maximum + 1, catch up by pulling with `afterSeq`.
  The backend `MessageWriter` assigns numbers under a conversation row lock, guaranteeing `seq` has no gaps.
- After reconnecting, replay the pending-sync queue first, then catch up; catch-up and received pushes share the same code path.

---

## 4. Agents in the Online Edition: Bound to Computers

### 4.1 Identity

- **Each agent belongs to one computer.** Online-edition agents have one extra attribute, the owning computer, recorded directly on the agent (`users.terminal_id`). One computer to many agents is one-to-many, so no relation table is needed.
- **The same kind of agent on different computers are different agents.** codex on the MacBook and codex on the iMac are two contacts,
  each with its own nickname, persona and permission level.
- A computer registers in the cloud once (`POST /terminals/register`, idempotent by the computer's unique ID).

**Computers are identified by a unique ID, not by computer name.** Computer names may collide and may be changed by the user; they are only for display.

- **The unique ID is the macOS hardware UUID** (`IOPlatformUUID`). Before upload it is prefixed with an ADing-specific prefix and hashed with SHA-256;
  the server stores only the hash and never sees the raw hardware identifier.
- **An app-generated random UUID is not used**, for two reasons: the ID changes after deleting app data or reinstalling;
  and when Migration Assistant moves an old Mac's data to a new Mac, that ID is copied over as is, so the two computers end up with the same ID.
- **When the hardware UUID changes:**

  | Situation | Changes? | Result |
  | --- | --- | --- |
  | Replacing memory, disk, battery or screen | No | Still the same computer. Memory on Apple silicon Macs is soldered onto the chip and can't be replaced anyway |
  | Reinstalling macOS, erase-and-reinstall, OS upgrade | No | Still the same computer |
  | Moving to a new Mac with Migration Assistant | The new Mac has a new ID | Correct: the new computer is a different computer |
  | **Logic board replaced during repair** | **Yes** | Recognized as a new computer; the old computer's agents show as offline. A "merge the old computer's agents into this one" feature can be added later |
  | Virtual machine clones | May be identical | Out of scope |

- **Computer name**: defaults to the macOS "Computer Name" and can be changed in ADing; collisions do not affect identification.
- **Agent identifier: `type@computerUniqueID`, the same for standalone and online editions.**
  Each computer has only one agent of each type, so "type + computer" uniquely determines an agent.
  Agents are rediscovered on every launch and are idempotent by this identifier, so no duplicate contacts are created.
- **Replaces the current `type@hostname`**: the macOS hostname changes with the network environment (this Mac has no fixed HostName set,
  so it may be replaced by a name assigned by the network), and as soon as the hostname changes the agent is treated as a new one. The computer's unique ID is unaffected by the network.
  This is a change in shared code, and the standalone edition benefits too; per principle 8 there is no migration, old data is wiped.
- **Cloud fields**: the type is stored in `users.agent_type`; uniqueness comes from the unique index on `users`
  `(terminal_id, local_uuid)`, where `local_uuid` stores the identifier above.

### 4.2 Contact list

- Shows the agents of all computers under this account, each contact labeled with its owning computer, for example "Cody · MacBook Pro".
- Agents not on this machine are labeled "on another computer" and cannot run on this computer.

### 4.3 Execution

- **The scheduler only schedules agents on this machine.**
- When a conversation includes agents from other computers: this computer can view the conversation, view messages and send messages, but will not execute those agents;
  they are executed by the computer that owns them.
- **When a computer is offline, all agents under it count as offline**; they cannot execute and do not take part in dispatch.
  Offline is a display state computed from the computer's MQTT connection and is not written into the agent's own `users.status`;
  once the computer comes back online, the original state is restored automatically.
- This way, when the same account is logged in on several computers at once, the same agent is never executed twice.

### 4.4 Installation status: uninstalls are synced to the cloud too

When an agent is uninstalled it is **not deleted from the cloud**; its status is set to **"Not installed"**. Its nickname, persona, and the conversations and messages it took part in are all kept.

- **Where it's stored**: directly in the agent row's `users.status`, **no new field**.
  `ACTIVE` = installed; `NOT_INSTALLED` = not installed (new value, used only for agents); `DISABLED` still means disabled.
  `status` is `VARCHAR(32)`, and the code only checks it when a human logs in; agents don't log in, so adding a value doesn't affect existing logic.
- **Who reports it**: only the computer that owns the agent reports its installation status. Every time agent detection completes (at startup, on manual refresh)
  the result is synced to the cloud; when offline it enters the pending-sync queue and is filled in once back online.
- **After uninstall**: the contact remains, labeled "Not installed", and cannot execute; it also shows as not installed in the conversations it's in.
  To remove it entirely, the user deletes the contact manually.
- **Reinstall**: the same kind of agent on the same computer is matched back to the original contact, the status returns to "Installed",
  and its nickname, persona and conversation history carry on.
- **Avoid false negatives: mark not installed only when "detection completed normally and definitely found nothing".**
  If detection errors out (timeout, CLI exception), keep the original status; an agent must not be marked not installed because of one failed detection.
  The current discovery code treats both "detection error" and "not found" as an empty result (adapters return an empty list on error); the implementation must distinguish the two.

**How contacts are displayed:**

| Owning computer | Installation status | Display |
| --- | --- | --- |
| This machine | Installed | Normal, then show ready, quota exhausted, login expired, etc. per availability detection |
| This machine | Not installed | Not installed |
| Other computer, online | Installed | On another computer |
| Other computer, online | Not installed | Not installed (on "such-and-such computer") |
| Any computer, offline | Any installation status | **Offline** (offline takes precedence over other states; whether a computer is online depends on its MQTT connection) |

This installation-status logic is **the same code shared by the standalone and online editions**: the standalone edition stores the status locally, the online edition in the cloud.
The "don't change status on detection error" fix applies to the standalone edition as well.

### 4.5 How the user is addressed

Agents address the user by **nickname** (confirmed). The standalone edition uses the nickname from the standalone profile; the online edition uses the nickname from the account profile.
The prompt template text is unchanged; only the source of the name filled in changes.

---

## 5. Each Kind of Data: Cloud or Local

| Data | Where it lives in the online edition | Notes |
| --- | --- | --- |
| Own profile (nickname, avatar, phone, email) | **Cloud** `users` | Currently stored temporarily in local `account/profiles.json`; moved to the cloud in phase 1 |
| Devices | **Cloud** `devices` | One row per device UUID; name, version, etc. are stored only here |
| Account–device association | **Cloud** `terminals` | Many-to-many, with terminalId, token and Agent ownership |
| Terminal online/offline | **Cloud** `terminal_sessions` | Written by the conductor polling MQTT; used to compute online status and active time |
| Contacts (agents) | **Cloud** `users` + `users_rel` | Nickname, persona, permission level, owning computer (`users.terminal_id`), installation status (`users.status`), readiness (`users.readiness`, reported by the owning computer), current model (`users.model_state`, reported by the owning computer, only for the owner, used for display when offline; the list and settings ask that computer live via MQTT `AGENT_MODEL_REQUEST`/`AGENT_MODEL_RESULT`, and the selection is stored on that computer) all live in the cloud; kept after uninstall and labeled "Not installed". **"Add as contact" is the friend relationship** (`users_rel`, decided 2026-09-14): agents are not auto-friended on registration; tapping "+" creates the relationship and removing the contact deletes it; agent registration moved forward from phase 2 to phase 1 |
| Workspaces | **Cloud** (new table) | Name is in the cloud; **the path is only valid on the owning computer** |
| Conversations, members | **Cloud** `conversations` + `conversation_user_rel` | Fields need to be added, see Section 6 |
| Messages | **Cloud** `messages` | Fields need to be added, see Section 6 |
| Skills | **OSS** `skill/<userId>/<skillId>/`, the skill package's real directory, plus a `.ading-meta.json` recording the manifest and checksums (written last on upload, verified file by file after download) | Implemented 2026-11-02, not in the database; see `desktop_mac/src/knowledge/cloud-sync.ts`. Comparison and merging happen on the desktop: local changes upload within seconds, the cloud is checked hourly; when both sides changed, the newer `updatedAt` wins and the loser is kept locally in `knowledge-cloud-conflicts/`; deletes write tombstones. After a pull, changes are synced to each Agent. Multiple computers of the same user are queued by the backend `knowledge_locks`; writing to OSS requires holding the lock, which expires automatically. Failures are shown in the UI; network loss, not logged in and queuing are only logged |
| Skill proposals and peer reviews | **Local** | Not in the cloud yet |
| Memory | **OSS** `memory/<userId>/<memoryId>.json`, one object per entry | Same as skills, all three scopes are synced; the `memories` table is not used |
| Pending-sync queue, sync log | **Local**, isolated per account | Temporary storage for offline changes |
| Agent sessions (CLI thread IDs, etc.) | **Local**, isolated per account | These are sessions inside the local CLI and are meaningless on another computer |
| Permission grant records, permission mode | **Local**, isolated per account | Security related, per computer |
| Agent availability cache, runtime settings | **Local** | Bound to the CLIs installed locally |
| Image, video, file and other attachments | **OSS** (`attachments/<userId>/image|video|file/` directories) + cloud `attachments` table for metadata | Implemented 2026-09-28: a message's `attachments` column stores only ID, name, type and size; the local cache is in `attachments/<attachmentId>/` |

---

## 6. Backend Work Needed

The database has no versioning: schema changes go directly into `conductor/docs/create-database.sql` (always the latest complete schema);
ALTER statements for existing environments are run separately at deployment, and the service does not change the database automatically at startup.

### 6.1 Fields added to existing tables

**Fields are handled in two categories:**

- **Ones the backend needs to query or filter by**: built as separate columns.
- **Runtime state only the desktop scheduler understands** (`charter`, `workPlan`, `brainstorm`, `followUp`,
  and in messages `steps`, `agentReply`, `coordination`, etc.): stored together in one JSON column `extra`;
  the backend only stores and retrieves it, without parsing. These structures are still evolving with the scheduler, and changing tables and releasing the backend for every adjustment isn't worth it.

| Table | Separate columns | Put into `extra` |
| --- | --- | --- |
| `users` | `avatar_url`, `phone`, `email`; no column added for `status`, agents get the new value `NOT_INSTALLED` (the migration script also updates the column comment) | |
| `terminals` | Already has `fingerprint` and the unique index `(owner, fingerprint)`; the register API is idempotent by it and it stores the hash of the hardware UUID; device parameters move to `devices`, and `name` is kept only for old jars | |
| `conversations` | `workspace_id`, `status`, `paused`, `auto_title`, `seed_key`, `is_deleted` | charter, workPlan, brainstorm, followUp, workspacePath (the directory is only valid on the owning computer, so no separate column) |
| `conversation_user_rel` | `last_processed_seq`, `paused`, `resume_on_continue` | |
| `messages` | `internal`, `report`, `failed` | steps, agentReply, coordination |
| `memories` | Reworked to the desktop structure: `scope`, `owner_id`, `author_kind`, `author_user_id`, `source_message_id`, `pinned` | |

### 6.2 New tables

- `workspaces`: `workspace_id`, `owner`, `terminal_id`, `name`, `path`, `kind`
- `skills`: corresponds to the desktop `Skill`
- `skill_proposals`: corresponds to `SkillProposal`; the peer-review list is stored as JSON
- ~~`sync_operations`~~: **not created in phase 1** (adjusted during implementation on 2026-09-14). IDs for create operations (conversations, workspaces, messages) are all generated by the client,
  so replaying the same ID offline is naturally idempotent; update operations are "set to a value", so replaying gives the same result; repeating a delete doesn't error.
  This table will be added later if a truly non-idempotent operation appears.

### 6.3 APIs

Fill in the CRUD needed by the `Store` interface: deleting conversations (soft delete), workspaces, skills, proposals, memory, renaming computers, etc.
Every API must verify "you can only operate on your own account's data". Create APIs accept client-generated IDs (see 6.2).

Implemented in phase 1 (NAS):

| API | Notes |
| --- | --- |
| `GET/PUT /api/v1/profile` | Own profile; validation rules match desktop `profile-patch.ts` |
| `GET/POST /api/v1/workspaces`, `PUT/DELETE /api/v1/workspaces/{id}` | The list always contains "No workspace"; on delete, conversations move to "No workspace" |
| `POST /api/v1/conversations` | May carry `conversationId` (idempotent replay), `members` (with roles, saved as is), `workspaceId`, `autoTitle`, `seedKey`, `extra` |
| `GET /api/v1/conversations` | List includes members; excludes deleted |
| `PUT /api/v1/conversations/{id}`, `DELETE /api/v1/conversations/{id}` | Can change workspace, status, pause and `extra`; `touch=false` leaves sort order unchanged; delete is a soft delete |
| `PUT /api/v1/conversations/{id}/members/{memberId}` | Change role, member pause, auto-resume on continue |
| `POST /api/v1/conversations/{id}/messages` | May carry `internal`, `report`, `failed`, `extra`; content limit raised to 200,000 characters (long agent replies) |
| `PUT /api/v1/conversations/{id}/messages/processed?senderId=` | The Agent's processed watermark, separate from the read position |

**Acting on behalf**: before the computer registers (phase 1 step 4), the desktop only has a user token. A user token can use `senderId`
to send messages, mark read and mark processed watermarks on behalf of **agents under the user's own account** (the server verifies ownership); a computer token can still only represent agents on that computer.

### 6.4 Existing rules to change

The agent type whitelist in `AgentService` has only `CODEX`, `CLAUDE_CODE` and `QODER`, **and is missing `QODER_CN`**.
The desktop has qoder-cn; without adding it, its registration to the cloud will be rejected. Only code changes; the `agent_type` column needs no change.

`TaskService.create` currently requires members to be friends, otherwise it reports `NOT_FRIEND`,
which blocks even agents under the user's own account. Change it to: **agents under the user's own account (on any computer) can join conversations directly**.

---

## 7. Importing Standalone Data on First Login

- **When to ask**: when an account logs in successfully on this computer for the first time and there is standalone data on this machine, ask once:
  "Import the standalone edition's conversations, contacts, skills and memory into this account?"
  Options: Import / Don't import / Later. Those who choose "Later" can start it manually in Settings afterwards.
- **What is imported**: conversations and messages, workspaces, agent contacts (registered as this machine's agents), skills, proposals, memory, own profile.
  **Not imported**: permission grant records, agent sessions, availability cache.
- **How IDs map**: the standalone own ID → account userId; local agents → registered as this machine's cloud agents by `localUuid`;
  the owner of the "about me" layer in memory is also changed to the account userId.
- **Can be run repeatedly**: the original IDs of standalone data are used as idempotency keys, so re-importing after a mid-way failure creates no duplicate data.
- **Standalone data is kept as is**: read-only, never modified; after logout the standalone edition is unchanged.

---

## 8. Confirmed Decisions

| # | Question | Conclusion |
| --- | --- | --- |
| 1 | How to switch on login / logout | **No app restart.** The data layer is reloaded in-process, with a waiting screen if it takes time; running agents stop immediately, with a warning before login (2.3) |
| 2 | Online edition while offline | **Keep using it without logging out.** New changes are stored locally first and synced to the cloud once back online (3.3). **Logout is also allowed**, with an explicit warning beforehand that you'll return to the standalone edition (3.4) |
| 3 | Multiple computers | **Agents are bound to computers.** Computers are identified by the hash of the hardware UUID, not by computer name; the same kind of agent on different computers are different contacts and execute only on their owning computer; after uninstall the contact is kept and the "Not installed" status is synced (Section 4) |
| 4 | Human friends, multi-person collaboration | **Not this time**; get online-edition agents right first |
| 5 | How agents address the user | **By nickname** (4.4) |

---

## 9. Phases

| Phase | Contents | How to accept on the NAS |
| --- | --- | --- |
| **Phase 1** | Rebuildable data session, waiting screen during switching, agent-stop warning on login, logout confirmation; computer registration (hardware UUID); conversations, members, messages, workspaces and own profile in the cloud; offline pending-sync queue | The window stays up during login and logout, with only the waiting screen shown; after login, created conversations, sent messages and agent replies all land in the cloud; after disconnecting the NAS, keep sending messages, and after reconnecting they sync automatically without duplicates; standalone data is unchanged after logout; deleting the local cache and logging in again fully restores everything |
| **Phase 2** | Agent identifier unified as `type@computerUniqueID` (shared by both editions, old data wiped); agents in the cloud and bound to computers; contacts show owning computer and installation status; only local agents are scheduled | Simulate two computers logged in to the same account with two cache directories: each one's codex is a separate contact; agents in the same conversation execute only on their owning computer, with no duplicate replies; after uninstall the contact is kept and shows "Not installed", visible on the other computer too; after reinstall it's matched back to the original contact; status is unchanged when detection errors |
| **Phase 3** | Skills, proposals and peer reviews, memory in the cloud | In the online edition, skill capture, peer review and syncing to each agent work as usual; offline changes sync after reconnecting |
| **Phase 4** | Import standalone data on first login | Data is complete after import; repeated imports don't duplicate; standalone data is unchanged after import |

**Phase 1 acceptance record (2026-09-14, NAS):**

| Acceptance item | Result |
| --- | --- |
| The window stays up during login and logout, with only the waiting screen shown | Passed (UI tests + real device) |
| Computers register by the hash of the hardware UUID; no raw UUID in the database | Passed |
| Local agents register to the cloud (including `QODER_CN`); the cache uses the cloud userId | Passed (agent registration moved forward from phase 2: conversation members must be cloud users) |
| After login, created conversations, sent messages and agent replies all land in the cloud | Passed |
| After disconnecting the NAS, keep sending messages; after reconnecting they upload automatically without duplicates | Passed (seq 1–4 match local, no duplicates) |
| Deleting the local cache and reopening fully restores everything | Passed; found that the read position was truncated by the cloud during offline replay, fixed (reconcile the position once more after messages finish uploading) |
| Standalone data is unchanged after logout | Passed (after logging out, logging in again and logging out again, the hashes of the standalone edition's 4 conversations and all chat history files were unchanged; only the agent detection status cache refreshed normally) |

- Import comes last because it depends on all data types from the first three phases already being in the cloud. During the first three phases no import prompt appears on login, and the account starts empty.
- **Every phase requires: all existing standalone tests pass.** Because logic is shared, when a shared rule itself changes (for example, the agent identifier format),
  the corresponding tests change with the rule, but standalone features must not be reduced.
- Phases that require wiping data: announce the scope of the wipe before starting (standalone data on this machine, NAS development database); ECS is not touched.
- Phase 1 is the largest: the data-session rework touches how the main process is assembled, and the offline queue is the foundation shared by all later phases.
