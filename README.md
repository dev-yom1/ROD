# ROD 🩺

**Repo Onboarding Doctor** verifies that a repository can actually be set up from its README in a fresh environment.

When a pull request is opened or updated, ROD downloads the PR source without exposing the GitHub App token to repository code, unpacks it inside a Vercel Sandbox, follows safe onboarding commands, observes the running application, and posts a reusable diagnosis comment plus a GitHub Check Run.

## What v0.1 detects

- missing environment-variable documentation
- missing dependency-install instructions
- broken install/start commands
- undocumented or mismatched Node.js / Python requirements
- README runtime ranges that claim versions the repository does not support
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
  ├─ select a candidate Node/Python runtime line
  ├─ measure the exact node/python version
  ├─ verify it satisfies the repository constraint
  ├─ unpack source + scan env references
  ├─ install dependencies
  ├─ start app
  └─ poll listeners until an HTTP endpoint responds
        │
        ▼
Finding engine
        │
        ├─ verify PR head SHA before report writes
        ├─ mutate only comments owned by the ROD GitHub App
        ├─ verify PR head SHA again after writes
        └─ complete Check Run
```

The reported startup port is the port that actually answered the HTTP probe, not merely the first listening socket. ROD accepts HTTP 2xx–4xx as reachable; persistent 5xx responses are reported as startup failures. If the observation budget expires while the start process is still alive, ROD reports `RUNNER_TIMEOUT` instead of claiming the repository start command is broken.

## Security model

Repository code is untrusted. ROD therefore:

1. verifies every GitHub webhook with `X-Hub-Signature-256`;
2. uses the GitHub installation token only in the control plane;
3. treats Node 22/24/26 and Python 3.13 as candidate runtime lines, then checks the exact Sandbox version with `node --version` or `python --version` before repository commands run;
4. skips setup/start with `RUNNER_RUNTIME_UNSUPPORTED` when the actual Sandbox minor/patch version does not satisfy the repository constraint;
5. downloads the repository archive before creating the execution environment and never forwards GitHub credentials into repository code;
6. passes only `CI=1` and `ROD_SANDBOX=1` into the Sandbox;
7. executes only a narrow allowlist of onboarding commands from README examples;
8. restricts `.env.example` copies to root `.env`, `.env.local`, or `.env.development.local` destinations;
9. blocks obvious deploy/publish/cloud/remote-shell commands;
10. limits the Sandbox to 240 seconds and applies shorter command deadlines;
11. records install/start budget exhaustion as a ROD runner limitation rather than a repository failure;
12. identifies reusable PR reports by both the hidden ROD marker and `performed_via_github_app.id === GITHUB_APP_ID`; user comments and other bots are never PATCH/DELETE targets;
13. wraps untrusted stdout/stderr evidence in a Markdown fence longer than any backtick run contained in the log;
14. always stops the Sandbox in a `finally` block.

The command policy is intentionally conservative. Commands ROD will not safely reproduce should become explicit findings instead of being executed blindly.

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

Each diagnosis is tied to the webhook's PR head SHA. ROD checks the current head before report publication and again after each comment write. If the SHA changes after a PATCH/POST, ROD removes only its own stale report body if it is still present, marks the old Check Run superseded, and leaves a newer report untouched. Same-head first-run comment races are deduplicated using a hidden full-SHA marker. Reports also include the diagnosed short SHA for incident tracing.

A marker alone is never trusted as report identity. ROD filters issue comments by the GitHub App recorded in `performed_via_github_app`, using the configured numeric `GITHUB_APP_ID`, before choosing a canonical report or deleting duplicates.

## Runtime consistency rule

ROD treats the repository's declared runtime constraint as the source of truth. A README requirement is considered consistent only when every version it tells a user to use is supported by the repository:

```text
README range ⊆ repository range
```

Examples:

```text
repo >=22, README >=20      -> mismatch
repo >=22, README >=22      -> ok
repo >=22, README 22        -> ok
repo >=3.12, README >=3.10  -> mismatch
```

This avoids accepting documentation that is merely *partially* compatible with the repository.

Runtime execution uses a separate rule. Major-line selection only chooses a candidate Sandbox. Before any README setup/start command is executed, ROD reads the exact runtime version and checks that exact version against the repository constraint. For example, a repository requiring `>=22.0 <22.1` may select the Node 22 Sandbox candidate, but ROD will skip execution if that Sandbox currently reports Node `22.15.0`.

## Environment variables

Copy the example file:

```bash
cp .env.example .env.local
```

Required values:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

`GITHUB_APP_ID` must be the positive numeric ID of the ROD GitHub App; it is also used to authenticate ownership of report comments.

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

- Node execution is limited to Vercel Sandbox Node 22/24/26 candidate runtime lines. ROD verifies the exact selected Node version before repository execution and skips when it does not satisfy the repository requirement.
- Python execution currently uses the Python 3.13 candidate runtime. ROD verifies the exact Python version before repository execution and skips incompatible minor/patch constraints as a runner limitation.
- Install commands have a 150-second execution budget and startup HTTP observation has a 40-second budget. Budget exhaustion is reported as `RUNNER_TIMEOUT`, not `INSTALL_BROKEN` or `COMMAND_BROKEN`.
- It does not provision databases or third-party services for the target repository.
- Environment-variable detection is static and intentionally biased toward common Node.js and Python patterns.
- “Stale explanation” detection currently covers concrete script/runtime/port contradictions; semantic prose drift is reserved for the AI-assisted analyzer phase.
- Diagnoses currently run from Next.js `after()`. The Sandbox lifetime is capped below the Route's 300-second maximum, but PR-scoped durable concurrency/cancellation remains the production-grade completion for eliminating the last distributed TOCTOU/concurrency edge cases.
