# Repository agents

This directory contains repository-local instructions for agents that record
progress after implementation tasks are completed.

## Agent files

- [`progress-tracker.md`](progress-tracker.md) — post-task progress-update agent
- [`task-completion-checklist.md`](task-completion-checklist.md) — completion evidence checklist
- [`progress-log.md`](progress-log.md) — append-only repository progress ledger
- [`track-progress.mjs`](track-progress.mjs) — safe CLI writer for progress-log entries

Run the writer after completing the checklist:

```bash
pnpm progress:record -- \
  --issue ALL-000 \
  --status completed \
  --scope "short task scope" \
  --evidence "pnpm validate: passed" \
  --repository-updates "TASKS.md and implementation files" \
  --linear-update "Linear status/comment reconciled" \
  --follow-up "None"
```

The progress tracker is run after a task is complete or intentionally blocked.
It updates the repository record only when the implementation and validation
evidence support the status. It must not mark work complete because a branch was
created, a PR was opened, or an issue was moved in Linear alone.

External Linear updates remain explicit and auditable. When Linear access is
available, the tracker may add a status comment or update the issue after the
repository record is consistent. When it is unavailable, record the pending
Linear action in the progress log.
