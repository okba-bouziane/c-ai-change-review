import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isBinary } from '../core/content';
import { splitPath } from '../core/grouping';
import type { Baseline } from '../core/session';
import { REVIEW_STATUS_LABEL, type ChangedFile } from '../core/types';
import { formatBytes } from '../services/baseline';
import type { ReviewController, ReviewItem } from '../extension/reviewController';
import { reviewUri, type ContentRef } from './reviewContentProvider';

/** One side of a review diff. */
type Side =
  | { readonly kind: 'baseline'; readonly baseline: Baseline; readonly key: string }
  | { readonly kind: 'file'; readonly key: string }
  | { readonly kind: 'message'; readonly text: string };

interface DiffPlan {
  readonly left: Side;
  readonly right: Side;
  readonly leftLabel: string;
  readonly rightLabel: string;
}

/** Opens the native side-by-side diff for a panel entry. */
export async function openReviewDiff(
  controller: ReviewController,
  file: ChangedFile,
  options: { preview?: boolean; preserveFocus?: boolean } = {},
): Promise<void> {
  const item = controller.item(file.key);
  if (!item) {
    void vscode.window.showInformationMessage(`${file.path} no longer has changes to review.`);
    return;
  }
  const plan = planDiff(item, file);
  let left = plan.left;
  let right = plan.right;

  // Binary files: show a short description of each side instead of garbled text.
  const leftBytes = await sample(controller, left);
  const rightBytes = await sample(controller, right);
  if ((leftBytes && isBinary(leftBytes.head)) || (rightBytes && isBinary(rightBytes.head))) {
    left = { kind: 'message', text: describeBinary(plan.leftLabel, leftBytes) };
    right = { kind: 'message', text: describeBinary(plan.rightLabel, rightBytes) };
  }

  const { name } = splitPath(file.path);
  const title = `${name} (${plan.leftLabel} ↔ ${plan.rightLabel}) · ${REVIEW_STATUS_LABEL[item.status]}`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    toUri(controller, file, left, plan.leftLabel),
    toUri(controller, file, right, plan.rightLabel),
    title,
    { preview: options.preview ?? true, preserveFocus: options.preserveFocus ?? false },
  );
}

function planDiff(item: ReviewItem, file: ChangedFile): DiffPlan {
  const current = (key: string, missing: string): Side =>
    file.kind === 'deleted' && item.status !== 'rejected'
      ? { kind: 'message', text: missing }
      : { kind: 'file', key };

  if (item.change) {
    const c = item.change;
    const left: Side =
      c.kind === 'renamed' && c.oldPath !== undefined && c.oldBaseline
        ? { kind: 'baseline', baseline: c.oldBaseline, key: c.oldPath }
        : originalSide(c.baseline, c.path);
    return {
      left,
      right: current(c.path, 'This file was deleted.'),
      leftLabel: 'Original',
      rightLabel: c.kind === 'deleted' ? 'Deleted' : 'Current',
    };
  }

  const r = item.record;
  if (r?.status === 'accepted') {
    const left =
      r.kind === 'renamed' && r.oldPath !== undefined && r.oldBefore
        ? originalSide(r.oldBefore, r.oldPath)
        : originalSide(r.before, item.key);
    return {
      left,
      right: current(item.key, 'This file was deleted (deletion accepted).'),
      leftLabel: 'Original',
      rightLabel: 'Accepted',
    };
  }

  // Rejected: what was thrown away on the left, what is on disk now on the right.
  const restoredKey = r?.kind === 'renamed' && r.oldPath !== undefined ? r.oldPath : item.key;
  const left: Side =
    r && r.after.type !== 'absent'
      ? { kind: 'baseline', baseline: r.after, key: item.key }
      : { kind: 'message', text: 'The rejected change deleted this file.' };
  const right: Side =
    r?.kind === 'added'
      ? { kind: 'message', text: 'The file was removed because it did not exist originally.' }
      : { kind: 'file', key: restoredKey };
  return { left, right, leftLabel: 'Rejected', rightLabel: 'Restored' };
}

function originalSide(baseline: Baseline, key: string): Side {
  switch (baseline.type) {
    case 'absent':
      return { kind: 'message', text: '' };
    case 'unavailable':
      return {
        kind: 'message',
        text: `The original content of this file was not captured: ${baseline.reason}.`,
      };
    default:
      return { kind: 'baseline', baseline, key };
  }
}

interface Sample {
  readonly head: Buffer;
  readonly size: number;
}

async function sample(controller: ReviewController, side: Side): Promise<Sample | undefined> {
  try {
    if (side.kind === 'baseline') {
      const bytes = await controller.readBaseline(side.baseline, side.key);
      return bytes ? { head: bytes.subarray(0, 8000), size: bytes.length } : undefined;
    }
    if (side.kind === 'file') {
      const abs = controller.absolutePath(side.key);
      if (!abs) {
        return undefined;
      }
      const handle = await fs.open(abs, 'r');
      try {
        const head = Buffer.alloc(8000);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        return { head: head.subarray(0, bytesRead), size: (await handle.stat()).size };
      } finally {
        await handle.close();
      }
    }
  } catch {
    // Unreadable content is reported by the diff editor itself.
  }
  return undefined;
}

function describeBinary(label: string, s: Sample | undefined): string {
  return s
    ? `${label}: binary file, ${formatBytes(s.size)}.\n\nBinary content cannot be shown as a text diff.`
    : `${label}: no content.`;
}

function toUri(
  controller: ReviewController,
  file: ChangedFile,
  side: Side,
  label: string,
): vscode.Uri {
  if (side.kind === 'file') {
    const abs = controller.absolutePath(side.key);
    if (abs) {
      return vscode.Uri.file(abs);
    }
  }
  const ref: ContentRef =
    side.kind === 'baseline'
      ? { t: 'baseline', b: side.baseline, p: side.key }
      : { t: 'message', m: side.kind === 'message' ? side.text : '' };
  const displayPath =
    side.kind === 'message' ? `${file.path}.${label.toLowerCase()}.txt` : file.path;
  return reviewUri(displayPath.split(path.sep).join('/'), file.key, ref, label);
}
