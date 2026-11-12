# Version overview

Open Versions from the branch menu beside the file name or from History. Selecting an entry only inspects it. Switching a branch requires the explicit Switch action; merge and discard remain the person's decisions.

Tree uses the recorded parent of each in-file design branch. It does not guess edges between saved commits: older checkpoints have no reliable branch tag. List offers a compact searchable view with the current branch first. Commits shows saved snapshots, including restore points and optional automatic saves. The initial history request is bounded to the recent 200 timeline records; this is not an assertion that the file has no older history.

The detail area compares the selected branch or checkpoint against the live design through the real diff API. Commit Preview displays a saved snapshot without checking it out. Save version adds a named checkpoint of the current design. Existing branch merge review still exposes conflicts and requires the person's explicit confirmation.

The dialog loads only when opened. Branch and history requests run together; stale file/selection responses cannot overwrite a newer comparison. The ancestry helper bounds depth, handles imported orphans and terminates on cycles. On narrow screens the detail area moves below the records and both remain scrollable within the viewport. Keyboard access includes Escape, a focus trap and arrow keys in the view tabs.
