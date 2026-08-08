import type { Workspace } from "../workspace/index.js";

export const gitChangeKinds = {
  MODIFIED: "MODIFIED",
  ADDED: "ADDED",
  DELETED: "DELETED",
  RENAMED: "RENAMED",
  UNTRACKED: "UNTRACKED",
} as const;

export type GitChangeKind =
  (typeof gitChangeKinds)[keyof typeof gitChangeKinds];

export interface GitChangedPath {
  readonly path: string;
  readonly kind: GitChangeKind;
  readonly previousPath?: string;
}

export interface GitChangeInspectionRequest {
  readonly workspace: Readonly<Workspace>;
}

export interface GitChangeInspectionResult {
  readonly changes: readonly GitChangedPath[];
  readonly approvedPaths: readonly string[];
}

export interface GitCommitRequest {
  readonly workspace: Readonly<Workspace>;
  readonly inspection: GitChangeInspectionResult;
}

export interface GitCommitResult {
  readonly commitSha: string;
  readonly committedPaths: readonly string[];
}

export interface GitPushRequest {
  readonly workspace: Readonly<Workspace>;
  readonly commit: GitCommitResult;
  readonly remote: "origin";
}

export interface GitPublishResult extends GitCommitResult {
  readonly pushedBranch: string;
  readonly remote: string;
}

export interface GitPublisher {
  inspect(
    request: GitChangeInspectionRequest,
  ): Promise<GitChangeInspectionResult>;
  commit(request: GitCommitRequest): Promise<GitCommitResult>;
  push(request: GitPushRequest): Promise<GitPublishResult>;
}
