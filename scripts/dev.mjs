import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const children = [spawn(process.execPath, [require.resolve('tsx/cli'), 'watch', 'server/main.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, [require.resolve('vite/bin/vite.js')], { stdio: 'inherit' })];
const stop = () => { for (const child of children) child.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const child of children) child.on('exit', code => { stop(); process.exitCode = code ?? 0; });
