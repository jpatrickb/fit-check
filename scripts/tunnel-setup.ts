// npm run tunnel:setup -- <hostname> [tunnel-name]
// One-time setup for a permanent link on a domain you manage in Cloudflare, e.g.
//   npm run tunnel:setup -- fitcheck.example.com
// Creates a named Cloudflare tunnel, points the hostname's DNS at it, and saves TUNNEL_NAME / PUBLIC_HOSTNAME to .env.
// Prerequisite: `cloudflared tunnel login` (opens a browser to pick your domain; run it once per machine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [hostname, name = 'fitcheck'] = process.argv.slice(2);
if (!hostname || !hostname.includes('.')) {
  console.error('Usage: npm run tunnel:setup -- <hostname> [tunnel-name]\n  e.g. npm run tunnel:setup -- fitcheck.example.com');
  process.exit(1);
}
if (!fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'))) {
  console.error('Not logged in to Cloudflare. Run: cloudflared tunnel login   (then re-run this)');
  process.exit(1);
}

// An isolated config so `route dns` targets THIS tunnel, not whatever ~/.cloudflared/config.yml names.
const cfg = path.join(os.tmpdir(), `fitcheck-setup-${name}.yml`);
fs.writeFileSync(cfg, 'ingress:\n  - service: http_status:404\n');
const cf = (...args: string[]) => spawnSync('cloudflared', ['--config', cfg, ...args], { encoding: 'utf8' });

const list = cf('tunnel', 'list', '--output', 'json');
const tunnels: { id: string; name: string }[] = list.status === 0 ? JSON.parse(list.stdout || '[]') : [];
let t = tunnels.find(x => x.name === name);
if (t) console.log(`Using existing tunnel "${name}" (${t.id})`);
else {
  const c = cf('tunnel', 'create', name);
  if (c.status !== 0) { console.error(c.stderr); process.exit(1); }
  console.log(`Created tunnel "${name}"`);
}

const r = cf('tunnel', 'route', 'dns', '--overwrite-dns', name, hostname);
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log(`DNS: ${hostname} -> tunnel "${name}"`);

const envPath = path.resolve('.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const set = (k: string, v: string) => {
  const re = new RegExp(`^${k}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, `${k}=${v}`) : env.replace(/\n?$/, `\n${k}=${v}\n`);
};
set('TUNNEL_NAME', name); set('PUBLIC_HOSTNAME', hostname);
fs.writeFileSync(envPath, env);
console.log(`Saved TUNNEL_NAME and PUBLIC_HOSTNAME to .env.\n\nDone. Run \`npm run phone\` and open https://${hostname}`);
