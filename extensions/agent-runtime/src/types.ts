// Internal runtime types. NOTE: RuntimeRunInput is NOT the OV wire contract — an adapter will later
// translate OV AgentRunInput into this internal shape.

export type SourceChannel = "telegram" | "slack" | "openclaw" | "api";

export interface RuntimePermissions {
  filesystem: "workspace-write";
  shell: boolean;
  network: boolean;
  gitCommit: boolean;
  gitPush: false;
  deployment: false;
}

export interface RuntimeRunInput {
  version: "0.1";
  taskId: string;
  runId: string;
  correlationId: string;
  role: "worker";
  repository: {
    path: string;
    baseBranch: string;
    baseRevision?: string;
  };
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  permissions: RuntimePermissions;
  verificationCommands: string[];
  limits: {
    timeoutMs: number;
    maxOutputBytes: number;
    maxProcesses?: number;
  };
}

/** Repository trust + execution profile. Untrusted repositories are rejected in this phase. */
export interface RepositoryExecutionProfile {
  trustLevel: "fixture" | "trusted-local" | "untrusted";
  allowedExecutables: string[];
  /** Allowed verification commands as argv arrays, e.g. [["node","--test"],["npm","test"]]. */
  allowedVerificationCommands: string[][];
  allowDependencyInstall: boolean;
  networkAllowed: boolean;
}

/**
 * Security posture stamped onto every run result by the runtime (never settable by the model/worker).
 * Distinguishes the separate isolation boundaries — workspace ≠ process ≠ credential ≠ network ≠ resource.
 */
export interface RuntimeSecurityPosture {
  environmentSanitized: boolean;
  workspaceIsolated: boolean;
  processUserVerifiedNonRoot: boolean;
  resourceLimitsVerified: boolean;
  networkIsolationVerified: boolean;
  productionEligible: boolean;
  limitations: string[];
}

export interface ChangedFile {
  path: string;
  changeType: "created" | "modified" | "deleted";
}

export type RuntimeArtifactType =
  | "git-diff"
  | "git-status"
  | "changed-files"
  | "command-stdout"
  | "command-stderr"
  | "test-report"
  | "build-report"
  | "executor-result"
  | "security-posture";

export interface RuntimeArtifact {
  artifactId: string;
  taskId: string;
  runId: string;
  type: RuntimeArtifactType;
  /** Path relative to the artifact store root — never an absolute host path. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string;
  createdAt: string;
}

export interface CommandEvidence {
  commandId: string;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
}

export type VerificationType = "test" | "lint" | "typecheck" | "build" | "custom";

export interface VerificationEvidence {
  id: string;
  type: VerificationType;
  executable: string;
  args: string[];
  status: "passed" | "failed" | "timed-out" | "cancelled";
  exitCode?: number;
  signal?: string;
  durationMs: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
}

export interface ExecutorResult {
  status: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  changedFiles: ChangedFile[];
  commands: CommandEvidence[];
  verifications: VerificationEvidence[];
  risks: string[];
  blockers: string[];
  exitCode?: number;
  securityPosture: RuntimeSecurityPosture;
}
