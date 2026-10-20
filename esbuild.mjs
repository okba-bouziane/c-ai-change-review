import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** The Claude Code hook runs as its own short-lived Node process, outside VS Code. */
const hookOptions = {
  ...options,
  entryPoints: ['src/hooks/hookScript.ts'],
  outfile: 'dist/hook.js',
  external: [],
  target: 'node18',
};

if (watch) {
  for (const o of [options, hookOptions]) {
    const ctx = await esbuild.context(o);
    await ctx.watch();
  }
} else {
  await Promise.all([esbuild.build(options), esbuild.build(hookOptions)]);
}
