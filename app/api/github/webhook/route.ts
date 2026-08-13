import { after } from "next/server";
import { githubConfig } from "../../../../lib/config";
import { verifyGitHubSignature } from "../../../../lib/github/signature";
import { diagnosePullRequest } from "../../../../lib/orchestrator/diagnose-pr";

export const runtime = "nodejs";
// Keep the Route lifetime above the runner's 240s Sandbox cap so reporting has cleanup headroom.
export const maxDuration = 300;

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
  if (event !== "pull_request") return Response.json({ ok: true, ignored: event ?? "unknown" }, { status: 202 });

  const payload = JSON.parse(rawBody) as PullRequestWebhook;
  if (!payload.action || !SUPPORTED_ACTIONS.has(payload.action)) {
    return Response.json({ ok: true, ignored: payload.action ?? "unknown-action" }, { status: 202 });
  }

  const installationId = payload.installation?.id;
  const baseRepository = payload.repository?.full_name;
  const sourceRepository = payload.pull_request?.head?.repo?.full_name;
  const pullNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (!installationId || !baseRepository || !sourceRepository || !pullNumber || !headSha) {
    return Response.json({ ok: false, error: "incomplete pull_request payload" }, { status: 400 });
  }

  after(async () => {
    try {
      await diagnosePullRequest({ installationId, baseRepository, sourceRepository, pullNumber, headSha });
    } catch (error) {
      console.error("ROD diagnosis failed", error);
    }
  });

  return Response.json({ ok: true, accepted: true }, { status: 202 });
}
