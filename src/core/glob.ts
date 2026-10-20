/**
 * Minimal glob matching for exclusion settings: '**' crosses directories, '*' and '?' do
 * not, everything else is literal. Patterns without a '/' match a file name at any depth
 * (like .gitignore). Matching is case-sensitive.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/\\/g, '/');
  if (!glob.includes('/')) {
    glob = `**/${glob}`;
  }
  glob = glob.replace(/^\/+/, '');

  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A pattern that names a directory also excludes everything inside it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

export class GlobSet {
  private readonly regexps: readonly RegExp[];

  constructor(patterns: readonly string[]) {
    this.regexps = patterns.filter((p) => p.trim() !== '').map(globToRegExp);
  }

  matches(relPath: string): boolean {
    return this.regexps.some((re) => re.test(relPath));
  }
}
