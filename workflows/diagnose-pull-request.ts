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
    const result = await diagnosePullRequest(input);
    console.log(
      `[ROD workflow] diagnosis step done run=${workflowRunId} status=${result.status} sha=${input.headSha}`,
    );
    return result;
  } catch (error) {
    console.error(
      `[ROD workflow] diagnosis step failed run=${workflowRunId} sha=${input.headSha}`,
      error,
    );
    throw error;
  }
}

export async function diagnosePullRequestWorkflow(
  input: DiagnosePullRequestInput,
): Promise<DiagnosePullRequestResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  return runDiagnosisStep(input, workflowRunId);
}
