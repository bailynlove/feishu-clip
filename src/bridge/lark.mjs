import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseLarkEnvelope(stdout) {
  const lines = String(stdout).split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith('{'));
  if (start < 0) throw new Error('LARK_INVALID_RESPONSE');
  const envelope = JSON.parse(lines.slice(start).join('\n'));
  if (envelope.ok === false) {
    const error = new Error(envelope.error?.message || 'LARK_REQUEST_FAILED');
    error.code = envelope.error?.code || envelope.error?.type || 'LARK_REQUEST_FAILED';
    throw error;
  }
  return envelope;
}

export class LarkClient {
  constructor({ cliPath, timeoutMs = 60_000 }) {
    this.cliPath = cliPath;
    this.timeoutMs = timeoutMs;
  }

  async run(args, { cwd, timeoutMs = this.timeoutMs } = {}) {
    try {
      const { stdout } = await execFileAsync(this.cliPath, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 12 * 1024 * 1024,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        },
      });
      return parseLarkEnvelope(stdout);
    } catch (error) {
      if (error.killed || error.signal) error.code = 'LARK_TIMEOUT';
      throw error;
    }
  }

  async authStatus() {
    const result = await this.run(['auth', 'status', '--json', '--verify'], { timeoutMs: 20_000 });
    return {
      ready: result.verified === true && result.identities?.user?.status === 'ready',
      identity: result.identities?.user?.name || result.identities?.user?.email || null,
    };
  }

  async listSpaces({ pageToken, pageSize = 50 } = {}) {
    const args = ['wiki', '+space-list', '--as', 'user', '--page-size', String(pageSize), '--format', 'json'];
    if (pageToken) args.push('--page-token', pageToken);
    const result = await this.run(args);
    const data = result.data || {};
    return {
      spaces: (data.spaces || []).map((space) => ({ spaceId: space.space_id, name: space.name, spaceType: space.space_type || null })),
      hasMore: data.has_more === true,
      nextPageToken: data.has_more === true ? data.page_token || null : null,
    };
  }

  async listNodes({ spaceId, parentNodeToken, pageToken, pageSize = 50 } = {}) {
    const args = ['wiki', '+node-list', '--as', 'user', '--space-id', spaceId, '--page-size', String(pageSize), '--format', 'json'];
    if (parentNodeToken) args.push('--parent-node-token', parentNodeToken);
    if (pageToken) args.push('--page-token', pageToken);
    const result = await this.run(args);
    const data = result.data || {};
    return {
      nodes: (data.nodes || []).map((node) => ({
        nodeToken: node.node_token,
        spaceId: node.space_id || spaceId,
        title: node.title,
        objType: node.obj_type || null,
        hasChildren: node.has_child === true,
      })),
      hasMore: data.has_more === true,
      nextPageToken: data.has_more === true ? data.page_token || null : null,
    };
  }

  async getSpace({ spaceId }) {
    const result = await this.run(['wiki', 'spaces', 'get', '--as', 'user', '--space-id', spaceId, '--format', 'json']);
    const space = result.data?.space || result.data;
    return { spaceId: space.space_id || spaceId, name: space.name || spaceId, spaceType: space.space_type || null };
  }

  async validateDestination({ nodeToken, spaceId }) {
    if (!nodeToken) {
      const space = await this.getSpace({ spaceId });
      return { kind: 'space', spaceId: space.spaceId, title: space.name, objType: null };
    }
    const args = ['wiki', '+node-get', '--as', 'user', '--node-token', nodeToken, '--format', 'json'];
    if (spaceId) args.push('--space-id', spaceId);
    const result = await this.run(args);
    const node = result.data?.node || result.data;
    return {
      kind: 'node',
      nodeToken: node.node_token || nodeToken,
      spaceId: node.space_id || spaceId || null,
      title: node.title || node.name || nodeToken,
      objType: node.obj_type || null,
    };
  }
}
