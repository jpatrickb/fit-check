// npm run phone — build the web app, start the server, open a Cloudflare tunnel, and print the phone link.
//   - With TUNNEL_NAME + PUBLIC_HOSTNAME in .env (see `npm run tunnel:setup`): a named tunnel on your own domain (permanent link).
//   - Otherwise: a free quick tunnel (random *.trycloudflare.com link that changes every run).
// Keeps the Mac awake (caffeinate) while running. Ctrl+C stops everything (the server takes a final backup).
import '../server/src/env';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const port = Number(process.env.PORT || 8787);
const tunnelName = process.env.TUNNEL_NAME || '';
const hostname = process.env.PUBLIC_HOSTNAME || '';
const kids: ChildProcess[] = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return; stopping = true;
  for (const k of kids) k.kill('SIGTERM');
  setTimeout(() => process.exit(code), 2000);
};
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));

if (!process.env.APP_PASSWORD || process.env.APP_PASSWORD === 'change-me') {
  console.error("APP_PASSWORD in .env is missing or still 'change-me'. Without a real password, anyone with the link could use the app and spend your API credits. Set one and re-run.");
  process.exit(1);
}
if (spawnSync('cloudflared', ['--version']).error) {
  console.error('cloudflared not found. Install it: brew install cloudflared   (or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)');
  process.exit(1);
}

console.log('Building web app…');
if (spawnSync('npx', ['vite', 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'], { stdio: 'inherit' }).status !== 0) process.exit(1);

const awake = process.platform === 'darwin' ? ['caffeinate', '-i'] : [];
const cmd = [...awake, 'npx', 'tsx', 'server/src/index.ts'];
const server = spawn(cmd[0], cmd.slice(1), { env: { ...process.env, NODE_ENV: 'production' }, stdio: ['ignore', 'inherit', 'inherit'] });
kids.push(server);
server.on('exit', c => { console.error(`server exited (${c})`); stop(1); });

const banner = (url: string, permanent: boolean) => console.log(
  `\n  📱  Open on your phone: ${url}\n      Password: the APP_PASSWORD in .env\n` +
  (permanent ? '      (Permanent link. Ctrl+C to stop.)\n' : '      (Link changes each run — set up your own domain with `npm run tunnel:setup`. Ctrl+C to stop.)\n'));

let tunnel: ChildProcess;
if (tunnelName) {
  // Minimal config so cloudflared ignores any unrelated ~/.cloudflared/config.yml (which may belong to another tunnel).
  const cfg = path.join(os.tmpdir(), `fitcheck-cloudflared-${tunnelName}.yml`);
  fs.writeFileSync(cfg, `ingress:\n  - service: http://localhost:${port}\n`);
  tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--config', cfg, 'run', tunnelName], { stdio: ['ignore', 'ignore', 'pipe'] });
  let shown = false;
  tunnel.stderr!.on('data', (d: Buffer) => {
    const s = d.toString();
    if (/ERR/.test(s)) process.stderr.write(s);
    if (!shown && /Registered tunnel connection/.test(s)) { shown = true; banner(hostname ? `https://${hostname}` : `(tunnel "${tunnelName}" connected)`, true); }
  });
} else {
  tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let shown = false;
  tunnel.stderr!.on('data', (d: Buffer) => {
    const url = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (url && !shown) { shown = true; banner(url, false); }
  });
}
kids.push(tunnel);
tunnel.on('exit', c => { console.error(`tunnel exited (${c})`); stop(1); });
