import * as path from 'node:path';

/**
 * Paths inside this extension are "root-relative": relative to the session root (the Git
 * top-level directory, or the workspace folder in filesystem mode), POSIX separators,
 * no leading './', no '..' segments.
 */
export class UnsafePathError extends Error {
  constructor(
    readonly relPath: string,
    reason: string,
  ) {
    super(`Refusing unsafe path "${relPath}": ${reason}`);
    this.name = 'UnsafePathError';
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Validates a root-relative path and returns it normalized, or throws UnsafePathError. */
export function normalizeRelPath(relPath: string): string {
  if (relPath.length === 0) {
    throw new UnsafePathError(relPath, 'empty path');
  }
  if (relPath.includes('\0')) {
    throw new UnsafePathError(relPath, 'contains a NUL byte');
  }
  const posix = relPath.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
    throw new UnsafePathError(relPath, 'absolute paths are not allowed');
  }
  const segments = posix.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) {
    throw new UnsafePathError(relPath, 'refers to the root itself');
  }
  if (segments.includes('..')) {
    throw new UnsafePathError(relPath, "'..' segments are not allowed");
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new UnsafePathError(relPath, 'paths inside .git are never touched');
  }
  return segments.join('/');
}

/**
 * Lexically resolves a root-relative path to an absolute path that is guaranteed to be
 * inside root. Symlink escapes are checked separately by the filesystem layer.
 */
export function resolveInside(root: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  const abs = path.resolve(root, ...rel.split('/'));
  if (!isInside(root, abs)) {
    throw new UnsafePathError(relPath, 'resolves outside the workspace');
  }
  return abs;
}

/** True when child is root itself or strictly below it (lexical check). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Root-relative path for an absolute path, or undefined when it is outside root. */
export function relativeTo(root: string, abs: string): string | undefined {
  if (!isInside(root, abs)) {
    return undefined;
  }
  const rel = toPosix(path.relative(path.resolve(root), path.resolve(abs)));
  return rel === '' ? undefined : rel;
}

/** True when a root-relative path is the scope prefix or lies under it. '' scopes everything. */
export function inScope(prefix: string, relPath: string): boolean {
  return prefix === '' || relPath === prefix || relPath.startsWith(`${prefix}/`);
}
