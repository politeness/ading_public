# ADing Desktop

macOS Electron client and local Agent node. When not signed in it runs as a standalone edition with data stored locally; when signed in it runs as the online edition with the cloud as the source of truth. Both share the same business logic.
Supports local conversations, Agent management, messaging, skills and memory, help and support, and auto-update. The in-development version number is in `package.json`.

## Versioning and release channels

The versioning rules apply uniformly across the whole repository (this client, the conductor backend, and any future clients).
See the [README.md](../README.md#versioning-and-release-channels) at the repository root for the full description.

Two points specific to this client: the version string is determined jointly by `version` and `adingChannel` in `package.json`;
pre-release and development builds bake the build time (date-hhmmss) and a `-pre` / `-dev` marker into the version string at packaging time.

## Development

Requires Node.js and pnpm. Run in this directory:

```bash
pnpm install --frozen-lockfile
pnpm start
```

## Checks

```bash
pnpm test
pnpm test:regressions
pnpm test:ui
```

`test` and `test:regressions` use isolated test data; `test:ui` verifies the UI in Electron with mock data. The build uses two TypeScript configurations: one for the main process / preload and one for browser ES modules.

## Local packaging

```bash
pnpm package:local                      # Package per adingChannel in package.json; defaults to the development build
ADING_CHANNEL=pre pnpm package:local      # Build the pre-release (gray) version, connected to the ECS pre-release service
ADING_CHANNEL=release pnpm package:local  # Build the release version
```

The build time is baked into the version string at packaging time, so every development or pre-release package gets a newer version number (to the second).
Keep `adingChannel` in `package.json` set to `develop` so the default build is the development build;
build pre-release and release versions with the environment variables above instead of changing this field.

Artifacts go to `releases/` and use a local ad-hoc signature. `dist/`, `node_modules/`, and `releases/` are not committed; `build/icon.png` is the required app icon source and must be committed.

## Optional task seed

See `../.ading/README.md`. The repository only commits `seed.example.json`; the locally enabled `seed.json` is ignored by Git.

## Animation assets

The production UI uses `src/assets/ikkyu-approved-{idle,strip}.png` (a 44-frame animation strip and a static avatar). These two images are the final assets.
