#!/usr/bin/env node
/**
 * Install admin/ deps once. Guards against Windows recursion when
 * `npm install --prefix admin` re-triggers the root postinstall.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (
  process.env.SOLIS_SKIP_ADMIN_INSTALL === '1' ||
  process.env.RAILWAY_ENVIRONMENT
) {
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminPkg = resolve(root, 'admin/package.json');
if (!existsSync(adminPkg)) {
  console.warn('admin/package.json missing — skip admin install');
  process.exit(0);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--prefix', 'admin'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SOLIS_SKIP_ADMIN_INSTALL: '1' },
    shell: process.platform === 'win32',
  },
);
process.exit(result.status ?? 1);
