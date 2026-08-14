export type FindingCode =
  | "ENV_MISSING"
  | "INSTALL_STEP_MISSING"
  | "START_STEP_MISSING"
  | "INSTALL_BROKEN"
  | "PREPARATION_BROKEN"
  | "COMMAND_BROKEN"
  | "RUNNER_COMMAND_UNSUPPORTED"
  | "RUNTIME_UNDOCUMENTED"
  | "RUNTIME_MISMATCH"
  | "RUNNER_RUNTIME_UNSUPPORTED"
  | "RUNNER_TIMEOUT"
  | "PORT_MISMATCH"
  | "START_URL_UNDOCUMENTED"
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

export interface ReadmePlan {
  commands: string[];
  installCommand: string | null;
  startCommand: string | null;
  expectedPort: number | null;
  expectedUrl: string | null;
  nodeRequirement: string | null;
  pythonRequirement: string | null;
  copiesEnvExample: boolean;
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
}

export interface CommandObservation {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
}
