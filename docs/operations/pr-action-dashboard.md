# PR Action Dashboard

The PR Action Dashboard is the first operational view in the Engineering
Control Center. It discovers active repositories in the configured GitHub
organization, normalizes their open pull requests in the orchestrator API, and
serves the dashboard and API from one local origin.

## Requirements

- Node.js 24
- pnpm 11.19.0
- A fine-grained GitHub token with read access to organization metadata,
  pull requests, checks, commit statuses, and reviews for the repositories that
  should appear

The token remains in the API process. It is never returned to or used by browser
code.

## Start locally

Set the token through the runtime environment, then start the dashboard:

```powershell
$env:GITHUB_TOKEN = "<fine-grained-token>"
$env:GITHUB_ORGANIZATION = "AyfordAndCo" # Optional; this is the default
$env:PORT = "3000"                       # Optional; this is the default
pnpm start:dashboard
```

Open `http://127.0.0.1:3000`. The server deliberately binds only to the local
loopback interface. A hosted deployment must add the platform's approved
authentication and authorization boundary before exposing this operational
data beyond a trusted local environment.

## API

`GET /pull-requests/actions` returns:

```json
{
  "data": {
    "items": [],
    "summary": {
      "total": 0,
      "actionRequired": 0,
      "ciFailed": 0,
      "ciRunning": 0,
      "waitingReview": 0,
      "byAction": {}
    },
    "generatedAt": "2026-09-05T12:00:00.000Z"
  }
}
```

GitHub failures return a stable `502` response without upstream diagnostics or
credentials. The MVP fails closed if any repository cannot be read rather than
silently showing incomplete organization state. API responses are not cached.

Collection requests follow GitHub pagination links and reject any pagination
target outside `api.github.com` before forwarding the bearer token.

## Classification inputs

The adapter uses check runs, combined commit status, each reviewer's latest
submitted decision, mergeability, merge state, and labels. These labels add
operator intent:

- `waiting-on-agent`
- `waiting-on-external`
- `priority:critical`
- `priority:high`
- `priority:low`

Without a priority label, a pull request is classified as `NORMAL` priority.
Issue references are derived from keys such as `ALL-23` or closing references
such as `Closes #23` in the title, body, or head branch.

## MVP operating model

Refresh is manual. Background polling, webhooks, hosted authentication,
agent-run linkage, and real-time reconciliation are follow-up work.
