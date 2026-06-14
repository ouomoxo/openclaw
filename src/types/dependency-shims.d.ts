/** Minimal ambient types for dependency packages used by core code. */
declare module "proper-lockfile" {
  export type Release = () => Promise<void>;
  export type ReleaseSync = () => void;

  export type RetryOptions = {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  };

  export type LockOptions = {
    realpath?: boolean;
    retries?: number | RetryOptions;
    stale?: number;
    onCompromised?: (error: Error) => void;
  };

  export function lock(file: string, options?: LockOptions): Promise<Release>;
  export function lockSync(file: string, options?: LockOptions): ReleaseSync;

  const lockfile: {
    lock: typeof lock;
    lockSync: typeof lockSync;
  };

  export default lockfile;
}

declare module "cross-spawn" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";

  function crossSpawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;

  export = crossSpawn;
}

declare module "hosted-git-info" {
  export type HostedGitInfo = {
    domain?: string;
    user?: string;
    project?: string;
    committish?: string;
  };

  export function fromUrl(value: string): HostedGitInfo | undefined;

  const hostedGitInfo: {
    fromUrl: typeof fromUrl;
  };

  export default hostedGitInfo;
}

declare module "rastermill" {
  export type ImageMetadata = {
    width: number;
    height: number;
    orientation?: number;
  };

  export type ImageProbe = ImageMetadata & {
    format?: string;
    hasAlpha?: boolean;
  };

  export type RastermillEncodeFormat = "auto" | "jpeg" | "png";
  export type RastermillOutputFormat = "jpeg" | "png" | "webp";
  export type RastermillTransparencyMode = "auto" | "flatten";

  export type RastermillOutputProfile = {
    format: RastermillOutputFormat;
    quality?: number;
    compressionLevel?: number;
  };

  export type RastermillEncodeOptions = {
    format: RastermillEncodeFormat;
    autoOrient?: boolean;
    limits?: {
      maxWidth?: number;
      maxHeight?: number;
      maxPixels?: number;
    };
    maxBytes?: number;
    opaque?: RastermillOutputProfile;
    transparent?: RastermillOutputProfile;
    resize?: {
      maxSide: number;
      enlarge?: boolean;
    };
    quality?: number;
    compressionLevel?: number;
    search?: {
      maxSide?: readonly number[];
      quality?: readonly number[];
      compressionLevel?: readonly number[];
    };
    transparency?: RastermillTransparencyMode;
  };

  export type RastermillEncodeResult = {
    data: Buffer;
    bytes: number;
    width: number;
    height: number;
    format: RastermillOutputFormat;
    mimeType: string;
    withinBudget?: boolean;
    chosen: {
      maxSide?: number;
      quality?: number;
      compressionLevel?: number;
      transparency?: "preserved" | "flattened";
    };
  };

  export type RastermillProcessor = {
    encode(buffer: Buffer, options: RastermillEncodeOptions): Promise<RastermillEncodeResult>;
    probe(buffer: Buffer): Promise<ImageProbe | null>;
    transparency(buffer: Buffer): Promise<{ hasAlphaChannel: boolean }>;
  };

  export type RastermillOptions = {
    execution?: "auto";
    limits?: {
      inputPixels?: number;
      outputPixels?: number;
    };
    temp?: {
      rootDir?: string;
      prefix?: string;
    };
    commandResolver?: (command: string) => string | null;
  };

  export class RastermillError extends Error {
    readonly code?: string;
  }

  export class RastermillUnavailableError extends RastermillError {
    readonly causes: unknown[];
  }

  export function createRastermill(options?: RastermillOptions): RastermillProcessor;
  export function isRastermillUnavailableError(error: unknown): boolean;
  export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null;
  export function readImageProbeFromHeader(buffer: Buffer): ImageProbe | null;
}
