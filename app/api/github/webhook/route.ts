import { start } from "workflow/api";
import { githubConfig } from "../../../../lib/config";
import { verifyGitHubSignature } from "../../../../lib/github/signature";
import { diagnosePullRequestWorkflow } from "../../../../workflows/diagnose-pull-request-ordered";

export const runtime = "nodejs";

interface PullRequestWebhook {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    head?: {
      sha?: string;
      repo?: { full_name?: string } | null;
    };
  };
}

const SUPPORTED_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyGitHubSignature(rawBody, signature, githubConfig().webhookSecret)) {
    return Response.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") return Response.json({ ok: true, event: "ping" });
  if (event !== "pull_request") {
    return Response.json({ ok: true, ignored: event ?? "unknown" }, { status: 202 });
  }

  const payload = JSON.parse(rawBody) as PullRequestWebhook;
  if (!payload.action || !SUPPORTED_ACTIONS.has(payload.action)) {
    return Response.json(
      { ok: true, ignored: payload.action ?? "unknown-action" },
      { status: 202 },
    );
  }

  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  const installationId = payload.installation?.id;
  const baseRepository = payload.repository?.full_name;
  const sourceRepository = payload.pull_request?.head?.repo?.full_name;
  const pullNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (!deliveryId || !installationId || !baseRepository || !sourceRepository || !pullNumber || !headSha) {
    return Response.json(
      { ok: false, error: "incomplete pull_request delivery" },
      { status: 400 },
    );
  }

  const run = await start(diagnosePullRequestWorkflow, [{
    deliveryId,
    installationId,
    baseRepository,
    sourceRepository,
    pullNumber,
    headSha,
  }]);

  console.log(
    `[ROD webhook] started workflow run=${run.runId} delivery=${deliveryId} pr=${baseRepository}#${pullNumber} sha=${headSha}`,
  );

  return Response.json(
    { ok: true, accepted: true, runId: run.runId, deliveryId },
    { status: 202 },
  );
}
