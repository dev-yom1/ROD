export type FindingCode =
  | "ENV_MISSING"
  | "INSTALL_STEP_MISSING"
  | "START_STEP_MISSING"
  | "INSTALL_BROKEN"
  | "PREPARATION_BROKEN"
  | "COMMAND_BROKEN"
  | "RUNNER_COMMAND_UNSUPPORTED"
  | "RUNNER_TOOL_UNSUPPORTED"
  | "RUNNER_PREEXISTING_LISTENER"
  | "RUNTIME_UNDOCUMENTED"
  | "RUNTIME_MISMATCH"
  | "RUNNER_RUNTIME_UNSUPPORTED"
  | "RUNNER_TIMEOUT"
  | "PORT_MISMATCH"
  | "START_URL_UNDOCUMENTED"
  | "START_PORT_UNDOCUMENTED"
  | "FLOW_AMBIGUOUS"
  | "DOC_STALE";

export type FindingSeverity = "error" | "warning" | "info";

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  title: string;
  detail: string;
  suggestion?: string;
  evidence?: string[];
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "uv" | null;
export type RuntimeKind = "node" | "python";
export type EnvTemplateName = ".env.example" | ".env.sample";

export type ReadmeStepRole = "preparation" | "install" | "start" | "other";

export interface ReadmeStep {
  id: string;
  command: string;
  section: string | null;
  fenceIndex: number;
  line: number;
  role: ReadmeStepRole;
  malformed?: boolean;
}

export type StepResultStatus = "executed" | "failed" | "skipped" | "blocked";
export type StepResultReason =
  | "unsafe"
  | "unsupported"
  | "malformed"
  | "after-start"
  | "runtime-unsupported"
  | "runner-tool-unsupported"
  | "flow-ambiguous"
  | "previous-failure";

export interface CommandObservation {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface StepResult {
  stepId: string;
  status: StepResultStatus;
  reason?: StepResultReason;
  observation?: CommandObservation;
}

export interface ReadmePlan {
  steps: ReadmeStep[];
  commands: string[];
  installCommand: string | null;
  startCommand: string | null;
  expectedPort: number | null;
  expectedUrl: string | null;
  nodeRequirement: string | null;
  pythonRequirement: string | null;
  copiesEnvExample: boolean;
  flowSections?: string[];
  flowIssue?: string | null;
  flowText?: string;
  terminalText?: string;
}

export interface RepoFacts {
  packageManager: PackageManager;
  scripts: Record<string, string>;
  nodeRequirement: string | null;
  pythonRequirement: string | null;
  inferredInstallCommand: string | null;
  inferredStartCommand: string | null;
  requiredEnv: string[];
  envExampleVars: string[];
  nodePackageManager?: PackageManager;
  pythonPackageManager?: PackageManager;
  nodePreferredVersion?: string | null;
  pythonPreferredVersion?: string | null;
  inferredNodeInstallCommand?: string | null;
  inferredPythonInstallCommand?: string | null;
  inferredNodeStartCommand?: string | null;
  envFileVars?: Partial<Record<EnvTemplateName, string[]>>;
}

export interface ExecutionObservation {
  preparation: CommandObservation[];
  unsupportedCommands: string[];
  install: CommandObservation | null;
  startCommand: string | null;
  startLog: string;
  observedPort: number | null;
  observedUrl: string | null;
  httpStatus: number | null;
  startupTimedOut: boolean;
  runtimeIssue: string | null;
  runnerIssue?: string | null;
  stepResults?: StepResult[];
  preexistingPorts?: number[];
  startExitCode?: number | null;
}
