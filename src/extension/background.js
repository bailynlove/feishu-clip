const BRIDGE = 'http://127.0.0.1:38479';

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

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
    case 'GET_SETTINGS': return localGet(['destination', 'activeAttempt']);
    case 'VALIDATE_DESTINATION': return bridge('/v1/destinations/validate', { method: 'POST', body: message.destination });
    case 'SAVE_DESTINATION': {
      const result = await bridge('/v1/destinations/validate', { method: 'POST', body: message.destination });
      await chrome.storage.local.set({ destination: result.destination });
      return result;
    }
    case 'CLIP': {
      const snapshot = await extractActiveTab();
      const attemptId = crypto.randomUUID();
      const result = await bridge('/v1/jobs', { method: 'POST', body: { attemptId, snapshot, destination: message.destination, includeImages: message.includeImages } });
      await chrome.storage.local.set({ activeAttempt: attemptId });
      return result;
    }
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
