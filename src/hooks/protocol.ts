/**
 * The file-based protocol between the Claude Code hook script and the extension.
 *
 * The hook writes one JSON file per event into `<storage>/hook-events/` (atomically, via
 * rename) and copies pre-edit file bytes into the content-addressed snapshot store at
 * `<storage>/snapshots/`. The extension reads and deletes event files. There is no socket,
 * server, or shared lock: either side can be absent without affecting the other.
 */

export const HOOK_PROTOCOL_VERSION = 1;
export const EVENTS_DIR = 'hook-events';
export const SNAPSHOTS_DIR = 'snapshots';
export const HOOK_CONFIG_FILE = 'hook-config.json';

/** Written by the extension, read by the hook on every run. */
export interface HookConfig {
  readonly version: number;
  /** Absolute workspace folder. Paths outside it are ignored. */
  readonly root: string;
  readonly exclude: readonly string[];
  readonly sensitive: readonly string[];
  readonly maxFileSize: number;
}

export type HookFileState =
  | { readonly type: 'absent' }
  /** `stored` is true when the bytes were copied into the snapshot store. */
  | {
      readonly type: 'file';
      readonly hash: string;
      readonly size: number;
      readonly mode: number;
      readonly stored: boolean;
      readonly reason?: string;
    }
  | { readonly type: 'other'; readonly reason: string };

export interface EditEvent {
  readonly v: number;
  readonly type: 'pre' | 'post';
  readonly at: number;
  readonly claudeSessionId?: string;
  readonly tool: string;
  /** Absolute path of the edited file. */
  readonly path: string;
  readonly state: HookFileState;
}

export interface MarkerEvent {
  readonly v: number;
  readonly type: 'prompt' | 'stop';
  readonly at: number;
  readonly claudeSessionId?: string;
}

export type HookEvent = EditEvent | MarkerEvent;

export function isEditEvent(e: HookEvent): e is EditEvent {
  return e.type === 'pre' || e.type === 'post';
}

/** Claude Code tools that write files, and the tool_input field holding the path. */
export const FILE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

export function isHookEvent(value: unknown): value is HookEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as { v?: unknown; type?: unknown; at?: unknown; path?: unknown; state?: unknown };
  if (v.v !== HOOK_PROTOCOL_VERSION || typeof v.at !== 'number') {
    return false;
  }
  if (v.type === 'prompt' || v.type === 'stop') {
    return true;
  }
  return (
    (v.type === 'pre' || v.type === 'post') &&
    typeof v.path === 'string' &&
    typeof v.state === 'object' &&
    v.state !== null
  );
}
