import {
  npmScriptReferencedByCommand,
  parseOnboardingCommand,
  readmeRuntimeKind,
} from "./readme";
import { nodeReadmeRequirementFitsRepo, pythonReadmeRequirementFitsRepo } from "./runtime";
import type {
  CommandObservation,
  EnvTemplateName,
  ExecutionObservation,
  Finding,
  ReadmePlan,
  ReadmeStep,
  RepoFacts,
  StepResult,
} from "./types";

const LEGACY_ENV_COPY = /^(?:cp|copy)\s+(\.env(?:\.example|\.sample))\s+\.env(?:\.local|\.development\.local)?\s*$/i;

function excerpt(text: string, max = 500): string {
  const normalized = text.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function commandFailed(command: CommandObservation): boolean {
  return command.timedOut || command.exitCode !== 0;
}

function stepResultById(run: ExecutionObservation): Map<string, StepResult> | null {
  if (!run.stepResults) return null;
  return new Map(run.stepResults.map((result) => [result.stepId, result]));
}

function unreproducedSteps(plan: ReadmePlan, run: ExecutionObservation): ReadmeStep[] {
  const resultMap = stepResultById(run);
  if (resultMap) {
    return plan.steps.filter((step) => {
      const result = resultMap.get(step.id);
      if (!result) return true;
      return result.status === "skipped"
        && ["unsafe", "unsupported", "malformed", "after-start"].includes(result.reason ?? "");
    });
  }

  const reproduced = new Set(run.preparation.map((command) => command.command));
  if (plan.installCommand && run.install?.command === plan.installCommand) reproduced.add(plan.installCommand);
  if (plan.startCommand && run.startCommand === plan.startCommand) reproduced.add(plan.startCommand);
  return plan.steps.filter((step) => !reproduced.has(step.command));
}

function successfulEnvCopySources(plan: ReadmePlan, run: ExecutionObservation): Set<EnvTemplateName> {
  const sources = new Set<EnvTemplateName>();
  const resultMap = stepResultById(run);
  if (resultMap) {
    for (const step of plan.steps) {
      const parsed = parseOnboardingCommand(step.command, step.malformed);
      if (!parsed.envCopySource) continue;
      const result = resultMap.get(step.id);
      if (result?.status === "executed" && result.observation && !commandFailed(result.observation)) {
        sources.add(parsed.envCopySource);
      }
    }
    return sources;
  }

  for (const command of run.preparation) {
    if (commandFailed(command)) continue;
    const match = command.command.match(LEGACY_ENV_COPY);
    if (match) sources.add(match[1].toLowerCase() as EnvTemplateName);
  }
  return sources;
}

function pushRuntimeFinding(
  findings: Finding[],
  runtime: "Node.js" | "Python",
  repoRequirement: string | null,
  readmeRequirement: string | null,
  readmeFitsRepo: boolean | null,
): void {
  if (repoRequirement && !readmeRequirement) {
    findings.push({
      code: "RUNTIME_UNDOCUMENTED",
      severity: "warning",
      title: `${runtime} version is not documented`,
      detail: `The repository declares ${runtime} ${repoRequirement}, but the README does not state a ${runtime} version.`,
      suggestion: `Add ${runtime} ${repoRequirement} to the prerequisites.`,
    });
    return;
  }

  if (repoRequirement && readmeRequirement && readmeFitsRepo === false) {
    findings.push({
      code: "RUNTIME_MISMATCH",
      severity: "warning",
      title: `README ${runtime} version is broader than the repository supports`,
      detail: `README allows ${runtime} ${readmeRequirement}, while repository configuration allows ${repoRequirement}. The README range includes versions outside the repository range.`,
      suggestion: `Narrow the README requirement so every documented version is supported by the repository, for example ${repoRequirement}.`,
    });
  }
}

function preexistingExpectedPortConflict(plan: ReadmePlan, run: ExecutionObservation): number | null {
  if (!run.preexistingPorts?.length || run.observedPort !== null) return null;
  if (plan.expectedPort && run.preexistingPorts.includes(plan.expectedPort)) return plan.expectedPort;
  if (run.startCommand) {
    const hinted = parseOnboardingCommand(run.startCommand).portHints[0] ?? null;
    if (hinted && run.preexistingPorts.includes(hinted)) return hinted;
  }
  return null;
}

function inferredInstallForPlan(plan: ReadmePlan, facts: RepoFacts): string | null {
  const runtime = readmeRuntimeKind(plan);
  if (runtime === "python") return facts.inferredPythonInstallCommand ?? facts.inferredInstallCommand;
  if (runtime === "node") return facts.inferredNodeInstallCommand ?? facts.inferredInstallCommand;
  return facts.inferredInstallCommand;
}

function inferredStartForPlan(plan: ReadmePlan, facts: RepoFacts): string | null {
  const runtime = readmeRuntimeKind(plan);
  if (runtime === "python") return null;
  return facts.inferredNodeStartCommand ?? facts.inferredStartCommand;
}

function readmeMentionsEnv(readme: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Z0-9_])${escaped}(?![A-Z0-9_])`, "m").test(readme);
}

export function diagnose(readme: string, plan: ReadmePlan, facts: RepoFacts, run: ExecutionObservation): Finding[] {
  const findings: Finding[] = [];

  pushRuntimeFinding(
    findings,
    "Node.js",
    facts.nodeRequirement,
    plan.nodeRequirement,
    nodeReadmeRequirementFitsRepo(facts.nodeRequirement, plan.nodeRequirement),
  );
  pushRuntimeFinding(
    findings,
    "Python",
    facts.pythonRequirement,
    plan.pythonRequirement,
    pythonReadmeRequirementFitsRepo(facts.pythonRequirement, plan.pythonRequirement),
  );

  if (plan.flowIssue) {
    findings.push({
      code: "FLOW_AMBIGUOUS",
      severity: "warning",
      title: "README onboarding flow is ambiguous",
      detail: plan.flowIssue,
      suggestion: "Separate alternative setup/start paths into clearly labeled sections or document one canonical onboarding path.",
    });
    return findings;
  }

  if (run.runtimeIssue) {
    findings.push({
      code: "RUNNER_RUNTIME_UNSUPPORTED",
      severity: "warning",
      title: "ROD cannot reproduce this runtime requirement yet",
      detail: run.runtimeIssue,
      suggestion: "Treat this as a ROD runner limitation, not a repository setup failure.",
    });
  }
  if (run.runnerIssue) {
    findings.push({
      code: "RUNNER_TOOL_UNSUPPORTED",
      severity: "warning",
      title: "ROD runner is missing a required onboarding tool",
      detail: run.runnerIssue,
      suggestion: "Treat this as a ROD runner capability gap rather than a broken repository command.",
    });
  }

  const inferredInstall = inferredInstallForPlan(plan, facts);
  const inferredStart = inferredStartForPlan(plan, facts);
  if (inferredInstall && !plan.installCommand) {
    findings.push({
      code: "INSTALL_STEP_MISSING",
      severity: "warning",
      title: "Dependency installation is missing from the README",
      detail: "ROD inferred that dependency installation is required, but found no install step in the selected onboarding flow.",
      suggestion: "Document the dependency installation command before the development/start command.",
      evidence: [inferredInstall],
    });
  }

  if (inferredStart && !plan.startCommand) {
    findings.push({
      code: "START_STEP_MISSING",
      severity: "warning",
      title: "Application start command is missing from the README",
      detail: "ROD inferred a start command from repository configuration, but the selected onboarding flow does not tell a new contributor how to start the application.",
      suggestion: "Document the intended development/start command in the onboarding flow.",
      evidence: [inferredStart],
    });
  }

  for (const step of plan.steps) {
    const script = npmScriptReferencedByCommand(step.command);
    if (script && !facts.scripts[script]) {
      findings.push({
        code: "DOC_STALE",
        severity: "warning",
        title: `README references a missing script: ${script}`,
        detail: "A command in the selected onboarding flow refers to a package script that is not present in package.json.",
        evidence: [step.command],
        suggestion: "Remove the stale command or restore the script it refers to.",
      });
    }
  }

  if (run.runtimeIssue || run.runnerIssue) return findings;

  for (const step of unreproducedSteps(plan, run)) {
    findings.push({
      code: "RUNNER_COMMAND_UNSUPPORTED",
      severity: "warning",
      title: step.malformed ? "README shell command is incomplete" : "README command was not reproduced",
      detail: step.malformed
        ? "The selected onboarding flow contains an unfinished shell continuation, so ROD did not repair or execute it."
        : "ROD did not reproduce this occurrence in the selected onboarding flow. Inferred fallback commands are diagnostic-only and never count as reproducing a documented step.",
      evidence: [step.command],
      suggestion: step.malformed
        ? "Complete the multiline shell command in the README."
        : "Teach ROD how to reproduce this step explicitly, or rewrite the onboarding flow using runner-supported commands.",
    });
  }

  for (const preparation of run.preparation.filter(commandFailed)) {
    const output = preparation.stderr || preparation.stdout;
    findings.push({
      code: "PREPARATION_BROKEN",
      severity: preparation.timedOut ? "warning" : "error",
      title: preparation.timedOut ? "README preparation step timed out" : "README preparation step failed",
      detail: preparation.timedOut
        ? "ROD could not finish a documented preparation step within the preparation budget."
        : `A documented preparation step exited with code ${preparation.exitCode} before dependency installation/startup.`,
      evidence: [preparation.command, output].filter(Boolean),
      suggestion: "Fix the documented preparation step or document a portable equivalent that works in a fresh environment.",
    });
  }

  const successfulCopySources = successfulEnvCopySources(plan, run);
  for (const name of facts.requiredEnv) {
    const namedInReadme = readmeMentionsEnv(readme, name);
    const coveredByExample = [...successfulCopySources].some((source) => {
      const vars = facts.envFileVars?.[source]
        ?? (source === ".env.example" ? facts.envExampleVars : []);
      return vars.includes(name);
    });
    if (!namedInReadme && !coveredByExample) {
      findings.push({
        code: "ENV_MISSING",
        severity: "warning",
        title: `Environment variable ${name} is not documented`,
        detail: `Source code references ${name}, but the README does not mention it and a successfully copied env template did not contain it.`,
        suggestion: `Document ${name} or add it to the env template that the README actually tells users to copy.`,
      });
    }
  }

  if (run.install?.timedOut) {
    findings.push({
      code: "RUNNER_TIMEOUT",
      severity: "warning",
      title: "ROD timed out while installing dependencies",
      detail: "ROD reached its install execution budget. This does not prove the repository install is broken.",
      evidence: [run.install.command, excerpt(run.install.stderr || run.install.stdout)].filter(Boolean),
      suggestion: "Treat this as an inconclusive runner limitation. Retry with a larger durable execution budget before changing repository setup instructions.",
    });
  } else if (run.install && run.install.exitCode !== 0) {
    findings.push({
      code: "INSTALL_BROKEN",
      severity: "error",
      title: "Fresh dependency installation failed",
      detail: `The dependency installation step exited with code ${run.install.exitCode}.`,
      evidence: [run.install.command, excerpt(run.install.stderr || run.install.stdout)].filter(Boolean),
      suggestion: "Update the install instructions or dependency/lockfile state so a clean environment can install successfully.",
    });
  }

  const installBlockedStartup = Boolean(run.install && (run.install.timedOut || run.install.exitCode !== 0));
  const preexistingConflict = preexistingExpectedPortConflict(plan, run);
  if (preexistingConflict !== null) {
    findings.push({
      code: "RUNNER_PREEXISTING_LISTENER",
      severity: "warning",
      title: "Expected startup port was already in use before the start command",
      detail: `Port ${preexistingConflict} was already listening immediately before ROD launched the documented start command. ROD requires a new listener or a listener that disappears and is rebound after start.`,
      suggestion: "Ensure install/preparation steps do not leave a background server running on the application port.",
    });
  }

  if (run.startCommand && !installBlockedStartup) {
    const startExitedWithFailure = run.startExitCode !== null
      && run.startExitCode !== undefined
      && run.startExitCode !== 0;
    if (run.startupTimedOut) {
      findings.push({
        code: "RUNNER_TIMEOUT",
        severity: "warning",
        title: "ROD timed out waiting for the application to become reachable",
        detail: "The start process was still running when the HTTP observation budget expired. This does not prove the start command is broken.",
        evidence: [run.startCommand, run.startLog ? excerpt(run.startLog) : ""].filter(Boolean),
        suggestion: "Treat this run as inconclusive or move the diagnosis to a longer-lived durable runner before changing the README.",
      });
    } else if (startExitedWithFailure || run.observedPort === null || run.httpStatus === null || run.httpStatus >= 500) {
      const exited = run.startExitCode !== null && run.startExitCode !== undefined
        ? ` The start process exited with code ${run.startExitCode}.`
        : "";
      const responseDetail = run.httpStatus === null
        ? "No usable new HTTP response was observed."
        : startExitedWithFailure && run.httpStatus < 500
          ? `A child or leftover endpoint returned HTTP ${run.httpStatus}, but that does not override the failed start command.`
          : `The probed application endpoint returned HTTP ${run.httpStatus}.`;
      findings.push({
        code: "COMMAND_BROKEN",
        severity: "error",
        title: startExitedWithFailure ? "Development start command failed" : "Development server did not become reachable",
        detail: `ROD launched the selected start command, but it did not complete as a successful reproducible startup.${exited} ${responseDetail}`,
        evidence: [run.startCommand, run.startLog ? excerpt(run.startLog) : ""].filter(Boolean),
        suggestion: "Verify the README start command and document any required environment variables or prerequisite services.",
      });
    }
  }

  const observedPort = run.observedPort;
  if (observedPort && plan.expectedPort && observedPort !== plan.expectedPort) {
    findings.push({
      code: "PORT_MISMATCH",
      severity: "warning",
      title: "README port does not match the running app",
      detail: `README points to port ${plan.expectedPort}, but the HTTP endpoint ROD reached was on port ${observedPort}.`,
      suggestion: `Change the README URL to use port ${observedPort}, or configure the app to use ${plan.expectedPort}.`,
    });
  } else if (observedPort && !plan.expectedPort && !plan.expectedUrl) {
    findings.push({
      code: "START_URL_UNDOCUMENTED",
      severity: "info",
      title: "Startup URL is not documented",
      detail: `ROD reached the app on port ${observedPort}, but the selected onboarding flow does not provide a localhost URL.`,
      suggestion: `Add a line such as http://localhost:${observedPort} after the start command.`,
    });
  } else if (observedPort && !plan.expectedPort && plan.expectedUrl) {
    findings.push({
      code: "START_PORT_UNDOCUMENTED",
      severity: "info",
      title: "Startup port is not documented",
      detail: `The selected onboarding flow documents ${plan.expectedUrl}, but omits a port while ROD reached the app on port ${observedPort}.`,
      suggestion: `Document the actual development URL including port ${observedPort}.`,
    });
  }

  return findings;
}
