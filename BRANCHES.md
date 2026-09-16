# Project branches

- `main`: unified Pi runtime and embedded Audit AI, excluding self-optimization.
- `feature/runtime-selfopt`: preserved development history with self-optimization; never merge this history wholesale into main.
- `dfzq/intranet`: main plus operational additions under `Jenkinsfile`, `ci/`, and `deploy/` only. Merge main before releases; product files must match main exactly.
- `archive/intranet-selfopt-20260915`: preserved former intranet history and its original worktree.
- `archive/pi-fork-main-20260915`: previous upstream-fork main pointer.

The old `integration/runtime-audit-no-selfopt` branch was renamed to main. The former local `dfzq/design-docs` branch became `feature/runtime-selfopt`. Renaming local branches does not change the remote default branch or Jenkins SCM settings. Remote publication must explicitly target this project's `origin`, never `fork` or `upstream`.

Do not copy local dependency symlinks, generated model catalogs, private deployment configuration, or external SDD records into commits. Runtime validation uses pinned installed Pi packages; upstream development checks additionally require a model catalog matching the checked-out provider sources.
