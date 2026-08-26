Hypertasks contains two small plugins for Logseq DB graphs. Each plugin is self-contained and can be loaded separately as an unpacked Logseq plugin.

TODO Master (DB) lives in logseq-todomaster-db. It renders progress bars for {{renderer :todomaster}} macros by reading task status from :logseq.property/status, which is required for Logseq DB graphs. A block-level macro counts tasks in its subtree, while {{renderer :todomaster-page-name}} counts tasks on a named page. Status changes trigger a debounced refresh.

Morning Journal lives in logseq-morning-journal. Running its command creates or regenerates today's journal, collects open tasks from the configured tracker pages, and creates top picks, meetings, and journal sections. It excludes backlog, wait, done, and canceled tasks by default. Run it from the sun button in Logseq's top toolbar, the Morning Journal slash command, the command palette, or the Mod+Alt+M shortcut. Mod maps to Ctrl on Windows and Command on macOS.

The Deadline days ahead plugin setting controls which tasks are added. Its default of -1 includes every open task and sorts by creation time. Set it to 0 for tasks due today only, or 7 for tasks due today through seven days from today, inclusive. When the setting is 0 or greater, tasks without deadlines and tasks due before today are excluded, and the results are sorted by deadline.

Morning Journal is currently configured for the sm467d graph, the tracker page, and tasks under a section that references [[msft]]. These values are defined near the top of logseq-morning-journal/index.js. Set SCOPE_REF to an empty string to include every tracker task, change TRACKER_PAGES to use different tracker pages, and update ensureGraph if the plugin should run on another graph.

Warning: Morning Journal intentionally removes all existing top-level blocks from today's journal before rebuilding it. Re-running the command replaces the journal's current contents.

To install the plugins, clone this repository, enable developer mode in Logseq, choose the option to load an unpacked plugin, and select each plugin directory separately. Load both directories if Morning Journal's generated TODO Master progress bar should render.

There is no build step. Each index.html loads the bundled Logseq plugin SDK and its neighboring index.js directly.

The plugins use Logseq APIs and contain no operating-system-specific paths or commands. The same packaged directories work on Windows and macOS.
