import assert from 'node:assert/strict';
import test from 'node:test';
import { launchAgentPlist } from '../scripts/install.mjs';

test('LaunchAgent uses absolute runtime paths, minimal PATH, working directory, logs and KeepAlive', () => {
  const plist = launchAgentPlist({ nodePath: '/opt/node/bin/node', larkCliPath: '/opt/lark/bin/lark-cli' });
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist, /\/opt\/lark\/bin:\/opt\/node\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/><key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>/);
  assert.match(plist, /bridge\.stderr\.log/);
});
