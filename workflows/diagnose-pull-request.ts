import { getWorkflowMetadata } from "workflow";
import type {
  DiagnosePullRequestInput,
  DiagnosePullRequestResult,
} from "../lib/orchestrator/diagnose-pr";

async function runDiagnosisStep(
  input: DiagnosePullRequestInput,
  workflowRunId: string,
): Promise<DiagnosePullRequestResult> {
  "use step";

  console.log(
    `[ROD workflow] diagnosis step start run=${workflowRunId} pr=${input.baseRepository}#${input.pullNumber} sha=${input.headSha}`,
  );

  try {
    // Keep Node.js-only dependencies (Octokit, Sandbox, crypto) inside the step runtime.
    const { diagnosePullRequest } = await import("../lib/orchestrator/diagnose-pr");
    const result = await diagnosePullRequest(input, { workflowRunId });
    console.log(
      `[ROD workflow] diagnosis step done run=${workflowRunId} status=${result.status} sha=${input.headSha}`,
    );
    return result;
  } catch (error) {
    console.error(
      `[ROD workflow] diagnosis step attempt failed run=${workflowRunId} sha=${input.headSha}`,
      error,
    );
    throw error;
  }
}

async function finalizeFailureStep(
  input: DiagnosePullRequestInput,
  workflowRunId: string,
  errorMessage: string,
): Promise<void> {
  "use step";

  const { failPullRequestDiagnosis } = await import("../lib/orchestrator/diagnose-pr");
  await failPullRequestDiagnosis(input, { workflowRunId }, errorMessage);
  console.error(
    `[ROD workflow] diagnosis permanently failed run=${workflowRunId} sha=${input.headSha} error=${errorMessage}`,
  );
}

export async function diagnosePullRequestWorkflow(
  input: DiagnosePullRequestInput,
): Promise<DiagnosePullRequestResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  try {
    return await runDiagnosisStep(input, workflowRunId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await finalizeFailureStep(input, workflowRunId, errorMessage);
    throw error;
  }
}
