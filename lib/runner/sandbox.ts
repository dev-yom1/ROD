import { Sandbox } from "@vercel/sandbox";
import { parseEnvScanOutput } from "../analyzer/env-scan";
import {
  parseOnboardingCommand,
  readmeRuntimeKind,
} from "../analyzer/readme";
import {
  nodeReadmeRequirementFitsRepo,
  pythonReadmeRequirementFitsRepo,
  selectNodeSandboxRuntimes,
  supportsPython313,
} from "../analyzer/runtime";
import type {
  CommandObservation,
  ExecutionObservation,
  ReadmePlan,
  ReadmeStep,
  RepoFacts,
  RuntimeKind,
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
const START_STABILITY_MS = 3_000;

export interface SandboxDiagnosisResult {
  execution: ExecutionObservation;
  requiredEnv: string[];
}

type SandboxRuntime = "node22" | "node24" | "node26" | "python3.13";
type ListeningSockets = Map<number, Set<string>>;

function repoRuntimeRequirement(kind: RuntimeKind, facts: RepoFacts): string | null {
  if (kind === "python") return facts.pythonRequirement ?? facts.pythonPreferredVersion ?? null;
  return facts.nodeRequirement ?? facts.nodePreferredVersion ?? null;
}

function readmeRuntimeRequirement(kind: RuntimeKind, plan: ReadmePlan): string | null {
  return kind === "python" ? plan.pythonRequirement : plan.nodeRequirement;
}

function runtimeCandidates(plan: ReadmePlan, facts: RepoFacts): { kind: RuntimeKind; runtimes: SandboxRuntime[]; issue: string | null } {
  const kind = readmeRuntimeKind(plan)
    ?? (facts.pythonPackageManager && !facts.nodePackageManager ? "python" : "node");
  const repoRequirement = repoRuntimeRequirement(kind, facts);
  const readmeRequirement = readmeRuntimeRequirement(kind, plan);

  if (kind === "python") {
    const repoSupports = supportsPython313(repoRequirement);
    const readmeSupports = supportsPython313(readmeRequirement);
    if (!repoSupports || !readmeSupports) {
      return {
        kind,
        runtimes: [],
        issue: `ROD currently provides Python 3.13, which does not satisfy the selected README requirement ${readmeRequirement ?? "(unspecified)"} and repository requirement ${repoRequirement ?? "(unspecified)"} together.`,
      };
    }
    return { kind, runtimes: ["python3.13"], issue: null };
  }

  const repoRuntimes = selectNodeSandboxRuntimes(repoRequirement);
  const readmeRuntimes = selectNodeSandboxRuntimes(readmeRequirement);
  const runtimes = repoRuntimes.filter((runtime) => readmeRuntimes.includes(runtime));
  if (!runtimes.length) {
    return {
      kind,
      runtimes: [],
      issue: `No ROD Node.js Sandbox runtime satisfies the selected README requirement ${readmeRequirement ?? "(unspecified)"} and repository requirement ${repoRequirement ?? "(unspecified)"} together. ROD currently provides Node.js 22, 24, and 26.`,
    };
  }
  return { kind, runtimes, issue: null };
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

function exactVersionFits(kind: RuntimeKind, requirement: string | null, actualVersion: string): boolean | null {
  if (!requirement) return true;
  return kind === "python"
    ? pythonReadmeRequirementFitsRepo(requirement, actualVersion)
    : nodeReadmeRequirementFitsRepo(requirement, actualVersion);
}

async function verifyActualRuntime(
  sandbox: Sandbox,
  runtime: SandboxRuntime,
  kind: RuntimeKind,
  plan: ReadmePlan,
  facts: RepoFacts,
): Promise<string | null> {
  const actualVersion = await readActualRuntimeVersion(sandbox, runtime);
  const runtimeName = kind === "python" ? "Python" : "Node.js";
  const repoRequirement = repoRuntimeRequirement(kind, facts);
  const readmeRequirement = readmeRuntimeRequirement(kind, plan);

  if (!actualVersion) {
    return `ROD selected ${runtime}, but could not determine its exact ${runtimeName} version before running repository code.`;
  }

  const checks = [
    ["repository", repoRequirement, exactVersionFits(kind, repoRequirement, actualVersion)],
    ["README", readmeRequirement, exactVersionFits(kind, readmeRequirement, actualVersion)],
  ] as const;
  const indeterminate = checks.find(([, requirement, result]) => requirement && result === null);
  if (indeterminate) {
    return `ROD could not safely evaluate the ${indeterminate[0]} ${runtimeName} requirement ${indeterminate[1]} against the actual Sandbox version ${actualVersion}.`;
  }
  const failed = checks.find(([, requirement, result]) => requirement && result === false);
  if (failed) {
    return `The actual ${runtimeName} ${actualVersion} in ${runtime} does not satisfy the ${failed[0]} requirement ${failed[1]}.`;
  }
  return null;
}

async function createCompatibleSandbox(
  plan: ReadmePlan,
  facts: RepoFacts,
  exposedPorts: number[],
): Promise<{ sandbox: Sandbox | null; issue: string | null }> {
  const selection = runtimeCandidates(plan, facts);
  if (!selection.runtimes.length) return { sandbox: null, issue: selection.issue };

  let lastIssue: string | null = selection.issue;
  for (const runtime of selection.runtimes) {
    const sandbox = await Sandbox.create({
      runtime,
      timeout: SANDBOX_TIMEOUT_MS,
      ports: exposedPorts,
      env: { CI: "1", ROD_SANDBOX: "1" },
    });
    const issue = await verifyActualRuntime(sandbox, runtime, selection.kind, plan, facts);
    if (!issue) return { sandbox, issue: null };
    lastIssue = issue;
    await sandbox.stop().catch(() => undefined);
  }
  return { sandbox: null, issue: `${lastIssue ?? "No compatible Sandbox runtime was found"} Setup and start were skipped.` };
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

function stripLeadingEnvAssignments(command: string): string {
  let body = command.trim();
  while (true) {
    const match = body.match(/^[A-Z_][A-Z0-9_]*=[^\s]+\s+(.+)$/);
    if (!match) return body;
    body = match[1].trim();
  }
}

function executableForCommand(command: string): string | null {
  const body = stripLeadingEnvAssignments(command);
  const executable = body.match(/^([A-Za-z0-9_.+-]+)/)?.[1] ?? null;
  if (!executable || ["cp", "copy", "mkdir", "touch"].includes(executable.toLowerCase())) return null;
  return executable;
}

function inferredInstallForPlan(plan: ReadmePlan, facts: RepoFacts): string | null {
  const kind = readmeRuntimeKind(plan);
  if (kind === "python") return facts.inferredPythonInstallCommand ?? null;
  if (kind === "node") return facts.inferredNodeInstallCommand ?? null;
  return facts.inferredInstallCommand;
}

function inferredStartForPlan(plan: ReadmePlan, facts: RepoFacts): string | null {
  const kind = readmeRuntimeKind(plan);
  if (kind === "python") return null;
  if (kind === "node") return facts.inferredNodeStartCommand ?? null;
  return facts.inferredStartCommand;
}

function plannedExecutableCommands(plan: ReadmePlan): string[] {
  return plan.steps
    .filter((step) => {
      const parsed = parseOnboardingCommand(step.command, step.malformed);
      return parsed.safe
        && parsed.executable
        && (step.role === "preparation" || step.role === "install" || step.role === "start");
    })
    .map((step) => step.command);
}

async function preflightRunnerTools(sandbox: Sandbox, plan: ReadmePlan, facts: RepoFacts): Promise<string | null> {
  const commands = plannedExecutableCommands(plan);
  if (!plan.installCommand) {
    const fallback = inferredInstallForPlan(plan, facts);
    const parsed = fallback ? parseOnboardingCommand(fallback) : null;
    if (fallback && parsed?.safe && parsed.executable && parsed.role === "install") commands.push(fallback);
  }
  if (!plan.startCommand) {
    const fallback = inferredStartForPlan(plan, facts);
    const parsed = fallback ? parseOnboardingCommand(fallback) : null;
    if (fallback && parsed?.safe && parsed.executable && parsed.role === "start") commands.push(fallback);
  }

  const executables = [...new Set(commands.map(executableForCommand).filter((value): value is string => Boolean(value)))];
  if (executables.some((tool) => ["pnpm", "yarn", "pnpx"].includes(tool))) {
    const corepack = await sandbox.runCommand({ cmd: "bash", args: ["-lc", "command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1"] });
    if (corepack.exitCode !== 0) return "The selected README flow requires pnpm/yarn tooling, but this Sandbox cannot enable Corepack.";
  }

  for (const executable of executables) {
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `command -v ${executable} >/dev/null 2>&1`],
    });
    if (result.exitCode !== 0) {
      return `The selected README flow requires ${executable}, but that executable is not available in the selected ROD Sandbox runtime.`;
    }
  }
  return null;
}

function normalizePreparationCommand(command: string): string {
  return /^copy\s+/i.test(command) ? command.replace(/^copy\b/i, "cp") : command;
}

async function startApplication(sandbox: Sandbox, command: string): Promise<void> {
  await sandbox.writeFiles([
    {
      path: "/tmp/rod-start.sh",
      content: Buffer.from([
        "#!/usr/bin/env bash",
        "set -o pipefail",
        "rm -f /tmp/rod-start.exit",
        "echo $$ > /tmp/rod-start.pid",
        `cd ${REPO_DIR}`,
        `${command} > /tmp/rod-start.log 2>&1`,
        "code=$?",
        "printf '%s\\n' \"$code\" > /tmp/rod-start.exit",
        "exit \"$code\"",
        "",
      ].join("\n")),
      mode: 0o700,
    },
  ]);
  await sandbox.runCommand({
    cmd: "/tmp/rod-start.sh",
    cwd: REPO_DIR,
    detached: true,
    env: { HOST: "0.0.0.0", HOSTNAME: "0.0.0.0" },
  });
}

export function extractPortsFromStartCommand(command: string | null): number[] {
  if (!command) return [];
  return parseOnboardingCommand(command).portHints;
}

async function readListeningSockets(sandbox: Sandbox): Promise<ListeningSockets> {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      "awk 'NR > 1 && $4 == \"0A\" { split($2, a, \":\"); print a[2], $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null",
    ],
  });
  const sockets: ListeningSockets = new Map();
  if (result.exitCode !== 0) return sockets;
  for (const line of (await result.stdout()).split("\n")) {
    const match = line.trim().match(/^([0-9A-Fa-f]+)\s+(\S+)$/);
    if (!match) continue;
    const port = Number.parseInt(match[1], 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const set = sockets.get(port) ?? new Set<string>();
    set.add(match[2]);
    sockets.set(port, set);
  }
  return sockets;
}

export function hasNewListener(
  port: number,
  current: ListeningSockets,
  baseline: ListeningSockets,
): boolean {
  const currentInodes = current.get(port);
  if (!currentInodes?.size) return false;
  const baselineInodes = baseline.get(port);
  if (!baselineInodes?.size) return true;
  return [...currentInodes].some((inode) => !baselineInodes.has(inode));
}

function orderedProbePorts(
  exposedPorts: number[],
  preferredPort: number | null,
  commandPorts: number[],
  current: ListeningSockets,
  baseline: ListeningSockets,
): number[] {
  const listeningPorts = [...current.keys()].filter((port) => hasNewListener(port, current, baseline));
  return [...new Set([
    ...(preferredPort ? [preferredPort] : []),
    ...commandPorts,
    ...listeningPorts,
    ...exposedPorts,
  ])].filter((port) => {
    if (!baseline.has(port)) return true;
    return hasNewListener(port, current, baseline);
  });
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

async function readStartExitCode(sandbox: Sandbox): Promise<number | null> {
  const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", "cat /tmp/rod-start.exit 2>/dev/null || true"] });
  const raw = (await result.stdout()).trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function stabilizeSuccessfulStart(sandbox: Sandbox): Promise<number | null> {
  const deadline = Date.now() + START_STABILITY_MS;
  while (Date.now() < deadline) {
    const exitCode = await readStartExitCode(sandbox);
    if (exitCode !== null) return exitCode;
    await sandbox.runCommand("sleep", ["1"]);
  }
  return await readStartExitCode(sandbox);
}

async function probeObservedUrl(
  sandbox: Sandbox,
  exposedPorts: number[],
  preferredPort: number | null,
  startCommand: string,
  baseline: ListeningSockets,
): Promise<{ port: number; url: string; status: number } | null> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  const commandPorts = extractPortsFromStartCommand(startCommand);
  let lastServerError: { port: number; url: string; status: number } | null = null;

  while (Date.now() < deadline) {
    const current = await readListeningSockets(sandbox);
    const ports = orderedProbePorts(exposedPorts, preferredPort, commandPorts, current, baseline);
    for (const port of ports) {
      const localStatus = await probeLocalHttpStatus(sandbox, port);
      if (localStatus === null) continue;
      const observation = { port, url: observedUrlForPort(sandbox, port, exposedPorts), status: localStatus };
      if (localStatus < 500) return observation;
      lastServerError = observation;
    }
    if (await readStartExitCode(sandbox) !== null) return lastServerError;
    await sandbox.runCommand("sleep", [String(PROBE_INTERVAL_MS / 1000)]);
  }
  return lastServerError;
}

async function readStartLog(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", "tail -c 20000 /tmp/rod-start.log 2>/dev/null || true"] });
  return await result.stdout();
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
    preparation: [], unsupportedCommands: [], install: null, startCommand: null, startLog: "",
    observedPort: null, observedUrl: null, httpStatus: null, startupTimedOut: false,
    runtimeIssue, runnerIssue: null,
    stepResults: plan.steps.map((step) => ({ stepId: step.id, status: "blocked", reason: "runtime-unsupported" })),
    preexistingPorts: [], startExitCode: null,
  };
}

function runnerBlockedExecution(plan: ReadmePlan, runnerIssue: string): ExecutionObservation {
  return {
    preparation: [], unsupportedCommands: [], install: null, startCommand: null, startLog: "",
    observedPort: null, observedUrl: null, httpStatus: null, startupTimedOut: false,
    runtimeIssue: null, runnerIssue,
    stepResults: plan.steps.map((step) => ({ stepId: step.id, status: "blocked", reason: "runner-tool-unsupported" })),
    preexistingPorts: [], startExitCode: null,
  };
}

function skippedResult(step: ReadmeStep, reason: "unsafe" | "unsupported" | "malformed" | "after-start" | "previous-failure"): StepResult {
  return { stepId: step.id, status: reason === "previous-failure" ? "blocked" : "skipped", reason };
}

function unsupportedCommandsFromSteps(plan: ReadmePlan, results: StepResult[]): string[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return results
    .filter((result) => result.status === "skipped")
    .map((result) => byId.get(result.stepId)?.command)
    .filter((command): command is string => Boolean(command));
}

export async function runSandboxDiagnosis(
  archive: Buffer,
  plan: ReadmePlan,
  facts: RepoFacts,
): Promise<SandboxDiagnosisResult> {
  const diagnosticStartCommand = plan.startCommand ?? inferredStartForPlan(plan, facts);
  const exposedPorts = [...new Set([
    ...COMMON_PORTS,
    ...(plan.expectedPort && plan.expectedPort > 0 && plan.expectedPort <= 65535 ? [plan.expectedPort] : []),
    ...extractPortsFromStartCommand(diagnosticStartCommand),
  ])];

  const compatible = await createCompatibleSandbox(plan, facts, exposedPorts);
  if (!compatible.sandbox) {
    return { requiredEnv: [], execution: runtimeBlockedExecution(plan, compatible.issue ?? "No compatible runtime is available.") };
  }
  const sandbox = compatible.sandbox;

  try {
    const runnerIssue = await preflightRunnerTools(sandbox, plan, facts);
    if (runnerIssue) return { requiredEnv: [], execution: runnerBlockedExecution(plan, runnerIssue) };

    await sandbox.writeFiles([{ path: ARCHIVE_PATH, content: archive, mode: 0o600 }]);
    const extract = await sandbox.runCommand({
      cmd: "timeout",
      args: ["--signal=TERM", "30s", "bash", "-lc", `mkdir -p ${REPO_DIR} && tar -xzf ${ARCHIVE_PATH} -C ${REPO_DIR} --strip-components=1`],
    });
    if (extract.exitCode !== 0) throw new Error(`Could not extract repository archive: ${await extract.stderr()}`);

    const requiredEnv = await detectRequiredEnv(sandbox);
    const stepResults: StepResult[] = [];
    const preparation: CommandObservation[] = [];
    let install: CommandObservation | null = null;
    let startCommand: string | null = null;
    let startLog = "";
    let observedPort: number | null = null;
    let observedUrl: string | null = null;
    let httpStatus: number | null = null;
    let startupTimedOut = false;
    let startExitCode: number | null = null;
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
      const parsed = parseOnboardingCommand(step.command, step.malformed);
      if (step.malformed) {
        stepResults.push(skippedResult(step, "malformed"));
        continue;
      }
      if (!parsed.safe || !parsed.executable) {
        stepResults.push(skippedResult(step, "unsafe"));
        if (step.role === "start") afterStart = true;
        continue;
      }
      if (step.role === "other") {
        stepResults.push(skippedResult(step, "unsupported"));
        continue;
      }

      if (step.role === "preparation") {
        const observation = await runShell(sandbox, normalizePreparationCommand(step.command), PREP_TIMEOUT_SECONDS, step.command);
        preparation.push(observation);
        const failed = commandFailed(observation);
        stepResults.push({ stepId: step.id, status: failed ? "failed" : "executed", observation });
        previousFailure = failed;
        continue;
      }

      if (step.role === "install") {
        documentedInstallAttempted = true;
        const observation = await runShell(sandbox, step.command, INSTALL_TIMEOUT_SECONDS);
        install = observation;
        const failed = commandFailed(observation);
        stepResults.push({ stepId: step.id, status: failed ? "failed" : "executed", observation });
        previousFailure = failed;
        continue;
      }

      if (step.role === "start") {
        if (!documentedInstallAttempted) {
          const fallbackInstall = inferredInstallForPlan(plan, facts);
          if (fallbackInstall && parseOnboardingCommand(fallbackInstall).safe) {
            install = await runShell(sandbox, fallbackInstall, INSTALL_TIMEOUT_SECONDS);
            if (commandFailed(install)) {
              stepResults.push({ stepId: step.id, status: "blocked", reason: "previous-failure" });
              previousFailure = true;
              afterStart = true;
              continue;
            }
          }
        }

        startCommand = step.command;
        const baseline = await readListeningSockets(sandbox);
        preexistingPorts = [...baseline.keys()].sort((a, b) => a - b);
        await startApplication(sandbox, step.command);
        const probe = await probeObservedUrl(sandbox, exposedPorts, plan.expectedPort, step.command, baseline);
        startExitCode = probe?.status && probe.status < 500
          ? await stabilizeSuccessfulStart(sandbox)
          : await readStartExitCode(sandbox);
        startLog = await readStartLog(sandbox);
        if (probe) {
          observedPort = probe.port;
          observedUrl = probe.url;
          httpStatus = probe.status;
        } else {
          startupTimedOut = startExitCode === null && await isStartProcessAlive(sandbox);
        }
        const startSucceeded = Boolean(
          probe
          && probe.status < 500
          && (startExitCode === null || startExitCode === 0)
        );
        stepResults.push({ stepId: step.id, status: startSucceeded ? "executed" : "failed" });
        afterStart = true;
      }
    }

    if (!afterStart && !previousFailure) {
      const fallbackStart = inferredStartForPlan(plan, facts);
      if (fallbackStart && parseOnboardingCommand(fallbackStart).safe) {
        if (!documentedInstallAttempted) {
          const fallbackInstall = inferredInstallForPlan(plan, facts);
          if (fallbackInstall && parseOnboardingCommand(fallbackInstall).safe) {
            install = await runShell(sandbox, fallbackInstall, INSTALL_TIMEOUT_SECONDS);
            previousFailure = commandFailed(install);
          }
        }
        if (!previousFailure) {
          startCommand = fallbackStart;
          const baseline = await readListeningSockets(sandbox);
          preexistingPorts = [...baseline.keys()].sort((a, b) => a - b);
          await startApplication(sandbox, fallbackStart);
          const probe = await probeObservedUrl(sandbox, exposedPorts, plan.expectedPort, fallbackStart, baseline);
          startExitCode = probe?.status && probe.status < 500
            ? await stabilizeSuccessfulStart(sandbox)
            : await readStartExitCode(sandbox);
          startLog = await readStartLog(sandbox);
          if (probe) {
            observedPort = probe.port;
            observedUrl = probe.url;
            httpStatus = probe.status;
          } else {
            startupTimedOut = startExitCode === null && await isStartProcessAlive(sandbox);
          }
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
        runnerIssue: null,
        stepResults,
        preexistingPorts,
        startExitCode,
      },
    };
  } finally {
    await sandbox.stop().catch((error) => {
      console.warn("[ROD sandbox] cleanup failed after diagnosis", error);
    });
  }
}
