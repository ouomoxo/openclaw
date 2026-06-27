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
  allowedVerificationCommands: string[];
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

export interface CommandEvidence {
  commandId: string;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
}

export interface VerificationEvidence {
  id: string;
  type: string;
  command: string;
  status: "passed" | "failed" | "timed-out" | "cancelled";
  exitCode?: number;
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
