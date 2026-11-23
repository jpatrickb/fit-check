// macOS only: run Fit Check in the background at login, restarting it if it stops.
//   npm run service -- install     install + start (runs `npm run phone` under launchd)
//   npm run service -- uninstall   stop + remove
//   npm run service -- status      is it running? where are the logs?
//   npm run service -- restart     restart (e.g. after pulling new code or editing .env)
// Logs: ~/Library/Logs/fit-check.log
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') { console.error('launchd service is macOS-only. On Linux, use a systemd unit running `npm run phone`.'); process.exit(1); }

const label = 'com.fitcheck.app';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const log = path.join(os.homedir(), 'Library', 'Logs', 'fit-check.log');
const uid = process.getuid!();
const domain = `gui/${uid}`;
const lc = (...a: string[]) => spawnSync('launchctl', a, { encoding: 'utf8' });
const cmd = process.argv[2] || 'status';

const npm = spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim();
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

if (cmd === 'install') {
  if (!npm) { console.error('npm not found on PATH'); process.exit(1); }
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(npm)}</string><string>run</string><string>phone</string></array>
  <key>WorkingDirectory</key><string>${xml(process.cwd())}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`);
  lc('bootout', domain, plist);
  const r = lc('bootstrap', domain, plist);
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  console.log(`Installed and started. Logs: ${log}\nIt will start at login and restart if it stops. Stop it with: npm run service -- uninstall`);
} else if (cmd === 'uninstall') {
  lc('bootout', domain, plist);
  if (fs.existsSync(plist)) fs.rmSync(plist);
  console.log('Stopped and removed.');
} else if (cmd === 'restart') {
  const r = lc('kickstart', '-k', `${domain}/${label}`);
  console.log(r.status === 0 ? 'Restarted.' : r.stderr || 'Not installed (npm run service -- install).');
} else {
  const r = lc('print', `${domain}/${label}`);
  if (r.status !== 0) console.log('Not installed. Install with: npm run service -- install');
  else console.log(`${/state = running/.test(r.stdout) ? 'Running' : 'Installed, not running'}. Logs: ${log}`);
}
