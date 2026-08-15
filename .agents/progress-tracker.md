# Post-task progress tracker agent

## Purpose

After an implementation task finishes, reconcile the repository's task records,
decision records, validation evidence, and (when connected) Linear issue state.
The result must be understandable from the repository without relying on chat
history.

## Required inputs

- Completed or blocked issue key, if one exists
- Summary of files changed
- Validation commands and results
- Commit SHA, branch, and PR reference when available
- Known follow-up work, blockers, or policy conflicts

## Procedure

1. Read `AGENTS.md`, `TASKS.md`, and the applicable architecture decision record.
2. Inspect `git status`, the final diff, and the changed files.
3. Run the task's required validation. Run `pnpm validate` when the repository
   policy or issue acceptance criteria require it.
4. Confirm the change is on a short-lived branch and that the PR base follows the
   recorded `parentBranch`; the first stack branch must target protected `main`.
5. Update `TASKS.md` only for work evidenced by the final implementation. Keep
   incomplete work unchecked and add a follow-up item when needed.
6. Update the relevant architecture or decision document when the task changes
   a binding design decision. Do not silently alter an approved decision to make
   an implementation appear complete.
7. Append one entry to `.agents/progress-log.md` using the format below.
   The repository helper `pnpm progress:record -- ...` may be used to append a
   validated entry and automatically capture the current branch and commit.
8. If Linear is connected, reconcile the issue status and add a concise evidence
   comment. Never claim validation or merge completion without evidence.

## Status rules

- `completed`: acceptance criteria are met, required validation passes, and no
  unresolved blocker remains within the task scope.
- `in_progress`: implementation or required validation remains.
- `blocked`: progress cannot continue because of an external dependency,
  unresolved policy decision, or failed required gate. Name the blocker.
- `follow_up`: the task is complete, but a separate issue is required for work
  intentionally outside its scope.

## Progress-log entry format

Append entries; do not rewrite earlier history.

```markdown
## YYYY-MM-DD — ISSUE-KEY — completed|in_progress|blocked|follow_up

- Scope: short description
- Evidence: validation commands/results and relevant commit or PR
- Repository updates: files or task rows updated
- Linear update: status/comment changed, or pending action
- Follow-up/blocker: `None` or explicit issue and owner
```

## Guardrails

- Do not push directly to `main`.
- Do not mark a task complete from a passing partial test.
- Do not close or merge a Linear issue solely because code exists locally.
- Do not change unrelated task rows.
- Preserve historical test fixtures that intentionally use legacy branch names;
  they do not change the production trunk policy.
- Keep credentials, provider output, and unbounded logs out of progress records.
