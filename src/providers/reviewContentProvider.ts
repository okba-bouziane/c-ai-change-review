import * as vscode from 'vscode';
import type { Baseline } from '../core/session';

export const REVIEW_SCHEME = 'claude-review';

/** What a claude-review: URI shows: a recorded baseline, or a plain explanatory message. */
export type ContentRef =
  | { readonly t: 'baseline'; readonly b: Baseline; readonly p: string }
  | { readonly t: 'message'; readonly m: string };

export interface ReviewUriInfo {
  /** Root-relative key of the panel entry this document belongs to. */
  readonly key: string;
  readonly ref: ContentRef;
}

/**
 * Builds an immutable, read-only URI. The path keeps the real file name so VS Code picks the
 * right language and tab label; the query carries the content reference and the entry key.
 */
export function reviewUri(
  displayPath: string,
  key: string,
  ref: ContentRef,
  label: string,
): vscode.Uri {
  const query = new URLSearchParams({
    k: key,
    r: Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url'),
    l: label,
  });
  return vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    path: `/${displayPath}`,
    query: query.toString(),
  });
}

export function parseReviewUri(uri: vscode.Uri): ReviewUriInfo | undefined {
  if (uri.scheme !== REVIEW_SCHEME) {
    return undefined;
  }
  try {
    const query = new URLSearchParams(uri.query);
    const key = query.get('k');
    const raw = query.get('r');
    if (key === null || raw === null) {
      return undefined;
    }
    const ref = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ContentRef;
    return { key, ref };
  } catch {
    return undefined;
  }
}

export type BaselineReader = (baseline: Baseline, key: string) => Promise<Buffer | undefined>;

/** Serves the left side of review diffs. Documents are read-only by construction. */
export class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly read: () => BaselineReader | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const info = parseReviewUri(uri);
    if (!info) {
      return '';
    }
    const { ref } = info;
    if (ref.t === 'message') {
      return ref.m;
    }
    const reader = this.read();
    if (!reader) {
      return 'No review session is active.';
    }
    try {
      return (await reader(ref.b, ref.p))?.toString('utf8') ?? '';
    } catch (e) {
      return `The original content could not be loaded.\n\n${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
