# Onboarding progress

Account progress is stored in the business database column `ading.users.onboarding_v1_steps`, isolated by `user_id`. The v1 in the column name is the onboarding version; the default 0 means not started, and 255 means all eight tips have been completed or skipped.

Bits 0 to 7 represent, in order: Explore Silicon People, Permission settings, Support, New conversation, Share Agent, Agent avatar, Switch conversation, Activity feed. "Next" confirms one step; "Skip" confirms the current group. The server merges with an atomic bitwise OR, so different devices cannot overwrite confirmed steps.

After login, call `GET /api/v1/auth/onboarding` to get the authoritative progress; `POST` to the same path submits `completedSteps`. Only the authenticated account is used; a target user ID is not accepted. The response includes `version: 1`. Local localStorage is only a cache; standalone mode keeps saving progress locally.

Before deploying to an existing environment, back up first and run `alter-2026-11-05-onboarding-progress.sql`: existing real-person accounts are initialized to all skipped, and the internal test accounts listed in the script are initialized to not started. The migration runs only once; afterwards new accounts keep the default 0. Onboarding state uses only the dedicated column above, not user tags.

The NAS development database and the RDS database shared by ECS pre-release/production are independent of each other and must be migrated separately under their respective release authorizations.
