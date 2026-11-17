# ading
I wanted a tool like DingTalk to manage my different agents. These agents are my digital employees, and I've finally become the big boss. So what I'm building is a chat tool where humans and agents get along. You can chat one-on-one or in groups. I can assign tasks in it, and the agents can discuss problems there and review each other's work.
I want a DingTalk-like platform for managing different agents. These agents would be my digital employees, and I’d finally get to be the big boss. Essentially, I want to build a chat app where humans and agents work together seamlessly. It should support both one-on-one and group chats. I can assign tasks there, while the agents can discuss problems and review one another’s work.

## Versioning and release channels

**These rules apply to every component in this repo** — the macOS client, the conductor backend, and any client added in the future.
For now all components share one version: the same version number and naming convention, advanced together.

### Meaning of the three-part a.b.c

| Position | Meaning |
|---|---|
| a | Major changes, important new features, etc.; a **major version** |
| b | Small features, small requirements, small changes; a **minor version** |
| c | Mostly debugging: debug patches, hot fixes, and other very small changes; a **routine update (patch version)** |

### Three version strings for three environments

| Channel `adingChannel` | Version string | Backend |
|---|---|---|
| Production `release` | `a.b.c`, e.g. `0.4.0` | ECS production service `ading_service` (8080), `https://www.coffeestudy.com.cn` |
| Pre-release (gray) `pre` | `a.b.c-date-time-pre`, e.g. `0.4.0-2026.9.17-143005-pre` | ECS pre-release service `ading_service_pre` (8180), `https://www.coffeestudy.com.cn/pre` |
| Development `develop` | `a.b.c-date-time-dev`, e.g. `0.4.0-2026.9.17-143005-dev` | NAS development service, `http://<NAS-host>:8080` |

Machines, directories, service names, and ports for the three environments are in [conductor/docs/deployment.md](conductor/docs/deployment.md).

Pre-release and development versions simply append the build time (`date-HHMMSS`) and a channel tag to the version number. All three forms are valid semver,
and the semantics are right: pre-release and development builds are prereleases of **the production version they will become**,
`0.3.0 < 0.4.0-2026.9.20-143005-pre < 0.4.0`, and likewise for development builds.
Channels never upgrade into each other, so ordering between `-dev` and `-pre` is meaningless.

Within one channel and one three-part version, builds are ordered by build time: compare the date first, then HHMMSS,
`0.4.0-2026.9.20-143005-pre < 0.4.0-2026.9.20-150000-pre < 0.4.0-2026.9.21-000000-pre`.
So testing gray upgrades (OTA) needs no version change; repackaging produces a newer version.

The version in the working tree is the **in-development version**, defined by `desktop_mac/package.json`, `conductor/pom.xml`, and `ops/pom.xml`.
The most recently released production version is not written here — it lives in the built artifacts, the Homebrew cask, and the release records in `app_releases`,
and does not occupy the working tree's version fields.

`ops/` (the ops console) is built and deployed independently, but shares and advances the version number with the other modules (`ops/pom.xml`);
it has only one live deployment, no development/pre-release channels, and is not subject to the channel rules above. See `ops/docs/deployment.md` for deployment.

### Four constraints to uphold

- **The separator is a hyphen, not an underscore.** `0.3.0_2026.9.13_dev` is not valid semver,
  and putting it in `package.json`'s `version` makes npm/pnpm fail outright.
- **Month and day must not be zero-padded; HHMMSS must be zero-padded to 6 digits.** Semver numeric identifiers disallow leading zeros,
  so `2026.09.13` makes the whole version invalid; HHMMSS joins the channel tag into one alphanumeric segment (e.g. `20-093005-pre`),
  where zero-padding is legal and must be fixed-width so that text comparison equals time comparison.
- **`CFBundleShortVersionString` and `CFBundleVersion` use only the three-part version.**
  Apple accepts only 1 to 3 numeric components; the full string stays in `package.json`'s `version`.
- **The channel is not parsed from the version string.** The channel is a separate explicit property in `package.json`,
  `adingChannel` (`develop` / `pre` / `release`), which decides which backend to connect to. The working tree is always `develop`;
  pre-release and production packages are determined by `ADING_CHANNEL=pre` / `ADING_CHANNEL=release` at packaging time. The version number is a human-facing
  display field; making it carry configuration semantics means one typo in the version connects to the wrong environment, and such errors
  often surface only at the user's end. Unrecognized channel names are treated as development.

### When to change the version number

- **Development and pre-release**: the build time is fixed automatically at packaging; no manual maintenance. The three-part portion follows the release cadence.
- **Production**: **before every release, always ask the user whether to change the version number**, and package after getting an answer.
- Fixes, builds, packaging, and update restarts **must never** auto-increment the version number.
