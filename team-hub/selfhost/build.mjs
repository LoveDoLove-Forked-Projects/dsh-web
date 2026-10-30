import { build } from 'esbuild'

// One bundle, native dependencies left external. The shared Worker modules use
// bundler-style extensionless imports, so a bundle is what lets the same
// sources run on Node without a second copy or a resolver hook.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: 'dist/main.js',
  logLevel: 'info',
})
