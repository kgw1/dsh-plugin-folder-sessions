# Changelog

## 0.1.0 — 2026-10-17

Initial release.

- **New Session** (sidebar button, header button, `Cmd+N`) now creates a fresh
  session workspace folder under a configurable root (default `~/dsh-sessions`)
  instead of reusing the current / recent workspace.
- **Workspace "+" bubble** keeps the stock DSH behavior (new blank session in
  that workspace), including blank-session reuse.
- **Settings → General → New session folder**: view / change the root folder
  with the native directory picker, or restore the default.
- **Rename workspace** (`⋯ → Rename`) on an auto-created workspace renames the
  on-disk folder as well as the display name. A compatibility symlink is left at
  the old path so already-created sessions keep resolving their cwd. A second
  rename updates the symlink chain; non-managed workspaces fall back to the
  stock title-only rename.
- Host half exposes four same-origin HTTP routes under
  `/folder-sessions/api` (`config`, `directories`, `rename`, `health`).
- 64 Node tests; end-to-end verified on DSH Desktop 0.2.0-rc.2.
