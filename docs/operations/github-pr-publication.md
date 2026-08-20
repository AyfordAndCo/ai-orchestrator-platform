# GitHub pull request publication

The orchestrator must create pull requests as `ai-orchestrator-bot`. This is
required because the human review policy cannot request or accept approval
from the pull request author.

Configure the publisher with the service-user token as its `GH_TOKEN` value:

```sh
read -rsp "Bot token: " GH_SERVICE_USER_TOKEN
export GH_TOKEN="$GH_SERVICE_USER_TOKEN"
gh auth status
```

The active account must be `ai-orchestrator-bot`. The GitHub publisher verifies
the authenticated `/user` identity before listing or creating a pull request
and rejects any other actor. Never commit or print the token.

For GitHub Actions, store the token as the repository secret
`GH_SERVICE_USER_TOKEN` and pass it only to the publication process. The
workflow may use the default `GITHUB_TOKEN` for read-only validation, but it
must not use it to create pull requests.
