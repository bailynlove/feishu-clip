import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeConfig, launchAgentPlist } from '../scripts/install.mjs';

test('LaunchAgent uses absolute runtime paths, minimal PATH, working directory, logs and KeepAlive', () => {
  const plist = launchAgentPlist({ nodePath: '/opt/node/bin/node', larkCliPath: '/opt/lark/bin/lark-cli' });
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist, /\/opt\/lark\/bin:\/opt\/node\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/><key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>/);
  assert.match(plist, /bridge\.stderr\.log/);
});

test('bridge config points proxy settings at the persistent config directory', () => {
  const config = bridgeConfig({ version: 'test', larkCliPath: '/opt/lark/bin/lark-cli', stateDirectory: '/state', configDirectory: '/config', pairingFile: '/config/pairing.json' });
  assert.equal(config.settingsFile, '/config/settings.json');
  assert.equal(config.aiConfigFile, '/config/ai.json');
});
