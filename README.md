# ROD 🩺

**Repo Onboarding Doctor** verifies that a repository can actually be set up from its README in a fresh environment.

When a pull request is opened or updated, ROD starts a durable Workflow run, reproduces the documented setup inside an isolated Vercel Sandbox, and publishes a reusable PR report plus a GitHub Check Run.

## What ROD detects

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
  ├─ atomically claim X-GitHub-Delivery in durable Redis
  ├─ duplicate delivery → return 202 without starting another run
  └─ start Workflow run → return 202 + runId
        │
        ▼
Workflow SDK
  ├─ durably confirm this run still owns the delivery claim
  └─ durable diagnosis step
        │
        ├─ verify PR head SHA
        ├─ settle an earlier-attempt Check if this run became stale
        ├─ reuse this Workflow run's Check Run on retry
        ├─ read README/runtime metadata
        ├─ download source archive
        ├─ verify PR head again before Sandbox allocation
        │
        ▼
Vercel Sandbox (no GitHub token)
  ├─ select candidate Node/Python runtime line
  ├─ measure exact node/python version
  ├─ verify it satisfies repository constraint
  ├─ unpack source + scan env references
  ├─ install dependencies
  ├─ start app
  └─ poll until an HTTP endpoint responds
        │
        ▼
Finding engine
  ├─ verify PR head SHA before/after report writes
  ├─ mutate only comments owned by the ROD GitHub App
  └─ complete Check Run
```

Workflow functions only coordinate durable execution. GitHub, Sandbox, crypto, Redis delivery-claim I/O, and other Node.js work runs inside route or `"use step"` contexts.

## Durable execution

ROD uses the Workflow SDK so the webhook request is no longer responsible for keeping a diagnosis alive. The webhook calls `start()` and returns immediately; the diagnosis continues with its own durable lifecycle.

A run can become obsolete when a newer `synchronize` event arrives. ROD checks the PR head before creating new work, again immediately before Sandbox allocation, and around report publication. If a retry discovers that the PR moved after an earlier attempt already created a Check Run, ROD finds that Workflow-owned Check and completes it as neutral/superseded before returning.

Workflow steps retry unhandled failures. Check Runs therefore use the Workflow run ID as their retry identity: retries inside the same Workflow run reuse the same ROD-owned Check Run, while a separate Workflow run cannot overwrite that run's Check status. Check lookup explicitly requests `filter=all`, scopes to the ROD GitHub App, and paginates results so an older Check is not lost behind GitHub's default latest-only filter. A final failure is written only after the diagnosis step has exhausted its retries.

### Webhook delivery idempotency

ROD uses `X-GitHub-Delivery` as a durable request key before calling `start()`. The route issues Redis `SET key value EX <pending-ttl> NX`; concurrent or redelivered requests that do not win the atomic create return HTTP 202 without creating another Workflow run.

A newly claimed delivery starts as a short pending lease. The Workflow's first durable step compares the pending claim token and atomically promotes only the owning run to a confirmed claim containing its Workflow run ID. Confirmed claims live for seven days by default. Both promotion and cleanup use compare-and-set Lua scripts, so one request cannot overwrite or release another request's claim.

If `start()` throws, the route attempts to release only its own still-pending claim. If the Workflow was actually accepted despite an ambiguous response and confirms ownership first, the release CAS fails harmlessly and that run remains the owner. If the route releases first and a retry acquires the delivery, the older run cannot confirm the new claim and exits before diagnosis/Sandbox work.

The claim store uses the Upstash Redis REST API so it can run from serverless route and Workflow step contexts without a persistent TCP connection. Provision/connect a durable Redis resource through Vercel Marketplace (or provide compatible Upstash REST credentials) and expose the environment variables listed below.

Useful local inspection commands:

```bash
npm run workflow:inspect
npm run workflow:web
```

## Runtime consistency rule

The repository's declared runtime constraint is the source of truth. README runtime documentation is consistent only when:

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

Runtime execution uses a separate rule. Node 22/24/26 and Python 3.13 are only candidate Sandbox lines. Before repository commands run, ROD reads the exact runtime version and verifies that exact version against the repository constraint. If it cannot prove compatibility, setup/start is skipped with `RUNNER_RUNTIME_UNSUPPORTED`.

## Startup verification

A listening socket alone is not success. ROD polls observed application ports and uses the port that actually answered the HTTP probe.

- HTTP 2xx–4xx: reachable
- persistent HTTP 5xx: startup failure
- process still alive when the observation budget expires: `RUNNER_TIMEOUT`

Install timeout is also reported as `RUNNER_TIMEOUT`, not `INSTALL_BROKEN`.

## Security model

Repository code is untrusted. ROD therefore:

1. verifies every GitHub webhook with `X-Hub-Signature-256`;
2. atomically deduplicates authenticated delivery GUIDs in a durable external store before starting expensive work;
3. uses GitHub installation credentials only in the control plane and never forwards them into repository code;
4. verifies the exact Sandbox runtime before repository commands execute;
5. runs only a narrow allowlist of onboarding commands;
6. restricts `.env.example` copies to root `.env`, `.env.local`, or `.env.development.local` destinations;
7. blocks obvious deploy/publish/cloud/remote-shell commands;
8. limits Sandbox and command execution budgets;
9. identifies reusable reports by both a hidden ROD marker and `performed_via_github_app.id === GITHUB_APP_ID`;
10. wraps untrusted stdout/stderr in a Markdown fence longer than any backtick run in the log;
11. always stops the Sandbox in a `finally` block.

## GitHub App configuration

Repository permissions:

- **Metadata:** Read-only
- **Contents:** Read-only
- **Pull requests:** Read & write
- **Checks:** Read & write

Subscribe to the **Pull request** webhook event and point it at:

```text
https://YOUR_DEPLOYMENT/api/github/webhook
```

ROD reacts to `opened`, `reopened`, `synchronize`, and `ready_for_review`.

## Environment variables

```bash
cp .env.example .env.local
```

Required:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

`GITHUB_APP_ID` must be the positive numeric ID of the ROD GitHub App. It is also used to authenticate ownership of reusable report comments.

`UPSTASH_REDIS_REST_URL` must be HTTPS. `UPSTASH_REDIS_REST_TOKEN` needs write access because ROD uses `SET`, `EVAL`, and `DEL` for delivery claims. The standard token must remain server-side.

Optional delivery-claim tuning:

- `ROD_DELIVERY_PENDING_TTL_SECONDS` — short pre-confirmation lease, default `120`
- `ROD_DELIVERY_CLAIM_TTL_SECONDS` — confirmed retention, default `604800` (7 days)

The confirmed TTL must be greater than the pending TTL.

Vercel Sandbox and Workflow use the deployment's Vercel integration/runtime configuration. Local Sandbox development can additionally use `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` where needed.

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

The Workflow TypeScript plugin is enabled alongside the Next.js plugin in `tsconfig.json` so editor/type tooling understands the Workflow directives.

## Current limits

- Node execution is limited to candidate Sandbox lines Node 22/24/26; the exact selected version is verified before repository execution.
- Python execution currently uses the Python 3.13 candidate line; the exact selected version is verified before repository execution.
- Install commands have a 150-second budget and startup HTTP observation has a 40-second budget.
- ROD does not provision databases or third-party services for target repositories yet.
- Environment-variable detection is static and intentionally focused on common Node.js and Python patterns.
- Semantic prose drift is not AI-assisted yet.
- Durable execution prevents request-lifetime failures and stale runs are suppressed, but active in-flight Sandbox cancellation on a newer SHA is still a later optimization.
- Webhook delivery idempotency depends on the configured durable Redis REST store; confirmed claims expire after the configured retention window.
