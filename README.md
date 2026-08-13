# ROD 🩺

**Repo Onboarding Doctor** verifies that a repository can actually be set up from its README in a fresh environment.

When a pull request is opened or updated, ROD downloads the PR source without exposing the GitHub App token to repository code, unpacks it inside a Vercel Sandbox, follows safe onboarding commands, observes the running application, and posts a reusable diagnosis comment plus a GitHub Check Run.

## What v0.1 detects

- missing environment-variable documentation
- missing dependency-install instructions
- broken install/start commands
- undocumented or mismatched Node.js / Python requirements
- missing or incorrect localhost URL / port
- stale README package-script references

## Architecture

```text
GitHub pull_request webhook
        │
        ▼
Next.js route handler
  ├─ verify HMAC signature
  └─ obtain installation-scoped Octokit
        │
        ├─ read README/runtime metadata
        ├─ download source archive in the control plane
        └─ create Check Run
        │
        ▼
Vercel Sandbox (no GitHub token)
  ├─ unpack source
  ├─ scan env references
  ├─ install dependencies
  ├─ start app
  └─ observe listening port + HTTP endpoint
        │
        ▼
Finding engine
        │
        ├─ update one PR comment
        └─ complete Check Run
```

## Security model

Repository code is untrusted. ROD therefore:

1. verifies every GitHub webhook with `X-Hub-Signature-256`;
2. uses the GitHub installation token only in the control plane;
3. downloads the repository archive before creating the execution environment;
4. passes only `CI=1` and `ROD_SANDBOX=1` into the Sandbox;
5. executes only a narrow allowlist of onboarding commands from README examples;
6. blocks obvious deploy/publish/cloud/remote-shell commands;
7. always stops the Sandbox in a `finally` block.

The command policy is intentionally conservative. Commands ROD will not safely reproduce should become explicit findings in a later release instead of being executed blindly.

## GitHub App configuration

Create a GitHub App with these repository permissions:

- **Metadata:** Read-only
- **Contents:** Read-only
- **Pull requests:** Read & write
- **Checks:** Read & write

Subscribe to the **Pull request** webhook event. Set the webhook URL to:

```text
https://YOUR_DEPLOYMENT/api/github/webhook
```

ROD reacts to `opened`, `reopened`, `synchronize`, and `ready_for_review` actions.

## Environment variables

Copy the example file:

```bash
cp .env.example .env.local
```

Required values:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

When deployed on Vercel, Sandbox authentication uses Vercel OIDC automatically. Local development can additionally set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

Run checks with:

```bash
npm test
npm run typecheck
npm run build
```

## Current MVP limits

- Runtime execution uses Vercel Sandbox built-in Node 22/24/26 or Python 3.13 environments.
- It does not provision databases or third-party services for the target repository.
- Environment-variable detection is static and intentionally biased toward common Node.js and Python patterns.
- “Stale explanation” detection currently covers concrete script/runtime/port contradictions; semantic prose drift is reserved for the AI-assisted analyzer phase.
- Long diagnoses currently run from Next.js `after()`. Moving orchestration to Vercel Workflow is the next reliability milestone before high-volume production use.
