import { describe, expect, it } from 'vitest';
import { countByStatus, groupChanges, splitPath } from '../../core/grouping';
import type { ChangedFile } from '../../core/types';

const files: ChangedFile[] = [
  { path: 'src/b.ts', kind: 'modified', status: 'pending' },
  { path: 'README.md', kind: 'added', status: 'accepted' },
  { path: 'src/a.ts', kind: 'modified', status: 'rejected' },
  { path: 'lib/new.ts', oldPath: 'lib/old.ts', kind: 'renamed', status: 'pending' },
  { path: 'gone.txt', kind: 'deleted', status: 'pending' },
];

describe('groupChanges', () => {
  it('orders groups Added, Modified, Deleted, Renamed and sorts by path', () => {
    const groups = groupChanges(files);
    expect(groups.map((g) => g.kind)).toEqual(['added', 'modified', 'deleted', 'renamed']);
    expect(groups[1]?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('omits groups emptied by the status filter', () => {
    const groups = groupChanges(files, new Set(['pending']));
    expect(groups.map((g) => g.kind)).toEqual(['modified', 'deleted', 'renamed']);
    expect(groups[0]?.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('returns no groups for no files', () => {
    expect(groupChanges([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const copy = [...files];
    groupChanges(files);
    expect(files).toEqual(copy);
  });

  it('handles 1000 files', () => {
    const many: ChangedFile[] = Array.from({ length: 1000 }, (_, i) => ({
      path: `pkg/file-${String(999 - i).padStart(4, '0')}.ts`,
      kind: 'modified',
      status: 'pending',
    }));
    const [group] = groupChanges(many);
    expect(group?.files).toHaveLength(1000);
    expect(group?.files[0]?.path).toBe('pkg/file-0000.ts');
  });
});

describe('countByStatus', () => {
  it('counts each status', () => {
    expect(countByStatus(files)).toEqual({ pending: 3, accepted: 1, rejected: 1 });
  });
});

describe('splitPath', () => {
  it('splits nested and root paths', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ name: 'c.ts', dir: 'a/b' });
    expect(splitPath('c.ts')).toEqual({ name: 'c.ts', dir: '' });
  });
});
