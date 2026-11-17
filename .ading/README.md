# Optional startup task list

The repo ships a `seed.example.json` example, which is never run automatically. To enable it, copy it to `seed.json` in the same directory and edit the absolute workspace paths, members, permissions, and opening message; `seed.json` is local configuration and is not committed to Git.

When the app discovers Agents it reads the task list, deduplicates by `conversations[].key`, and never overwrites existing workspaces or conversations. The opening message is sent as the current user and triggers the Agents. Existing local task lists keep working.

Lookup order: the file named by the `ADING_SEED` environment variable, `.ading/seed.json` in the current directory, then `.ading/seed.json` in the parent directory.

After `pnpm headless` starts it discovers Agents and applies the task list, then checks for new conversations every 15 seconds. When unattended, `ask` permission degrades to read-only; write access requires the user to explicitly configure `always`.

The conversations in the example are for verifying CLI integration and are not data the app needs for daily startup. The task-list capability in the code and its tests are kept.
