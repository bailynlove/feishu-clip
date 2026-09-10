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

  // Drive 目录列举（#66，picker 用）：返回全部子项（文件夹 + 文件），由 picker 侧把文件夹
  // 做成可下钻/可选中、文件项置灰展示。省略 folderToken 列根目录（我的空间）——根目录模式
  // 不支持分页、一次返回全部（#57 实测，见 research/drive-upload-facts 分支
  // docs/research/drive-upload-facts.md「列举文件夹」节），故 --page-token 只在子目录分页时携带
  async listDriveItems({ folderToken, pageToken, pageSize = 50 } = {}) {
    const args = ['drive', 'files', 'list', '--as', 'user', '--page-size', String(pageSize), '--format', 'json'];
    if (folderToken) args.push('--folder-token', folderToken);
    if (folderToken && pageToken) args.push('--page-token', pageToken);
    const result = await this.run(args);
    const data = result.data || {};
    const items = (data.files || data.items || [])
      .filter((item) => item?.token)
      .map((item) => ({ folderToken: item.token, name: item.name || item.token, type: item.type || null }));
    return {
      items,
      hasMore: data.has_more === true,
      nextPageToken: data.has_more === true ? data.page_token || null : null,
    };
  }

  // Drive 目录校验（#66）：folderToken 为 null 即根目录，恒合法；非空 token 用 +inspect
  // 证实存在且确为文件夹（bare token 须带 --type folder）。可写性不在此验证——目录失效/不可写
  // 会在上传时落成 pdf job 失败，弹窗可见可重试，无静默回退
  async validateDriveFolder({ folderToken }) {
    if (!folderToken) return { folderToken: null, name: '我的空间' };
    const result = await this.run(['drive', '+inspect', '--as', 'user', '--url', folderToken, '--type', 'folder', '--format', 'json']);
    const data = result.data || {};
    const type = data.type || data.doc_type || null;
    if (type && type !== 'folder') throw new Error('该 token 不是云盘文件夹');
    return { folderToken: data.token || folderToken, name: data.title || data.name || folderToken };
  }

  // Drive 原格式上传（#65，命令契约见 docs/research/drive-upload-facts.md）：
  // ≤20MB 一次性、>20MB CLI 自动分片；省略 folderToken 即根目录；同名复传合法并存。
  // localFileName 是调用方落盘到 cwd 的相对文件名（--file 只接受 cwd 下的相对路径，
  // 与图片 media-upload 同一约束）；displayName 是云盘展示名（--name，缺省回退 localFileName）
  async uploadDriveFile({ localFileName, displayName, folderToken, cwd, timeoutMs = 300_000 }) {
    const args = ['drive', '+upload', '--as', 'user', '--file', localFileName, '--name', displayName || localFileName, '--format', 'json'];
    if (folderToken) args.push('--folder-token', folderToken);
    const result = await this.run(args, { cwd, timeoutMs });
    const data = result.data || {};
    if (!data.file_token || !data.url) throw new Error('LARK_UPLOAD_MISSING_FILE');
    return { fileToken: data.file_token, url: data.url };
  }
}
