#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPairingCode } from '../src/bridge/pairing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const uid = process.getuid();
const domain = `gui/${uid}`;
const label = 'com.feishu-clip.bridge';
const appRoot = path.join(homedir(), 'Library', 'Application Support', 'FeishuClip');
const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const bridgeDir = path.join(appRoot, 'bridge');
const extensionDir = path.join(appRoot, 'extension');
const configDir = path.join(appRoot, 'config');
const stateDir = path.join(appRoot, 'state');
const logsDir = path.join(appRoot, 'logs');
const configPath = path.join(configDir, 'bridge.json');
const pairingPath = path.join(configDir, 'pairing.json');

function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function loaded() { return spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status === 0; }
function writeAtomic(file, content, mode) { const temporary = `${file}.new`; writeFileSync(temporary, content, { mode }); renameSync(temporary, file); chmodSync(file, mode); }
function ensureTargets() {
  if (!appRoot.endsWith('/Library/Application Support/FeishuClip') || path.basename(plistPath) !== `${label}.plist`) throw new Error('拒绝操作意外安装路径');
}
function bootout() {
  if (loaded()) spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  const deadline = Date.now() + 4_000;
  while (loaded() && Date.now() < deadline) pause(50);
  if (loaded()) throw new Error('LaunchAgent 未能退出');
  pause(150);
}
function bootstrap() {
  let result;
  for (const delay of [0, 150, 350, 700]) {
    if (delay) pause(delay);
    result = spawnSync('/bin/launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' });
    if (result.status === 0) return;
  }
  throw new Error(`LaunchAgent 启动失败：${String(result?.stderr || '').trim()}`);
}
function commandPath(command) { return spawnSync('/bin/zsh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim(); }
function pairingState({ renew = false } = {}) {
  const existing = existsSync(pairingPath) ? JSON.parse(readFileSync(pairingPath, 'utf8')) : { active: null, pending: null };
  if (!renew && (existing.active || existing.pending)) return { state: existing, code: null };
  const created = createPairingCode();
  return { state: { ...existing, pending: created.pending }, code: created.code };
}

export function launchAgentPlist({ nodePath, larkCliPath }) {
  const runtimePath = `${path.dirname(larkCliPath)}:${path.dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(path.join(bridgeDir, 'server.mjs'))}</string><string>${xml(configPath)}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict>
<key>WorkingDirectory</key><string>${xml(appRoot)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(logsDir, 'bridge.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logsDir, 'bridge.stderr.log'))}</string>
</dict></plist>`;
}

function install() {
  ensureTargets();
  const larkCliPath = commandPath('lark-cli');
  if (!larkCliPath) throw new Error('未找到 lark-cli；请先安装并完成用户登录');
  const nodePath = realpathSync(process.execPath);
  bootout();
  for (const directory of [appRoot, bridgeDir, extensionDir, configDir, stateDir, logsDir, path.dirname(plistPath)]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(appRoot, 0o700); chmodSync(configDir, 0o700); chmodSync(stateDir, 0o700); chmodSync(logsDir, 0o700);
  rmSync(bridgeDir, { recursive: true, force: true }); rmSync(extensionDir, { recursive: true, force: true });
  cpSync(path.join(repoRoot, 'src', 'bridge'), bridgeDir, { recursive: true });
  cpSync(path.join(repoRoot, 'src', 'extension'), extensionDir, { recursive: true });
  const pairing = pairingState();
  writeAtomic(pairingPath, `${JSON.stringify(pairing.state, null, 2)}\n`, 0o600);
  writeAtomic(configPath, `${JSON.stringify({
    version: packageJson.version, host: '127.0.0.1', port: 38479, larkCliPath,
    jobFile: path.join(stateDir, 'jobs.json'), pairingFile: pairingPath,
  }, null, 2)}\n`, 0o600);
  writeAtomic(plistPath, launchAgentPlist({ nodePath, larkCliPath }), 0o600);
  execFileSync('/usr/bin/plutil', ['-lint', plistPath], { stdio: 'pipe' });
  bootstrap();
  console.log(`先存飞书 ${packageJson.version} 已安装。`);
  console.log(`扩展目录：${extensionDir}`);
  if (pairing.code) console.log(`一次性配对码（10 分钟有效）：${pairing.code}`);
  else console.log('已保留现有配对。需要重新配对时运行：npm run pair:mac');
}

function renewPairing() {
  ensureTargets();
  if (!existsSync(pairingPath)) throw new Error('尚未安装');
  const pairing = pairingState({ renew: true });
  writeAtomic(pairingPath, `${JSON.stringify(pairing.state, null, 2)}\n`, 0o600);
  console.log(`新一次性配对码（10 分钟有效）：${pairing.code}`);
  console.log('新配对成功前，现有扩展仍可使用。');
}

function status() {
  ensureTargets();
  console.log(JSON.stringify({
    installed: existsSync(appRoot) && existsSync(plistPath), loaded: loaded(), version: existsSync(configPath) ? JSON.parse(readFileSync(configPath)).version : null,
    extensionDir, logsDir,
    modes: {
      root: existsSync(appRoot) ? (statSync(appRoot).mode & 0o777).toString(8) : null,
      config: existsSync(configPath) ? (statSync(configPath).mode & 0o777).toString(8) : null,
      pairing: existsSync(pairingPath) ? (statSync(pairingPath).mode & 0o777).toString(8) : null,
      plist: existsSync(plistPath) ? (statSync(plistPath).mode & 0o777).toString(8) : null,
    },
  }, null, 2));
}

function uninstall() {
  ensureTargets();
  bootout();
  rmSync(plistPath, { force: true });
  rmSync(appRoot, { recursive: true, force: true });
  console.log('Bridge、扩展安装目录、日志、配置和配对凭据均已移除。请在 Chrome 扩展页移除“先存飞书”。');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const action = process.argv[2] || 'status';
  if (action === 'install') install();
  else if (action === 'pair') renewPairing();
  else if (action === 'status') status();
  else if (action === 'uninstall') uninstall();
  else throw new Error(`未知操作：${action}`);
}
