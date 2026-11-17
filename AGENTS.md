
## Version management

Versioning rules live in one place, the repo root [README.md](README.md#versioning-and-release-channels),
and apply to all clients and the backend. When changing the rules, change them there; don't write another copy elsewhere.

Points to always keep in mind:

- The in-development version is defined by `desktop_mac/package.json` and `conductor/pom.xml`; it is not copied here. Before starting the next version, ask the user for the new in-development version number.
- Fixes, builds, packaging, or update restarts **must not** auto-increment the version number.
- **Before releasing a production version, always ask the user whether to change the version number**, and package only after getting an answer.
- Use hyphens as separators, and don't zero-pad month and day in dates, or the semver is invalid.
- Three channels: development `a.b.c-date-time-dev` connects to the NAS, pre-release (gray) `a.b.c-date-time-pre` connects to the ECS pre-release service (8180), production `a.b.c` connects to the ECS production service (8080).
- The channel is a separate property `adingChannel` (`develop` / `pre` / `release`) and is not parsed from the version string.

## Testing

- **List tests that only hold on specific systems separately**: skip them on other systems and state why; **do not modify the test itself just to make it pass on another system**.
  The desktop list is `macOnly` in `desktop_mac/test/run.mjs` (used by `pnpm test`); add new system-dependent tests to the corresponding list.
- When a test fails, first run it on the unchanged code to confirm whether the problem already existed, then draw conclusions.

## Icon conventions

- Use the same shared icon for the same meaning across the app, with consistent stroke, sizing system, and button style; reuse `desktop_mac/src/ui/icons.ts` first, and don't draw a separate set per page.
- Prefer easy-to-understand icon buttons for actions like add and remove, showing text on hover and providing accessibility labels.
- **Icon-only** controls must have a hover tooltip, viewable even when disabled; always use the shared tooltip layer, which must not be clipped by dialogs or scroll containers.
- Conversely, if **a control already shows text** (a label under an icon, a text button), don't add a tooltip; a bubble repeating it adds no information. Such controls use `aria-label` rather than `title`: `title` makes the browser pop a native bubble too, stacking with the shared layer into two.
- Tooltip text is at most 24 characters. Bubbles are at most 300px wide; longer text gets truncated, which is as good as not saying it; long content belongs in a detail page. The three rules above are backed by UI tests. Contact, member, and new-conversation picker lists distinguish Agents with traffic lights, without extra robot-head type markers, group icons, or duplicate counts; humans have no type marker, and Agents are grouped above humans.
- Leader always uses the crown: the current Leader in color, other members in black and white, with hover text "leader" and "Set as leader" respectively.
- The conversation settings member list distinguishes Agents with traffic lights and no longer shows an Agent type icon; a red light only indicates "unavailable", without the specific reason. The new-conversation picker list also shows Agent traffic lights. Neither the traffic lights in lists nor contact rows show hover tooltips — the row already shows the name and status text like "quota exhausted", so another bubble adds nothing; see the contact details or Agent management panel for the specific reason. For controls that need an aria-label but no tooltip, write `data-tooltip=""` explicitly.
- **Exception: in connected mode, hovering an Agent row shows its computer name.** When several computers on the same account each have an Agent with the same name (e.g. two Agents both named "c"), the name in the row can't tell them apart, and the computer is new information the name can't give. This applies to the contact list, the conversation settings member list, and the new-conversation picker list; the tooltip shows only the computer name (within 24 characters), and the full computer ID goes in the "Computer" field of the contact details. Standalone mode has no other computers, so still no tooltip.

<!-- ADING:BEGIN 由 ADing 公共技能库同步，请勿手改；要改请到 ADing 里改 -->

## ADing team skills

The following is synced by ADing from the shared skill library and is shared by multiple Agents.

(none yet)

<!-- ADING:END -->
