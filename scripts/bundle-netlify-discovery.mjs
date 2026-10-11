/**
 * Bundle the discovery Netlify functions so esbuild can follow the
 * TypeScript .js import specifiers in src/discovery.
 * Output is gitignored and produced by `npm run build`.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEsbuild() {
  const candidates = [
    'esbuild',
    'netlify-cli/node_modules/esbuild',
    path.join(root, 'admin/node_modules/esbuild'),
  ];
  for (const id of candidates) {
    try {
      return require(id);
    } catch {
      /* try the next location */
    }
  }
  throw new Error('esbuild is not installed; run npm install');
}

const esbuild = loadEsbuild();

const resolveTs = {
  name: 'resolve-ts-js-specifiers',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.') || !args.importer) return null;
      const abs = path.resolve(path.dirname(args.importer), args.path);
      const ts = abs.replace(/\.js$/, '.ts');
      if (existsSync(ts)) return { path: ts };
      return null;
    });
  },
};

for (const name of ['discovery-start', 'discovery-poll', 'discovery-continue']) {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [`netlify/entries/${name}.ts`],
    outfile: `netlify/functions/${name}.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    plugins: [resolveTs],
    external: ['@supabase/supabase-js'],
  });
  console.log(`bundled netlify/functions/${name}.js`);
}
