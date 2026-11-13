# Settings and personal design guidance

Open Settings from the Home screen or press **Ctrl+,** in an open file. Search finds categories and settings by name. In a narrow window, choose a category from the list and use Back to return. Preferences apply to this device; they do not resize design layers or change the words inside your screens.

| Category | What it controls |
| --- | --- |
| Appearance | Interface size from 90 to 200 percent, System/Light/Dark, interface language and reduced motion. |
| Canvas | Arrow and Shift-arrow movement, wheel behaviour, zoom direction and layout grids. |
| Agents | Installed runners and their model/effort defaults. Each run still uses the runner and model you choose. **Add to agent** lists the MCP clients on this computer and connects one with a click, as `bogen install` does ([Agents](agents.md#add-to-agent-in-settings)). |
| Design knowledge | Design playbooks, decisions, composition briefs and your editable personal SKILL.md. |
| References | Pages and pictures you collected, which agents search before a direction. See [References](capture-and-import.md#references). |
| Devices | Existing sync peers and phone pairing. Opening this category does not enable either. |
| Privacy | Whether the browser offers Bogen's WebMCP tools, and the paired [browser extensions](capture-and-import.md#from-your-browser-the-extension), each with Revoke. |
| About | The running server version and any update it knows about. |

Back to defaults resets the current Appearance, Canvas or Privacy category, rather than unrelated preferences. An Appearance reset resumes automatic interface scaling; it does not reset the separately stored language choice.

## Edit the rules your agent receives

1. Choose **Design knowledge** and a discipline.
2. Click **Edit SKILL.md**. The text editor opens directly. The separate SKILL.md button opens a read-only preview first.
3. Adapt the instructions and click Save. Custom identifies your saved version. Copy uses the current draft; Download becomes available after saving.
4. Original shows the shipped version for comparison. Restore Original, followed by confirmation, returns to the latest shipped version.

A draft stays in this browser tab across closing Settings and reloading until you save or discard it. This is browser session storage, not a permanent backup after closing the tab or clearing browser data. If another editor or agent changes the skill, both versions remain available and Save is blocked until you compare and explicitly choose Keep my edits.

Personal skills apply to every design using that discipline **on this Bogen host**. They are not automatically synced between computers. They live outside the app bundle, so an app update does not overwrite them. Previous contents are saved before a change or restore. [Design knowledge](design-knowledge.md#personal-skills) explains the files and agent tools.

## See a newly installed editor

Restarting the server does not replace JavaScript already running in an open app window. Reload that window once after updating. New desktop editors also check the served app shell after reconnection, when the window gains focus and once a minute while visible. When a different editor build is available, they offer Reload; they never reload in the middle of your work automatically.

A window opened before that notification feature was installed still needs its first manual reload. The phone's service-worker update notification is a separate mechanism. If the interface still looks old, check About, reload with **Ctrl+Shift+R**, then open Settings again.
