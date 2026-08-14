import { Sandbox } from "@vercel/sandbox";
import { parseEnvScanOutput } from "../analyzer/env-scan";
import { isSafeOnboardingCommand } from "../analyzer/readme";
import {
  nodeReadmeRequirementFitsRepo,
  pythonReadmeRequirementFitsRepo,
  selectNodeSandboxRuntime,
  supportsPython313,
} from "../analyzer/runtime";
import type {
  CommandObservation,
  ExecutionObservation,
  ReadmePlan,
  ReadmeStep,
  RepoFacts,
  StepResult,
} from "../analyzer/types";

const REPO_DIR = "/vercel/sandbox/repo";
const ARCHIVE_PATH = "/vercel/sandbox/rod-repo.tar.gz";
const COMMON_PORTS = [3000, 3001, 4173, 5000, 5173, 8000, 8080];
const SANDBOX_TIMEOUT_MS = 240_000;
const INSTALL_TIMEOUT_SECONDS = 150;
const PREP_TIMEOUT_SECONDS = 20;
const PROBE_TIMEOUT_MS = 40_000;
const PROBE_INTERVAL_MS = 2_000;

export interface SandboxDiagnosisResult {
  execution: ExecutionObservation;
  requiredEnv: string[];
}

type SandboxRuntime = "node22" | "node24" | "node26" | "python3.13";

function chooseRuntime(facts: RepoFacts): { runtime: SandboxRuntime | null; issue: string | null } {
  const isPythonProject = ["pip", "poetry", "uv"].includes(facts.packageManager ?? "")
    || Boolean(facts.inferredStartCommand?.match(/^(?:python|python3|uvicorn|flask|poetry|uv)\b/));

  if (isPythonProject) {
    if (!supportsPython313(facts.pythonRequirement)) {
      return {
        runtime: null,
        issue: `Repository requires Python ${facts.pythonRequirement ?? "an unsupported version"}, while ROD currently provides Python 3.13 for execution.`,
      };
    }
    return { runtime: "python3.13", issue: null };
  }

  const runtime = selectNodeSandboxRuntime(facts.nodeRequirement);
  if (!runtime) {
    return {
      runtime: null,
      issue: `Repository requires Node.js ${facts.nodeRequirement ?? "an unsupported version"}, while ROD currently provides Node.js 22, 24, and 26.`,
    };
  }
  return { runtime, issue: null };
}

function extractExactVersion(output: string): string | null {
  return output.match(/\bv?(\d+\.\d+\.\d+)\b/i)?.[1] ?? null;
}

async function readActualRuntimeVersion(sandbox: Sandbox, runtime: SandboxRuntime): Promise<string | null> {
  const commands = runtime === "python3.13"
    ? [{ cmd: "python3", args: ["--version"] }, { cmd: "python", args: ["--version"] }]
    : [{ cmd: "node", args: ["--version"] }];

  for (const command of commands) {
    const result = await sandbox.runCommand({ cmd: command.cmd, args: command.args });
    if (result.exitCode !== 0) continue;
    const output = `${await result.stdout()}\n${await result.stderr()}`;
    const version = extractExactVersion(output);
    if (version) return version;
  }
  return null;
}

async function verifyActualRuntime(
  sandbox: Sandbox,
  runtime: SandboxRuntime,
  facts: RepoFacts,
): Promise<string | null> {
  const actualVersion = await readActualRuntimeVersion(sandbox, runtime);
  const runtimeName = runtime === "python3.13" ? "Python" : "Node.js";
  const requirement = runtime === "python3.13" ? facts.pythonRequirement : facts.nodeRequirement;

  if (!actualVersion) {
    return `ROD selected ${runtime}, but could not determine its exact ${runtimeName} version before running repository code.`;
  }

  const satisfies = runtime === "python3.13"
    ? pythonReadmeRequirementFitsRepo(requirement, actualVersion)
    : nodeReadmeRequirementFitsRepo(requirement, actualVersion);

  if (satisfies === true) return null;
  if (satisfies === null) {
    return `ROD could not safely evaluate repository ${runtimeName} requirement ${requirement ?? "(none)"} against the actual Sandbox version ${actualVersion}.`;
  }
  return `Repository requires ${runtimeName} ${requirement ?? "an unsupported version"}, but the selected ROD Sandbox currently provides ${runtimeName} ${actualVersion}. Setup and start were skipped.`;
}

async function runShell(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds: number,
  observationCommand = command,
): Promise<CommandObservation> {
  const result = await sandbox.runCommand({
    cmd: "timeout",
    args: ["--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`, "bash", "-lc", command],
    cwd: REPO_DIR,
  });
  return {
    command: observationCommand,
    exitCode: result.exitCode,
    stdout: await result.stdout(),
    stderr: await result.stderr(),
    timedOut: result.exitCode === 124,
  };
}

function commandFailed(command: CommandObservation): boolean {
  return command.timedOut || command.exitCode !== 0;
}

async function detectRequiredEnv(sandbox: Sandbox): Promise<string[]> {
  const command = [
    "grep -RInE",
    "--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=.venv",
    "--include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.cjs' --include='*.py'",
    "'process\\.env\\.|process\\.env\\[|getenv\\(|os\\.environ'",
    ". 2>/dev/null | head -c 200000 || true",
  ].join(" ");
  const scan = await runShell(sandbox, command, PREP_TIMEOUT_SECONDS);
  return parseEnvScanOutput(scan.stdout);
}

async function preparePackageManager(sandbox: Sandbox, facts: RepoFacts): Promise<void> {
  if (facts.packageManager === "pnpm" || facts.packageManager === "yarn") {
    await runShell(sandbox, "corepack enable >/dev/null 2>&1 || true", PREP_TIMEOUT_SECONDS);
  }
}

function normalizePreparationCommand(command: string): string {
  return /^copy\s+/i.test(command) ? command.replace(/^copy\b/i, "cp") : command;
}

async function startApplication(sandbox: Sandbox, command: string): Promise<void> {
  await sandbox.writeFiles([
    {
      path: "/tmp/rod-start.sh",
      content: Buffer.from(`#!/usr/bin/env bash\nset -o pipefail\necho $$ > /tmp/rod-start.pid\ncd ${REPO_DIR}\nexec ${command} > /tmp/rod-start.log 2>&1\n`),
      mode: 0o700,
    },
  ]);
  await sandbox.runCommand({
    cmd: "/tmp/rod-start.sh",
    cwd: REPO_DIR,
    detached: true,
    env: {
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
    },
  });
}

export function extractPortsFromStartCommand(command: string | null): number[] {
  if (!command) return [];
  const ports = new Set<number>();
  const patterns = [
    /(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/gi,
    /(?:^|\s)-p\s+(\d{2,5})(?=\s|$)/gi,
    /(?:^|\s)PORT=(\d{2,5})(?=\s|$)/g,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    }
  }
  return [...ports];
}

async function readListeningPorts(sandbox: Sandbox): Promise<number[]> {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      "awk 'NR > 1 && $4 == \"0A\" { split($2, a, \":\"); print a[2] }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | while IFS= read -r hex; do printf '%d\\n' \"0x$hex\"; done | sort -n -u",
    ],
  });
  if (result.exitCode !== 0) return [];
  return (await result.stdout())
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function orderedProbePorts(
  exposedPorts: number[],
  preferredPort: number | null,
  commandPorts: number[],
  listeningPorts: number[],
  baselinePorts: Set<number>,
): number[] {
  return [...new Set([
    ...(preferredPort ? [preferredPort] : []),
    ...commandPorts,
    ...listeningPorts,
    ...exposedPorts,
  ])].filter((port) => !baselinePorts.has(port));
}

async function probeLocalHttpStatus(sandbox: Sandbox, port: number): Promise<number | null> {
  const script = [
    `port=${port}`,
    "exec 3<>/dev/tcp/127.0.0.1/$port || exit 1",
    "printf 'GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3",
    "IFS= read -r status_line <&3 || exit 1",
    "printf '%s' \"$status_line\"",
  ].join("; ");
  const result = await sandbox.runCommand({
    cmd: "timeout",
    args: ["--signal=TERM", "3s", "bash", "-lc", script],
  });
  if (result.exitCode !== 0) return null;
  const statusLine = (await result.stdout()).trim();
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function observedUrlForPort(sandbox: Sandbox, port: number, exposedPorts: number[]): string {
  if (!exposedPorts.includes(port)) return `http://localhost:${port}`;
  const domain = sandbox.domain(port);
  return domain.startsWith("http://") || domain.startsWith("https://") ? domain : `https://${domain}`;
}

async function probeObservedUrl(
  sandbox: Sandbox,
  exposedPorts: number[],
  preferredPort: number | null,
  startCommand: string,
  baselinePorts: Set<number>,
): Promise<{ port: number; url: string; status: number } | null> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  const commandPorts = extractPortsFromStartCommand(startCommand);
  let lastServerError: { port: number; url: string; status: number } | null = null;

  while (Date.now() < deadline) {
    const listeningPorts = await readListeningPorts(sandbox);
    const orderedPorts = orderedProbePorts(
      exposedPorts,
      preferredPort,
      commandPorts,
      listeningPorts,
      baselinePorts,
    );

    for (const port of orderedPorts) {
      const localStatus = await probeLocalHttpStatus(sandbox, port);
      if (localStatus === null) continue;
      const observation = {
        port,
        url: observedUrlForPort(sandbox, port, exposedPorts),
        status: localStatus,
      };
      if (localStatus < 500) return observation;
      lastServerError = observation;
    }
    await sandbox.runCommand("sleep", [String(PROBE_INTERVAL_MS / 1000)]);
  }
  return lastServerError;
}

async function readStartLog(sandbox: Sandbox): Promise<string> {
  const logResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "tail -c 20000 /tmp/rod-start.log 2>/dev/null || true"],
  });
  return await logResult.stdout();
}

async function isStartProcessAlive(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "pid=$(cat /tmp/rod-start.pid 2>/dev/null) && [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null"],
  });
  return result.exitCode === 0;
}

function runtimeBlockedExecution(plan: ReadmePlan, runtimeIssue: string): ExecutionObservation {
  return {
    preparation: [],
    unsupportedCommands: [],
    install: null,
    startCommand: null,
    startLog: "",
    observedPort: null,
    observedUrl: null,
    httpStatus: null,
    startupTimedOut: false,
    runtimeIssue,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: "blocked",
      reason: "runtime-unsupported",
    })),
    preexistingPorts: [],
  };
}

function skippedResult(step: ReadmeStep, reason: "unsafe" | "unsupported" | "after-start" | "previous-failure"): StepResult {
  return { stepId: step.id, status: reason === "previous-failure" ? "blocked" : "skipped", reason };
}

function unsupportedCommandsFromSteps(plan: ReadmePlan, results: StepResult[]): string[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return results
    .filter((result) => result.status === "skipped" && result.reason !== undefined)
    .map((result) => byId.get(result.stepId)?.command)
    .filter((command): command is string => Boolean(command));
}

export async function runSandboxDiagnosis(
  archive: Buffer,
  plan: ReadmePlan,
  facts: RepoFacts,
): Promise<SandboxDiagnosisResult> {
  const selection = chooseRuntime(facts);
  const documentedStart = plan.steps.find((step) => step.role === "start") ?? null;
  const diagnosticStartCommand = documentedStart?.command ?? facts.inferredStartCommand;
  const exposedPorts = [...new Set([
    ...COMMON_PORTS,
    ...(plan.expectedPort && plan.expectedPort > 0 && plan.expectedPort <= 65535 ? [plan.expectedPort] : []),
    ...extractPortsFromStartCommand(diagnosticStartCommand),
  ])];

  const sandbox = await Sandbox.create({
    runtime: selection.runtime ?? "node24",
    timeout: SANDBOX_TIMEOUT_MS,
    ports: exposedPorts,
    env: {
      CI: "1",
      ROD_SANDBOX: "1",
    },
  });

  try {
    const actualRuntimeIssue = selection.runtime
      ? await verifyActualRuntime(sandbox, selection.runtime, facts)
      : selection.issue;

    await sandbox.writeFiles([{ path: ARCHIVE_PATH, content: archive, mode: 0o600 }]);
    const extract = await sandbox.runCommand({
      cmd: "timeout",
      args: ["--signal=TERM", "30s", "bash", "-lc", `mkdir -p ${REPO_DIR} && tar -xzf ${ARCHIVE_PATH} -C ${REPO_DIR} --strip-components=1`],
    });
    if (extract.exitCode !== 0) {
      throw new Error(`Could not extract repository archive: ${await extract.stderr()}`);
    }

    const requiredEnv = await detectRequiredEnv(sandbox);
    if (actualRuntimeIssue) {
      return { requiredEnv, execution: runtimeBlockedExecution(plan, actualRuntimeIssue) };
    }

    await preparePackageManager(sandbox, facts);

    const stepResults: StepResult[] = [];
    const preparation: CommandObservation[] = [];
    let install: CommandObservation | null = null;
    let startCommand: string | null = null;
    let startLog = "";
    let observedPort: number | null = null;
    let observedUrl: string | null = null;
    let httpStatus: number | null = null;
    let startupTimedOut = false;
    let preexistingPorts: number[] = [];
    let previousFailure = false;
    let afterStart = false;
    let documentedInstallAttempted = false;

    for (const step of plan.steps) {
      if (afterStart) {
        stepResults.push(skippedResult(step, "after-start"));
        continue;
      }
      if (previousFailure) {
        stepResults.push(skippedResult(step, "previous-failure"));
        continue;
      }
      if (!isSafeOnboardingCommand(step.command)) {
        stepResults.push(skippedResult(step, "unsafe"));
        if (step.role === "start") afterStart = true;
        continue;
      }
      if (step.role === "other") {
        stepResults.push(skippedResult(step, "unsupported"));
        continue;
      }

      if (step.role === "preparation") {
        const observation = await runShell(
          sandbox,
          normalizePreparationCommand(step.command),
          PREP_TIMEOUT_SECONDS,
          step.command,
        );
        preparation.push(observation);
        const failed = commandFailed(observation);
        stepResults.push({
          stepId: step.id,
          status: failed ? "failed" : "executed",
          observation,
        });
        previousFailure = failed;
        continue;
      }

      if (step.role === "install") {
        documentedInstallAttempted = true;
        const observation = await runShell(sandbox, step.command, INSTALL_TIMEOUT_SECONDS);
        install = observation;
        const failed = commandFailed(observation);
        stepResults.push({
          stepId: step.id,
          status: failed ? "failed" : "executed",
          observation,
        });
        previousFailure = failed;
        continue;
      }

      if (step.role === "start") {
        if (!documentedInstallAttempted && facts.inferredInstallCommand && isSafeOnboardingCommand(facts.inferredInstallCommand)) {
          const fallbackInstall = await runShell(sandbox, facts.inferredInstallCommand, INSTALL_TIMEOUT_SECONDS);
          install = fallbackInstall;
          if (commandFailed(fallbackInstall)) {
            stepResults.push({ stepId: step.id, status: "blocked", reason: "previous-failure" });
            previousFailure = true;
            afterStart = true;
            continue;
          }
        }

        startCommand = step.command;
        const baseline = await readListeningPorts(sandbox);
        preexistingPorts = baseline;
        const baselineSet = new Set(baseline);
        await startApplication(sandbox, step.command);
        const probe = await probeObservedUrl(
          sandbox,
          exposedPorts,
          plan.expectedPort,
          step.command,
          baselineSet,
        );
        startLog = await readStartLog(sandbox);
        if (probe) {
          observedPort = probe.port;
          observedUrl = probe.url;
          httpStatus = probe.status;
        } else {
          startupTimedOut = await isStartProcessAlive(sandbox);
        }
        const startSucceeded = Boolean(probe && probe.status < 500);
        stepResults.push({ stepId: step.id, status: startSucceeded ? "executed" : "failed" });
        afterStart = true;
      }
    }

    if (!afterStart && !previousFailure && facts.inferredStartCommand && isSafeOnboardingCommand(facts.inferredStartCommand)) {
      if (!documentedInstallAttempted && facts.inferredInstallCommand && isSafeOnboardingCommand(facts.inferredInstallCommand)) {
        install = await runShell(sandbox, facts.inferredInstallCommand, INSTALL_TIMEOUT_SECONDS);
        previousFailure = commandFailed(install);
      }
      if (!previousFailure) {
        startCommand = facts.inferredStartCommand;
        const baseline = await readListeningPorts(sandbox);
        preexistingPorts = baseline;
        const baselineSet = new Set(baseline);
        await startApplication(sandbox, startCommand);
        const probe = await probeObservedUrl(
          sandbox,
          exposedPorts,
          plan.expectedPort,
          startCommand,
          baselineSet,
        );
        startLog = await readStartLog(sandbox);
        if (probe) {
          observedPort = probe.port;
          observedUrl = probe.url;
          httpStatus = probe.status;
        } else {
          startupTimedOut = await isStartProcessAlive(sandbox);
        }
      }
    }

    return {
      requiredEnv,
      execution: {
        preparation,
        unsupportedCommands: unsupportedCommandsFromSteps(plan, stepResults),
        install,
        startCommand,
        startLog,
        observedPort,
        observedUrl,
        httpStatus,
        startupTimedOut,
        runtimeIssue: null,
        stepResults,
        preexistingPorts,
      },
    };
  } finally {
    await sandbox.stop();
  }
}
