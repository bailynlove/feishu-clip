// {{}} 模板引擎：纯函数、不依赖 chrome API，node:test 可直接测。
// 语法决议见 #30：变量 title/url/host/date/time/datetime/content，
// filter 仅 {{date|date:FORMAT}}（token YYYY MM DD HH mm ss），未知变量/非法 filter 置空。

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const CONTENT_PLACEHOLDER = /\{\{\s*content\s*\}\}/;
const DATE_FILTER = /^date:(.+)$/;
const DATE_VARIABLES = ['date', 'time', 'datetime'];
const DATE_TOKEN = /YYYY|MM|DD|HH|mm|ss/g;
const FILENAME_UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

function pad(value) {
  return String(value).padStart(2, '0');
}

function localParts(date) {
  return {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
}

function formatDate(date, format) {
  const parts = localParts(date);
  return format.replace(DATE_TOKEN, (token) => parts[token]);
}

// snapshot 是 extractor 的产出 {title, sourceUrl, capturedAt, markdown, images}
export function buildContext(snapshot) {
  const url = typeof snapshot.sourceUrl === 'string' ? snapshot.sourceUrl : '';
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  const captured = new Date(snapshot.capturedAt);
  const valid = !Number.isNaN(captured.getTime());
  const context = {
    title: typeof snapshot.title === 'string' ? snapshot.title : '',
    url,
    host,
    date: valid ? formatDate(captured, 'YYYY-MM-DD') : '',
    time: valid ? formatDate(captured, 'HH:mm') : '',
    datetime: valid ? formatDate(captured, 'YYYY-MM-DD HH:mm') : '',
    content: typeof snapshot.markdown === 'string' ? snapshot.markdown : '',
  };
  // filter 重排 date/time/datetime 需要原始时间；不可枚举，不影响渲染与断言
  Object.defineProperty(context, '_date', { value: valid ? captured : null, enumerable: false });
  return context;
}

export function renderTemplate(template, ctx) {
  if (typeof template !== 'string') return '';
  return template.replace(PLACEHOLDER, (_match, inner) => {
    const segments = inner.split('|');
    if (segments.length > 2) return '';
    const name = segments[0].trim();
    const filter = segments[1]?.trim();
    if (filter === undefined) {
      const value = ctx[name];
      return typeof value === 'string' ? value : '';
    }
    const match = DATE_FILTER.exec(filter);
    if (!match || !DATE_VARIABLES.includes(name)) return '';
    const date = ctx._date;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return formatDate(date, match[1].trim());
  });
}

export function renderBody(bodyTemplate, ctx) {
  const content = typeof ctx.content === 'string' ? ctx.content : '';
  if (typeof bodyTemplate !== 'string' || bodyTemplate.trim() === '') return content;
  if (CONTENT_PLACEHOLDER.test(bodyTemplate)) return renderTemplate(bodyTemplate, ctx);
  return `${content}\n\n${renderTemplate(bodyTemplate, ctx)}`;
}

export function renderTitle(titleTemplate, ctx) {
  const rendered = renderTemplate(titleTemplate, ctx);
  const base = rendered.trim() === '' ? (typeof ctx.title === 'string' ? ctx.title : '') : rendered;
  return sanitizeFilename(base);
}

export function sanitizeFilename(name) {
  return String(name ?? '')
    .replace(FILENAME_UNSAFE, '-')
    .trim()
    .replace(/\.+$/, '');
}

// CLIP 携带的手改标题（#36）：非法字符清洗；清洗后为空（空白/纯非法字符/非字符串）
// 返回 null，调用方回退 extractor 标题，绝不把空标题发给 Bridge
export function sanitizeClipTitle(title) {
  if (typeof title !== 'string') return null;
  const cleaned = sanitizeFilename(title);
  return cleaned === '' ? null : cleaned;
}
