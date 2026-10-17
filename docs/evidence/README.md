# End-to-end evidence

Screenshots taken while driving the **actual DSH Desktop 0.2.0-rc.2 runtime**
(extracted from `/Applications/DeepSeek Harness.app`) in an isolated
`DSH_HOME` with Playwright + headless Microsoft Edge. No regular browser
mock was involved:

1. `01-new-session.png` — clicking the sidebar **New Session** button creates
   `~/dsh-sessions/20261017-124246`, registers it as a workspace, opens a
   session inside it, and shows the confirmation toast.
2. `02-rename.png` — renaming that workspace through `⋯ → Rename` renamed both
   the display name and the on-disk folder (old path kept as a compatibility
   symlink), with the workspace list and session accounting preserved.
3. `03-settings.png` — the **Settings → General → New session folder** row,
   showing the configured root, the default tag, and Change / Use default
   actions.

Verification run also checked: the workspace **+** bubble does not create a new
folder (stock blank-session behavior), a second rename keeps the symlink chain
working, a new session created after rename attaches successfully, and the
browser console reports no errors.
