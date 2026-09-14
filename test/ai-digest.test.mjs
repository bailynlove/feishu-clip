import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AI_DEFAULT_BASE_URL, AI_FILE_MAX_BYTES, AI_MAX_INPUT_CHARS, AI_TIMEOUT_MS, AiConfigStore, applyDigest, DEFAULT_DIGEST_INSTRUCTION, generateDigest, hasFilePlaceholder, mergeAiTestConfig, normalizeAiConfigInput, normalizeProviderName, sanitizeAiConfig, sanitizeProvider, stripFilePlaceholder } from '../src/bridge/ai-digest.mjs';
import { DEFAULT_DIGEST_INSTRUCTION as EXTENSION_DEFAULT_DIGEST_INSTRUCTION } from '../src/extension/presets.js';

// 捕获请求的 fake fetch + 可编程应答；body 做成可异步迭代（与 fetch 的 Response.body 同形）
function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return respond({ url, options });
  };
  return { calls, fetch: impl };
}

function jsonResponse(payload, { status = 200 } = {}) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* () { yield Buffer.from(text); })(),
    text: async () => text,
  };
}

// 假 SSE 流（#86）：events 每项 { event?, data }（data 对象自动 JSON 化；字符串原样输出，
// 用于 '[DONE]' 哨兵）。chunkSize 把负载切成定长块——取 1 时每字节一块，
// 多字节字符必被切断，顺带压测增量解码
function sseResponse(events, { status = 200, chunkSize = null } = {}) {
  const text = events.map((event) => {
    if (typeof event === 'string') return `data: ${event}\n\n`;
    const lines = [];
    if (event.event) lines.push(`event: ${event.event}`);
    lines.push(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}`);
    return `${lines.join('\n')}\n\n`;
  }).join('');
  const buffer = Buffer.from(text);
  const chunks = [];
  for (let at = 0; at < buffer.length; at += chunkSize ?? buffer.length) chunks.push(buffer.subarray(at, at + (chunkSize ?? buffer.length)));
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
    text: async () => text,
  };
}

// 三型的最小成功流：responses 走 response.completed 终止帧（帧内 response 对象是终态文本口径）；
// chat-completions 走 content delta + [DONE]；messages 走 content_block_delta 的 text_delta
const SSE_OK = {
  responses: (text = '摘要') => [{ data: { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } } }],
  'chat-completions': (text = '摘要') => [{ data: { choices: [{ delta: { content: text } }] } }, '[DONE]'],
  messages: (text = '摘要') => [
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ],
};

const CONFIG = {
  responses: { apiType: 'responses', baseUrl: 'https://api.example.com/v1', model: 'gpt-5', apiKey: 'sk-test' },
  'chat-completions': { apiType: 'chat-completions', baseUrl: 'https://api.example.com/v1', model: 'gpt-5', apiKey: 'sk-test' },
  messages: { apiType: 'messages', baseUrl: 'https://api.anthropic.com', model: 'claude-x', apiKey: 'sk-ant' },
};

test('responses 请求构造：URL 拼 /responses，Bearer 认证，instructions 顶层 + store:false，默认走流式', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses()));
  const digest = await generateDigest({ config: CONFIG.responses, instruction: '总结它', content: '正文', fetchImpl: fetch });
  assert.equal(digest, '摘要');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/responses');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, { model: 'gpt-5', instructions: '总结它', input: '正文', store: false, max_output_tokens: 2048, stream: true });
});

test('chat-completions 请求构造：URL 拼 /chat/completions，system+user 消息，max_completion_tokens，流式带 include_usage', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK['chat-completions']()));
  const digest = await generateDigest({ config: CONFIG['chat-completions'], instruction: '总结它', content: '正文', fetchImpl: fetch });
  assert.equal(digest, '摘要');
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, {
    model: 'gpt-5',
    messages: [{ role: 'system', content: '总结它' }, { role: 'user', content: '正文' }],
    max_completion_tokens: 2048,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.ok(!('max_tokens' in calls[0].body), 'max_tokens 已废弃，勿用');
});

test('messages 请求构造：base 不带 /v1 拼 /v1/messages，x-api-key + anthropic-version，max_tokens 必填，默认走流式', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.messages()));
  const digest = await generateDigest({ config: CONFIG.messages, instruction: '总结它', content: '正文', fetchImpl: fetch });
  assert.equal(digest, '摘要');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages', 'base 不含 /v1，版本段在路径里');
  assert.equal(calls[0].options.headers['x-api-key'], 'sk-ant');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(calls[0].body, { model: 'claude-x', max_tokens: 2048, system: '总结它', messages: [{ role: 'user', content: '正文' }], stream: true });
});

test('stream:false 保持非流式（「测试连接」契约）：请求体无 stream 字段，按整 JSON 解析', async () => {
  const { calls, fetch } = fakeFetch(async () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }));
  const digest = await generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: fetch, stream: false });
  assert.equal(digest, 'ok');
  assert.ok(!('stream' in calls[0].body), 'responses 非流式不带 stream');
  // 非流式的响应级失败（incomplete）语义原样保留
  const incomplete = fakeFetch(async () => jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
  await assert.rejects(
    () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: incomplete.fetch, stream: false }),
    (error) => error.code === 'AI_REQUEST_FAILED' && /max_output_tokens/.test(error.message),
  );
  const chat = fakeFetch(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await generateDigest({ config: CONFIG['chat-completions'], instruction: 'i', content: 'c', fetchImpl: chat.fetch, stream: false });
  assert.ok(!('stream' in chat.calls[0].body) && !('stream_options' in chat.calls[0].body), 'chat-completions 非流式不带 stream/stream_options');
  const ant = fakeFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
  await generateDigest({ config: CONFIG.messages, instruction: 'i', content: 'c', fetchImpl: ant.fetch, stream: false });
  assert.ok(!('stream' in ant.calls[0].body), 'messages 非流式不带 stream');
});

test('baseUrl 省略/尾部斜杠：回落各类型默认值，拼接前先剥尾斜杠', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses('x')));
  await generateDigest({ config: { apiType: 'responses', model: 'm', apiKey: 'k' }, instruction: 'i', content: 'c', fetchImpl: fetch });
  assert.equal(calls[0].url, `${AI_DEFAULT_BASE_URL.responses}/responses`);
  await generateDigest({ config: { ...CONFIG.responses, baseUrl: 'https://api.example.com/v1/' }, instruction: 'i', content: 'c', fetchImpl: fetch });
  assert.equal(calls[1].url, 'https://api.example.com/v1/responses');
});

test('responses 流式终帧提取：response.completed 帧内 response 对象为准（跳过 reasoning item 找 message/output_text）', async () => {
  const payload = {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'refusal', refusal: '' }, { type: 'output_text', text: '真正摘要' }] },
    ],
  };
  // delta 累计文本与终帧文本不一致时，以终帧为准（与非流式口径等价）
  const { fetch } = fakeFetch(async () => sseResponse([
    { data: { type: 'response.output_text.delta', delta: '片段' } },
    { data: { type: 'response.completed', response: payload } },
  ]));
  const digest = await generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: fetch });
  assert.equal(digest, '真正摘要');
});

test('responses 流式：终止帧 status=="incomplete"/"failed" 按失败处理（与非流式同一语义）', async () => {
  for (const [eventType, status] of [['response.incomplete', 'incomplete'], ['response.failed', 'failed']]) {
    const payload = { status, incomplete_details: { reason: 'max_output_tokens' }, output: [] };
    const { fetch } = fakeFetch(async () => sseResponse([{ data: { type: eventType, response: payload } }]));
    await assert.rejects(
      () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: fetch }),
      (error) => error.code === 'AI_REQUEST_FAILED' && /max_output_tokens/.test(error.message),
    );
  }
});

test('responses 流式进度：reasoning delta → thinking，正文 delta → writing，终帧 usage 校准计数', async () => {
  const events = [
    { data: { type: 'response.reasoning_summary_text.delta', delta: '想想' } },
    { data: { type: 'response.reasoning_text.delta', delta: 'think' } },
    { data: { type: 'response.output_text.delta', delta: '要点一' } },
    { data: { type: 'response.output_text.delta', delta: '要点二' } },
    { data: { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '要点一要点二' }] }], usage: { output_tokens: 42 } } } },
  ];
  const { fetch } = fakeFetch(async () => sseResponse(events));
  const progress = [];
  const digest = await generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: fetch, onProgress: (update) => progress.push(update) });
  assert.equal(digest, '要点一要点二');
  assert.deepEqual(progress[0], { phase: 'thinking', tokens: 2 }, 'reasoning delta 计 thinking（CJK 1 字 ≈ 1 token）');
  assert.deepEqual(progress[1], { phase: 'thinking', tokens: 4 }, 'reasoning_text.delta 同样计 thinking（latin ~4 字符/token）');
  assert.equal(progress[2].phase, 'writing', '正文 delta 翻 writing');
  assert.equal(progress[3].tokens, 6, '正文近似累计：6 个 CJK 字');
  assert.deepEqual(progress.at(-1), { phase: 'writing', tokens: 42 }, '终帧 usage.output_tokens 校准最终计数');
});

test('responses 流式：无终止帧（代理截断事件流）回落 delta 累计文本', async () => {
  const { fetch } = fakeFetch(async () => sseResponse([
    { data: { type: 'response.output_text.delta', delta: '前' } },
    { data: { type: 'response.output_text.delta', delta: '后' } },
  ]));
  assert.equal(await generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: fetch }), '前后');
});

test('messages 流式提取：text_delta 跨块按 \\n 拼接（与非流式同口径）；无文本按失败处理', async () => {
  const events = [
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第一段' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '思考' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '第二段' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  const { fetch } = fakeFetch(async () => sseResponse(events));
  const progress = [];
  const digest = await generateDigest({ config: CONFIG.messages, instruction: 'i', content: 'c', fetchImpl: fetch, onProgress: (update) => progress.push(update) });
  assert.equal(digest, '第一段\n第二段');
  assert.deepEqual(progress[0], { phase: 'writing', tokens: 3 });
  assert.deepEqual(progress[1], { phase: 'thinking', tokens: 2 }, 'thinking_delta 计 thinking');
  assert.deepEqual(progress.at(-1), { phase: 'writing', tokens: 9 }, 'message_delta 的 usage.output_tokens 校准');

  const none = fakeFetch(async () => sseResponse([
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '……' } } },
  ]));
  await assert.rejects(
    () => generateDigest({ config: CONFIG.messages, instruction: 'i', content: 'c', fetchImpl: none.fetch }),
    (error) => error.code === 'AI_REQUEST_FAILED',
  );
});

test('messages 流式：error 事件按失败处理，透传对方错误消息', async () => {
  const { fetch } = fakeFetch(async () => sseResponse([
    { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ]));
  await assert.rejects(
    () => generateDigest({ config: CONFIG.messages, instruction: 'i', content: 'c', fetchImpl: fetch }),
    (error) => error.code === 'AI_REQUEST_FAILED' && /Overloaded/.test(error.message),
  );
});

test('chat-completions 流式：content/reasoning_content 区分相位，usage 末帧校准，[DONE] 哨兵收尾', async () => {
  const events = [
    { data: { choices: [{ delta: { role: 'assistant', content: '' } }] } },
    { data: { choices: [{ delta: { reasoning_content: '想想' } }] } },
    { data: { choices: [{ delta: { content: '要' } }] } },
    { data: { choices: [{ delta: { content: '点' } }] } },
    { data: { choices: [], usage: { completion_tokens: 17 } } },
    '[DONE]',
  ];
  const { fetch } = fakeFetch(async () => sseResponse(events));
  const progress = [];
  const digest = await generateDigest({ config: CONFIG['chat-completions'], instruction: 'i', content: 'c', fetchImpl: fetch, onProgress: (update) => progress.push(update) });
  assert.equal(digest, '要点');
  assert.deepEqual(progress[0], { phase: 'thinking', tokens: 2 }, 'reasoning_content（GLM/DeepSeek 惯例）计 thinking；空 content 首帧不翻相位');
  assert.deepEqual(progress[1], { phase: 'writing', tokens: 1 });
  assert.deepEqual(progress.at(-1), { phase: 'writing', tokens: 17 }, '末帧 usage.completion_tokens 校准');

  // 整流无正文 delta → 与非流式缺 choices 同一句失败
  const malformed = fakeFetch(async () => sseResponse(['[DONE]']));
  await assert.rejects(
    () => generateDigest({ config: CONFIG['chat-completions'], instruction: 'i', content: 'c', fetchImpl: malformed.fetch }),
    (error) => error.code === 'AI_REQUEST_FAILED' && error.message === 'AI 响应中没有文本输出',
  );
});

test('SSE 增量解析：每字节一块（多字节字符必被切断）也能正确拼回事件与文本', async () => {
  const { fetch } = fakeFetch(async () => sseResponse(SSE_OK.messages('逐字流摘要'), { chunkSize: 1 }));
  assert.equal(await generateDigest({ config: CONFIG.messages, instruction: 'i', content: 'c', fetchImpl: fetch }), '逐字流摘要');
});

test('流式消费超时：事件流中途挂起，AbortController 到期映射为 AI_TIMEOUT', async () => {
  const hangingStream = async (_url, options) => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield Buffer.from('data: {"type":"response.output_text.delta","delta":"x"}\n\n');
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    })(),
  });
  await assert.rejects(
    () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: hangingStream, timeoutMs: 20 }),
    (error) => error.code === 'AI_TIMEOUT',
  );
});

test(`输入截断：正文超过 ${AI_MAX_INPUT_CHARS} 字符截断并附截断说明`, async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses('x')));
  await generateDigest({ config: CONFIG.responses, instruction: 'i', content: '字'.repeat(AI_MAX_INPUT_CHARS + 500), fetchImpl: fetch });
  const input = calls[0].body.input;
  assert.ok(input.startsWith('字'.repeat(100)), '保留正文前缀');
  assert.ok(input.length < AI_MAX_INPUT_CHARS + 100, '整体长度被截断收敛');
  assert.match(input, /（正文过长，已截断）$/, '末尾附截断说明');
});

test('超时：AbortController 到期中断映射为 AI_TIMEOUT', async () => {
  const hanging = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: hanging, timeoutMs: 20 }),
    (error) => error.code === 'AI_TIMEOUT',
  );
});

test('timeoutMs 解析顺序：显式参数 > config.timeoutMs（高级设置）> 内置默认 180s', async () => {
  assert.equal(AI_TIMEOUT_MS, 180_000, '内置默认从 60s 上调到 180s（reasoning 模型思考也耗时，60s 对慢 provider 太紧）');
  const hanging = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    () => generateDigest({ config: { ...CONFIG.responses, timeoutMs: 20 }, instruction: 'i', content: 'c', fetchImpl: hanging }),
    (error) => error.code === 'AI_TIMEOUT',
    'config.timeoutMs 优先于内置默认',
  );
  await assert.rejects(
    () => generateDigest({ config: { ...CONFIG.responses, timeoutMs: 600_000 }, instruction: 'i', content: 'c', fetchImpl: hanging, timeoutMs: 20 }),
    (error) => error.code === 'AI_TIMEOUT',
    '显式参数优先于 config.timeoutMs',
  );
});

test('非 2xx 错误映射：401/403→AI_AUTH_FAILED，429→AI_RATE_LIMITED，其余→AI_REQUEST_FAILED；抽取对方错误消息', async () => {
  const cases = [
    [401, 'AI_AUTH_FAILED'], [403, 'AI_AUTH_FAILED'], [429, 'AI_RATE_LIMITED'], [500, 'AI_REQUEST_FAILED'],
  ];
  for (const [status, code] of cases) {
    const { fetch } = fakeFetch(async () => jsonResponse({ error: { message: `vendor says no (${status})` } }, { status }));
    await assert.rejects(
      () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: fetch }),
      (error) => error.code === code && error.message === `vendor says no (${status})`,
    );
  }
  // 非 JSON 错误体：取原文截断
  const html = fakeFetch(async () => ({
    ok: false, status: 502,
    body: (async function* () { yield Buffer.from('<html>bad gateway</html>'); })(),
  }));
  await assert.rejects(
    () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: html.fetch }),
    (error) => error.code === 'AI_REQUEST_FAILED' && /bad gateway/.test(error.message),
  );
  // 网络层失败（fetch 抛错）→ AI_REQUEST_FAILED
  const down = fakeFetch(async () => { throw new Error('connect ECONNREFUSED'); });
  await assert.rejects(
    () => generateDigest({ config: CONFIG.responses, instruction: 'i', content: 'c', fetchImpl: down.fetch }),
    (error) => error.code === 'AI_REQUEST_FAILED' && /ECONNREFUSED/.test(error.message),
  );
});

test('未配置/配置不全 → AI_NOT_CONFIGURED，不发请求', async () => {
  const { calls, fetch } = fakeFetch(async () => jsonResponse({}));
  for (const config of [null, { apiType: 'responses' }, { apiType: 'nope', model: 'm', apiKey: 'k' }, { apiType: 'responses', model: 'm' }]) {
    await assert.rejects(
      () => generateDigest({ config, instruction: 'i', content: 'c', fetchImpl: fetch }),
      (error) => error.code === 'AI_NOT_CONFIGURED',
    );
  }
  assert.equal(calls.length, 0);
});

test('applyDigest：占位符原位替换（digestText 为 null 时置空），永远不含默认标题', () => {
  assert.equal(applyDigest('前文 {{digest}} 后文', '要点'), '前文 要点 后文');
  assert.equal(applyDigest('{{digest}} 与 {{ digest }} 两处', '要点'), '要点 与 要点 两处', '带空格写法归一且全部替换');
  assert.equal(applyDigest('前文 {{digest}} 后文', null), '前文  后文', 'null 替换为空串');
  assert.equal(applyDigest('前文 {{digest}} 后文', ''), '前文  后文');
});

test('applyDigest：无占位符时非空 digestText 走默认布局，null 原样返回', () => {
  assert.equal(applyDigest('# 正文', '要点'), '# Digest\n\n要点\n\n# RAW content\n\n# 正文');
  assert.equal(applyDigest('# 正文', null), '# 正文');
  assert.equal(applyDigest('# 正文', ''), '# 正文', '空串等同没有摘要');
});

test('normalizeAiConfigInput：机器码校验 + baseUrl 允许私有/回环地址', async () => {
  const bad = (body, code) => assert.throws(() => normalizeAiConfigInput(body), (error) => error.code === code);
  bad({}, 'AI_TYPE_INVALID');
  bad({ apiType: 'gpt4' }, 'AI_TYPE_INVALID');
  bad({ apiType: 'responses', baseUrl: 'ftp://x' }, 'AI_BASE_URL_INVALID');
  bad({ apiType: 'responses', baseUrl: 'not-a-url' }, 'AI_BASE_URL_INVALID');
  bad({ apiType: 'responses', baseUrl: `https://example.com/${'a'.repeat(300)}` }, 'AI_BASE_URL_INVALID');
  bad({ apiType: 'responses', model: '' }, 'AI_MODEL_INVALID');
  bad({ apiType: 'responses', model: '  ' }, 'AI_MODEL_INVALID');
  bad({ apiType: 'responses', model: 'm'.repeat(129) }, 'AI_MODEL_INVALID');
  bad({ apiType: 'responses', model: 'm', apiKey: 'k'.repeat(513) }, 'AI_KEY_INVALID');
  assert.throws(() => normalizeAiConfigInput({ apiType: 'responses', model: 'm' }, { requireKey: true }), (error) => error.code === 'AI_KEY_REQUIRED');

  // Ollama 场景：私有/回环地址显式允许（image-policy 公网-only 的例外）
  const local = normalizeAiConfigInput({ apiType: 'chat-completions', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', apiKey: 'ollama' });
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1');
  // baseUrl 省略回落默认；尾部斜杠剥除
  const defaulted = normalizeAiConfigInput({ apiType: 'messages', model: 'claude-x', apiKey: 'k' });
  assert.equal(defaulted.baseUrl, 'https://api.anthropic.com');
  assert.equal(normalizeAiConfigInput({ apiType: 'responses', baseUrl: 'https://x.com/v1/', model: 'm' }).baseUrl, 'https://x.com/v1');
});

test('mergeAiTestConfig：逐项覆盖回落已存配置；无已存配置且未给全 → AI_NOT_CONFIGURED', () => {
  const saved = { apiType: 'messages', baseUrl: 'https://api.anthropic.com', model: 'claude-x', apiKey: 'saved-key' };
  assert.deepEqual(mergeAiTestConfig({}, saved), saved, '全省略回落已存');
  assert.deepEqual(mergeAiTestConfig({ model: 'claude-y' }, saved), { ...saved, model: 'claude-y' });
  assert.equal(mergeAiTestConfig({ apiKey: 'new-key' }, saved).apiKey, 'new-key');
  assert.equal(mergeAiTestConfig({ apiKey: '' }, saved).apiKey, 'saved-key', '空串 apiKey 回落已存 key');
  // 设置页清空某框点「测试连接」：空串 model/baseUrl 与 apiKey 同语义，回落已存配置而非报错/类型默认
  assert.equal(mergeAiTestConfig({ model: '' }, saved).model, 'claude-x', '空串 model 回落已存 model');
  assert.equal(mergeAiTestConfig({ baseUrl: '' }, saved).baseUrl, 'https://api.anthropic.com', '空串 baseUrl 回落已存 baseUrl');
  assert.throws(() => mergeAiTestConfig({}, null), (error) => error.code === 'AI_NOT_CONFIGURED');
  assert.throws(() => mergeAiTestConfig({ apiType: 'responses', model: 'm' }, null), (error) => error.code === 'AI_NOT_CONFIGURED', '缺 key');
  const full = mergeAiTestConfig({ apiType: 'responses', model: 'm', apiKey: 'k' }, null);
  assert.equal(full.baseUrl, AI_DEFAULT_BASE_URL.responses, '给全即可用，baseUrl 回落默认');
});

async function withAiStore(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-ai-'));
  const filePath = path.join(directory, 'config', 'ai.json');
  try {
    await run(new AiConfigStore(filePath), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const DS = { apiType: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-ds' };

// ——— 多 provider 存储（#77）：ai.json 形态 { providers: { 名字: 配置 } }，「默认」为保留名 ———

test('normalizeProviderName：非空 ≤64 字符，去空白；非法值带机器码', () => {
  assert.equal(normalizeProviderName('  ds '), 'ds');
  assert.equal(normalizeProviderName('默认'), '默认');
  const badName = (value) => assert.throws(() => normalizeProviderName(value), (error) => error.code === 'AI_PROVIDER_NAME_INVALID');
  for (const value of [undefined, null, '', '   ', 42, 'x'.repeat(65)]) badName(value);
});

test('AiConfigStore：旧版单配置（#75 形态）首次读取自动迁移为「默认」provider 并原子落盘', async () => {
  await withAiStore(async (store, filePath) => {
    const legacy = { apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: 'sk-old', headers: { 'x-s': '1' }, maxOutputTokens: 4096 };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const migrated = await store.read();
    assert.deepEqual(migrated.providers['默认'], legacy, '原配置（含 key/高级设置）原样成为「默认」');
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(persisted, { providers: { 默认: legacy } }, '迁移立即落盘');
    assert.equal((await stat(filePath)).mode & 0o777, 0o600, '迁移后仍 0600');
  });
});

test('AiConfigStore 多 provider：saveProvider 增改、list 默认在前、readProvider、空文件按 null 读', async () => {
  await withAiStore(async (store, filePath) => {
    assert.equal(await store.read(), null, '文件不存在按未配置');
    assert.deepEqual(await store.list(), [], '无文件时 list 为空');
    await store.saveProvider('默认', { apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-main' });
    await store.saveProvider('ds', DS);
    assert.deepEqual((await store.list()).map((p) => p.name), ['默认', 'ds'], 'list 默认在前');
    assert.equal((await store.readProvider('ds')).model, 'deepseek-chat');
    assert.equal(await store.readProvider('nope'), null);
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.providers.ds.apiKey, 'sk-ds');
    assert.equal((await stat(filePath)).mode & 0o777, 0o600, 'key 文件 0600');
  });
});

test('AiConfigStore：按 provider 保留已存 key；renameFrom 改名搬 key 并删旧名', async () => {
  await withAiStore(async (store) => {
    await store.saveProvider('默认', { apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-main' });
    await store.saveProvider('ds', DS);
    // 省略/空串 apiKey 保留该 provider 自己的已存 key（互不影响）
    for (const apiKey of ['', undefined]) {
      const saved = await store.saveProvider('ds', { ...DS, model: 'deepseek-v4', apiKey });
      assert.equal(saved.apiKey, 'sk-ds', `apiKey=${String(apiKey)} 保留 ds 已存 key`);
      assert.equal((await store.readProvider('默认')).apiKey, 'sk-main', '默认的 key 不受影响');
    }
    // 改名：ds → deepseek，key 搬走，旧名删除
    const renamed = await store.saveProvider('deepseek', { ...DS, model: 'deepseek-v4', apiKey: '' }, { renameFrom: 'ds' });
    assert.equal(renamed.apiKey, 'sk-ds', '改名继承旧 key');
    assert.equal(await store.readProvider('ds'), null, '旧名已删');
    assert.deepEqual((await store.list()).map((p) => p.name), ['默认', 'deepseek']);
  });
});

test('AiConfigStore：deleteProvider 删除存在项返回 true，缺项 false', async () => {
  await withAiStore(async (store) => {
    await store.saveProvider('默认', { apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-main' });
    await store.saveProvider('ds', DS);
    assert.equal(await store.deleteProvider('ds'), true);
    assert.deepEqual((await store.list()).map((p) => p.name), ['默认']);
    assert.equal(await store.deleteProvider('ds'), false, '重复删除返回 false');
  });
});

test('AiConfigStore：readDefault 回落——有「默认」用它，没有则用第一套，空为 null', async () => {
  await withAiStore(async (store) => {
    assert.equal(await store.readDefault(), null);
    await store.saveProvider('ds', DS);
    assert.equal((await store.readDefault()).model, 'deepseek-chat', '无「默认」时回落第一套');
    await store.saveProvider('默认', { apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-main' });
    assert.equal((await store.readDefault()).model, 'gpt-5', '有「默认」优先');
  });
});

test('sanitizeProvider：随名单套脱敏（hasKey 不回显 key）', () => {
  const safe = sanitizeProvider('ds', { ...DS, maxOutputTokens: 4096 });
  assert.equal(safe.name, 'ds');
  assert.equal(safe.hasKey, true);
  assert.equal(safe.maxOutputTokens, 4096);
  assert.ok(!JSON.stringify(safe).includes('sk-ds'));
});


// ——— 高级设置（opencode-go x-opencode-session / reasoning 模型 max_output_tokens 缺口，
// 见 #75 后续诊断）：config.headers 与 config.maxOutputTokens 两个选填项 ———

test('自定义请求头：config.headers 合并进请求（默认头保留、可被覆盖），三型都生效', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses()));
  const config = { ...CONFIG.responses, headers: { 'x-opencode-session': 'sess-1' } };
  await generateDigest({ config, instruction: 'i', content: 'c', fetchImpl: fetch });
  assert.equal(calls[0].options.headers['x-opencode-session'], 'sess-1');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test', '默认头保留');

  // 自定义头可覆盖默认头（特殊网关改认证方案场景）
  await generateDigest({ config: { ...CONFIG.responses, headers: { Authorization: 'Bearer other' } }, instruction: 'i', content: 'c', fetchImpl: fetch });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer other');

  // Anthropic 型同样合并（x-api-key / anthropic-version 保留）
  const antFake = fakeFetch(async () => sseResponse(SSE_OK.messages()));
  await generateDigest({ config: { ...CONFIG.messages, headers: { 'x-opencode-session': 'sess-2' } }, instruction: 'i', content: 'c', fetchImpl: antFake.fetch });
  assert.equal(antFake.calls[0].options.headers['x-opencode-session'], 'sess-2');
  assert.equal(antFake.calls[0].options.headers['x-api-key'], 'sk-ant');
  assert.equal(antFake.calls[0].options.headers['anthropic-version'], '2023-06-01');
});

test('maxOutputTokens：配置值优先于内置默认 2048；显式参数（测试探针）优先于配置值', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses()));
  const config = { ...CONFIG.responses, maxOutputTokens: 4096 };
  await generateDigest({ config, instruction: 'i', content: 'c', fetchImpl: fetch });
  assert.equal(calls[0].body.max_output_tokens, 4096, 'config.maxOutputTokens 优先于内置默认');
  await generateDigest({ config, instruction: 'i', content: 'c', fetchImpl: fetch, maxOutputTokens: 64 });
  assert.equal(calls[1].body.max_output_tokens, 64, '显式参数优先于配置值');
});

test('normalizeAiConfigInput：headers/maxOutputTokens/timeoutMs 选填，非法值带机器码', () => {
  const good = normalizeAiConfigInput({ apiType: 'responses', model: 'm', apiKey: 'k', headers: { 'x-opencode-session': 's' }, maxOutputTokens: 8192, timeoutMs: 300_000 });
  assert.deepEqual(good.headers, { 'x-opencode-session': 's' });
  assert.equal(good.maxOutputTokens, 8192);
  assert.equal(good.timeoutMs, 300_000);
  // 省略则不出现（落库/回显保持干净）
  const plain = normalizeAiConfigInput({ apiType: 'responses', model: 'm', apiKey: 'k' });
  assert.ok(!('headers' in plain) && !('maxOutputTokens' in plain) && !('timeoutMs' in plain));
  const bad = (body, code) => assert.throws(() => normalizeAiConfigInput(body), (error) => error.code === code);
  bad({ apiType: 'responses', model: 'm', headers: 'x: y' }, 'AI_HEADERS_INVALID');
  bad({ apiType: 'responses', model: 'm', headers: ['x'] }, 'AI_HEADERS_INVALID');
  bad({ apiType: 'responses', model: 'm', headers: { 'bad name': 'v' } }, 'AI_HEADERS_INVALID');
  bad({ apiType: 'responses', model: 'm', headers: { 'x-a': 1 } }, 'AI_HEADERS_INVALID');
  bad({ apiType: 'responses', model: 'm', headers: { 'x-a': 'v'.repeat(1025) } }, 'AI_HEADERS_INVALID');
  bad({ apiType: 'responses', model: 'm', maxOutputTokens: 'big' }, 'AI_MAX_OUTPUT_TOKENS_INVALID');
  bad({ apiType: 'responses', model: 'm', maxOutputTokens: 0 }, 'AI_MAX_OUTPUT_TOKENS_INVALID');
  bad({ apiType: 'responses', model: 'm', maxOutputTokens: 3.5 }, 'AI_MAX_OUTPUT_TOKENS_INVALID');
  bad({ apiType: 'responses', model: 'm', maxOutputTokens: 1_000_000 }, 'AI_MAX_OUTPUT_TOKENS_INVALID');
  bad({ apiType: 'responses', model: 'm', timeoutMs: 'slow' }, 'AI_TIMEOUT_MS_INVALID');
  bad({ apiType: 'responses', model: 'm', timeoutMs: 0 }, 'AI_TIMEOUT_MS_INVALID');
  bad({ apiType: 'responses', model: 'm', timeoutMs: 3.5 }, 'AI_TIMEOUT_MS_INVALID');
  bad({ apiType: 'responses', model: 'm', timeoutMs: 4999 }, 'AI_TIMEOUT_MS_INVALID');
  bad({ apiType: 'responses', model: 'm', timeoutMs: 1_800_001 }, 'AI_TIMEOUT_MS_INVALID');
});

test('mergeAiTestConfig：headers/maxOutputTokens/timeoutMs 覆盖与回落已存，非法覆盖报错', () => {
  const saved = {
    apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'saved-key',
    headers: { 'x-opencode-session': 'saved-sess' }, maxOutputTokens: 8192, timeoutMs: 300_000,
  };
  assert.deepEqual(mergeAiTestConfig({}, saved), saved, '全省略回落已存（含高级项）');
  assert.deepEqual(mergeAiTestConfig({ headers: {} }, saved).headers, saved.headers, '空 headers 对象回落已存');
  assert.deepEqual(mergeAiTestConfig({ headers: { 'x-opencode-session': 'new-sess' } }, saved).headers, { 'x-opencode-session': 'new-sess' });
  assert.equal(mergeAiTestConfig({ maxOutputTokens: 4096 }, saved).maxOutputTokens, 4096);
  assert.throws(() => mergeAiTestConfig({ maxOutputTokens: 'big' }, saved), (error) => error.code === 'AI_MAX_OUTPUT_TOKENS_INVALID');
  assert.equal(mergeAiTestConfig({ timeoutMs: 120_000 }, saved).timeoutMs, 120_000);
  assert.throws(() => mergeAiTestConfig({ timeoutMs: 'slow' }, saved), (error) => error.code === 'AI_TIMEOUT_MS_INVALID');
  // 已存无高级项时合并结果也不出现这三个键
  const bare = { apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'k' };
  const merged = mergeAiTestConfig({}, bare);
  assert.ok(!('headers' in merged) && !('maxOutputTokens' in merged) && !('timeoutMs' in merged));
});

test('sanitizeAiConfig：headers/maxOutputTokens/timeoutMs 随配置回显（设置页回填用），key 永不回显', () => {
  const full = sanitizeAiConfig({
    apiType: 'responses', baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'sk-secret',
    headers: { 'x-opencode-session': 'sess-1' }, maxOutputTokens: 4096, timeoutMs: 300_000,
  });
  assert.deepEqual(full.headers, { 'x-opencode-session': 'sess-1' });
  assert.equal(full.maxOutputTokens, 4096);
  assert.equal(full.timeoutMs, 300_000);
  assert.ok(!JSON.stringify(full).includes('sk-secret'));
  const bare = sanitizeAiConfig({ apiType: 'responses', baseUrl: 'https://x.com/v1', model: 'm', apiKey: '' });
  assert.ok(!('headers' in bare) && !('maxOutputTokens' in bare) && !('timeoutMs' in bare), '未配置高级项时不出现');
});

// ——— {{@file}} 占位符（#79）：本次剪藏的 PDF 以 base64 附件随摘要请求发出；
// 占位符从指令剥除（剥空回落内置默认）；降级（无 PDF / 超 32 MB）由 executor 决策 ———

const PDF_B64 = Buffer.from('%PDF-1.7 fake-pdf-bytes').toString('base64');
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_B64}`;

test('{{@file}} 占位符检出与剥除：空格写法归一；剥空回落内置默认；默认值与扩展侧同步', () => {
  assert.equal(hasFilePlaceholder('结合附件总结 {{@file}}'), true);
  assert.equal(hasFilePlaceholder('{{ @file }}'), true, '带空格写法同样检出');
  assert.equal(hasFilePlaceholder('总结它'), false);
  assert.equal(hasFilePlaceholder(''), false);
  assert.equal(stripFilePlaceholder('结合附件总结 {{@file}}'), '结合附件总结');
  assert.equal(stripFilePlaceholder('{{ @file }}'), DEFAULT_DIGEST_INSTRUCTION, '剥空回落内置默认');
  assert.equal(stripFilePlaceholder('总结它'), '总结它', '无占位符原样返回');
  assert.equal(stripFilePlaceholder('  总结它  '), '  总结它  ', '无占位符不做 trim，请求体与既有行为逐字节一致');
  assert.equal(AI_FILE_MAX_BYTES, 32 * 1024 * 1024, '附件上限 32 MB（对齐 Anthropic 请求体上限）');
  assert.equal(DEFAULT_DIGEST_INSTRUCTION, EXTENSION_DEFAULT_DIGEST_INSTRUCTION, '与扩展侧内置默认同一份（两运行时无法共享模块）');
});

test('{{@file}} + PDF：responses 走 input_file 块（base64 data URL），instructions 占位符已剥除', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses()));
  const pdf = { filename: 'paper.pdf', dataBase64: PDF_B64 };
  await generateDigest({ config: CONFIG.responses, instruction: '结合附件总结 {{@file}}', content: '正文', pdf, fetchImpl: fetch });
  assert.deepEqual(calls[0].body, {
    model: 'gpt-5',
    instructions: '结合附件总结',
    input: [{
      role: 'user',
      content: [
        { type: 'input_file', filename: 'paper.pdf', file_data: PDF_DATA_URL },
        { type: 'input_text', text: '正文' },
      ],
    }],
    store: false,
    max_output_tokens: 2048,
    stream: true,
  });
});

test('{{@file}} + PDF：chat-completions 走 file content part（file.file_data base64 data URL）', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK['chat-completions']()));
  const pdf = { filename: 'paper.pdf', dataBase64: PDF_B64 };
  await generateDigest({ config: CONFIG['chat-completions'], instruction: '结合附件总结 {{@file}}', content: '正文', pdf, fetchImpl: fetch });
  assert.deepEqual(calls[0].body, {
    model: 'gpt-5',
    messages: [
      { role: 'system', content: '结合附件总结' },
      {
        role: 'user',
        content: [
          { type: 'file', file: { filename: 'paper.pdf', file_data: PDF_DATA_URL } },
          { type: 'text', text: '正文' },
        ],
      },
    ],
    max_completion_tokens: 2048,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('{{@file}} + PDF：messages 走 document 块（base64 source，data 不带 data: 前缀）', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.messages()));
  const pdf = { filename: 'paper.pdf', dataBase64: PDF_B64 };
  await generateDigest({ config: CONFIG.messages, instruction: '结合附件总结 {{@file}}', content: '正文', pdf, fetchImpl: fetch });
  assert.deepEqual(calls[0].body, {
    model: 'claude-x',
    max_tokens: 2048,
    system: '结合附件总结',
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } },
        { type: 'text', text: '正文' },
      ],
    }],
    stream: true,
  });
});

test('{{@file}} 无 PDF 附件（降级路径）：占位符照样剥除，请求体与纯文本现状一致', async () => {
  const { calls, fetch } = fakeFetch(async () => sseResponse(SSE_OK.responses('x')));
  await generateDigest({ config: CONFIG.responses, instruction: '结合附件总结 {{@file}}', content: '正文', fetchImpl: fetch });
  assert.deepEqual(calls[0].body, {
    model: 'gpt-5', instructions: '结合附件总结', input: '正文', store: false, max_output_tokens: 2048, stream: true,
  }, '无附件时 input 仍是纯字符串（与现状一致）');

  // 指令只有占位符：剥空回落内置默认
  await generateDigest({ config: CONFIG.responses, instruction: '{{@file}}', content: '正文', fetchImpl: fetch });
  assert.equal(calls[1].body.instructions, DEFAULT_DIGEST_INSTRUCTION);
});
