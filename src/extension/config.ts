import * as vscode from 'vscode';
import { GlobSet } from '../core/glob';
import type { CaptureLimits } from '../services/baseline';

export const SECTION = 'claudeReview';

export interface ReviewConfig {
  readonly autoTrack: boolean;
  readonly confirmReject: boolean;
  readonly openNextAfterDecision: boolean;
  readonly exclude: GlobSet;
  readonly sensitive: GlobSet;
  readonly limits: CaptureLimits;
}

const MB = 1024 * 1024;

export function readConfig(scope?: vscode.ConfigurationScope): ReviewConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    autoTrack: c.get<boolean>('autoTrack', true),
    confirmReject: c.get<boolean>('confirmReject', true),
    openNextAfterDecision: c.get<boolean>('openNextAfterDecision', true),
    exclude: new GlobSet(c.get<string[]>('exclude', [])),
    sensitive: new GlobSet(c.get<string[]>('snapshot.sensitivePatterns', [])),
    limits: {
      maxFileSize: Math.max(0, c.get<number>('snapshot.maxFileSizeMB', 5)) * MB,
      maxTotalSize: Math.max(0, c.get<number>('snapshot.maxTotalSizeMB', 200)) * MB,
      maxFiles: Math.max(1, c.get<number>('filesystemMode.maxFiles', 20000)),
    },
  };
}
