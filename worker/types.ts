export type ClaimedJob = {
  jobId: string;
  kind: 'create' | 'revise';
  stage: string;
  attempts: number;
  workspaceKey: string;
  codexSessionId?: string;
  machine: {
    slug: string;
    name: string;
    kind: string;
    machineId?: string;
    current?: {
      machineVersionId: string;
      version: number;
      definition: unknown;
      modelUrl: string;
      sourceUrl?: string;
    };
  };
  procedureSlug: string;
  title: string;
  brief: string;
  instruction?: string;
  videoUrl?: string;
  target?: {
    procedureVersionId: string;
    machineVersionId: string;
    content: unknown;
    definition: unknown;
    contentHash: string;
    modelUrl: string;
  };
  approvedProcedures: { slug: string; content: unknown }[];
  leaseSeconds: number;
};

export type EventLevel = 'info' | 'warn' | 'error';

export type HeartbeatResult = { status: 'running' | 'cancelled' };

export type DeliverPayload = {
  modelChanged: boolean;
  model?: { modelFileId: string; sourceFileId?: string; definition: unknown };
  procedure: { content: unknown };
  mediaFileIds?: string[];
  sourceContentHash?: string;
  report: unknown;
};

export type DeliverResult = { procedureVersionId: string; machineVersionId: string };

export interface WorkerClient {
  claim(): Promise<ClaimedJob | null>;
  heartbeat(jobId: string): Promise<HeartbeatResult>;
  event(jobId: string, level: EventLevel, message: string): Promise<void>;
  stage(jobId: string, stage: string, codexSessionId?: string): Promise<void>;
  uploadFile(jobId: string, bytes: Uint8Array, contentType: string): Promise<string>;
  deliver(jobId: string, payload: DeliverPayload): Promise<DeliverResult>;
  fail(jobId: string, error: string): Promise<void>;
}
