import { ensurePresets } from './presets.js';
import { buildContext, renderBody, sanitizeClipTitle } from './templates.js';

const BRIDGE = 'http://127.0.0.1:38479';

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

// service worker 冷启动时幂等迁移预设存储；in-flight 复用防止并发调用各自生成 UUID 的竞态
let migrating = null;
function migratePresets() {
  migrating ??= ensurePresets(chrome.storage.local).finally(() => { migrating = null; });
  return migrating;
}
migratePresets();

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

async function bridge(path, { method = 'GET', body, authenticated = true } = {}) {
  const stored = await localGet(['credential']);
  const headers = { 'X-Feishu-Clip-Origin': `chrome-extension://${chrome.runtime.id}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticated && stored.credential) headers.Authorization = `Bearer ${stored.credential}`;
  let response;
  try {
    response = await fetch(`${BRIDGE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('本地 Bridge 未运行'), { code: 'BRIDGE_OFFLINE' });
  }
  const result = await response.json().catch(() => ({ ok: false, code: `HTTP_${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(result.message || result.code || `HTTP_${response.status}`), result);
  return result;
}

async function extractActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw Object.assign(new Error('当前页面不支持剪藏'), { code: 'UNSUPPORTED_PAGE' });
  const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractor.js'] });
  if (!execution?.result) throw new Error('未能读取当前页面');
  if (execution.result.error) throw new Error(execution.result.error);
  return execution.result;
}

async function handle(message) {
  switch (message.type) {
    case 'PAIR': {
      const result = await bridge('/v1/pair', { method: 'POST', body: { code: message.code }, authenticated: false });
      await chrome.storage.local.set({ credential: result.credential });
      return result;
    }
    case 'STATUS': return bridge('/v1/status');
    case 'GET_SETTINGS': {
      await migratePresets();
      // activeAttempt 供 job 恢复；presets/defaultPresetId 供弹窗与设置页（#35/#36）；
      // developerMode 供设置页开发者模式开关（缺省 false）
      return localGet(['activeAttempt', 'presets', 'defaultPresetId', 'developerMode']);
    }
    case 'SAVE_PRESETS': {
      // 设置页整体写回预设列表 + 默认预设（#35）；列表为空或默认预设悬空时拒绝/修复
      if (!Array.isArray(message.presets) || message.presets.length === 0) throw new Error('至少保留一套预设');
      const defaultPresetId = message.presets.some((preset) => preset.id === message.defaultPresetId)
        ? message.defaultPresetId
        : message.presets[0].id;
      await chrome.storage.local.set({ presets: message.presets, defaultPresetId });
      return { presets: message.presets, defaultPresetId };
    }
    case 'VALIDATE_DESTINATION': return bridge('/v1/destinations/validate', { method: 'POST', body: message.destination });
    case 'LIST_SPACES': {
      const params = new URLSearchParams();
      if (message.cursor) params.set('cursor', message.cursor);
      if (message.limit) params.set('limit', String(message.limit));
      const query = params.toString();
      return bridge(`/v1/targets/spaces${query ? `?${query}` : ''}`);
    }
    case 'LIST_NODES': {
      const params = new URLSearchParams({ spaceId: message.spaceId });
      if (message.parentNodeToken) params.set('parentNodeToken', message.parentNodeToken);
      if (message.cursor) params.set('cursor', message.cursor);
      if (message.limit) params.set('limit', String(message.limit));
      return bridge(`/v1/targets/nodes?${params}`);
    }
    case 'CLIP': {
      // 开发者模式耗时诊断：页面提取在扩展侧完成，bridge 看不到这段，故由扩展计时后随 job 上报考勤
      const extractStart = performance.now();
      const snapshot = await extractActiveTab();
      const extractMs = Math.round(performance.now() - extractStart);
      // 弹窗可编辑标题（#36）：渲染/手改结果随 CLIP 发来，清洗后覆盖；为空回退 extractor 标题
      const title = sanitizeClipTitle(message.title);
      if (title) snapshot.title = title;
      // 正文合成（#37，#40 起有效模板 = 弹窗自定义正文框内容）：与弹窗预览同调 renderBody；
      // ctx 在标题覆盖之后构建，正文模板看到的即最终标题
      snapshot.markdown = renderBody(message.customBody, buildContext(snapshot));
      const attemptId = crypto.randomUUID();
      const result = await bridge('/v1/jobs', { method: 'POST', body: { attemptId, snapshot, destination: message.destination, includeImages: message.includeImages, clientTiming: { extractMs } } });
      await chrome.storage.local.set({ activeAttempt: attemptId });
      return result;
    }
    // 任务日志（开发者模式）：bridge 侧统一记录耗时时间线，设置页透传展示
    case 'LIST_JOBS': return bridge('/v1/jobs?limit=20');
    // 预览懒提取（#37）：只抓快照、不建 job；弹窗首次展开预览时调用
    case 'EXTRACT': return extractActiveTab();
    case 'GET_JOB': {
      const result = await bridge(`/v1/jobs/${message.attemptId}`);
      if (['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired', 'cancelled', 'cancelled_with_document'].includes(result.job.status)) {
        await chrome.storage.local.remove('activeAttempt');
      }
      return result;
    }
    default: throw new Error('UNKNOWN_MESSAGE');
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: { code: error.code || 'ERROR', message: error.message } }));
  return true;
});
