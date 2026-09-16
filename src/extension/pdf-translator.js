// PDF Translator file contract (#107).
//
// This module is the seam between untrusted community files and the extension. Callers parse a
// file once at import time, then consume normalized metadata and PDF Attachment Candidates. The
// runtime (#108) remains responsible for actually executing compatible code in isolation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUPPORTED_ZOTERO_PATHS = new Set([
  'Zotero.Item',
  'Zotero.HTTP.request',
  'Zotero.debug',
  'Zotero.done',
  'Zotero.wait',
  'Zotero.Utilities.attr',
  'Zotero.Utilities.capitalizeTitle',
  'Zotero.Utilities.cleanAuthor',
  'Zotero.Utilities.doGet',
  'Zotero.Utilities.doPost',
  'Zotero.Utilities.processDocuments',
  'Zotero.Utilities.strToISO',
  'Zotero.Utilities.text',
  'Zotero.Utilities.trimInternal',
  'Zotero.Utilities.xpath',
  'Zotero.Utilities.xpathText',
  'ZU.attr',
  'ZU.capitalizeTitle',
  'ZU.cleanAuthor',
  'ZU.doGet',
  'ZU.doPost',
  'ZU.processDocuments',
  'ZU.strToISO',
  'ZU.text',
  'ZU.trimInternal',
  'ZU.xpath',
  'ZU.xpathText',
]);

const MULTIPLE_SELECTION_PATHS = new Set(['Zotero.selectItems', 'ZU.selectItems']);
const NESTED_TRANSLATOR_PATHS = new Set([
  'Zotero.loadTranslator',
  'Zotero.getTranslatorObject',
]);
const LIBRARY_PATHS = new Set([
  'Zotero.Collection',
  'Zotero.Collections',
  'Zotero.Items',
  'Zotero.Search',
]);

function diagnostic(level, code, message, extra = {}) {
  return { level, code, message, ...extra };
}

function metadataHeader(source) {
  const input = String(source ?? '').replace(/^\uFEFF/, '');
  const start = input.search(/\S/);
  if (start < 0 || input[start] !== '{') return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          header: input.slice(start, index + 1),
          code: input.slice(index + 1).trimStart(),
        };
      }
    }
  }
  return { header: input.slice(start), code: '', unterminated: true };
}

function normalizedOrigins(value, diagnostics) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('error', 'INVALID_REQUEST_ORIGIN', 'requestOrigins 必须是 HTTP(S) origin 数组'));
    return [];
  }
  const origins = [];
  let invalid = false;
  for (const raw of value) {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        invalid = true;
        continue;
      }
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      invalid = true;
    }
  }
  if (invalid) diagnostics.push(diagnostic('error', 'INVALID_REQUEST_ORIGIN', 'requestOrigins 只能包含不带路径、查询或凭据的 HTTP(S) origin'));
  return origins;
}

// Mask comments and literals before inspecting rooted Zotero/ZU member access. This is an import
// compatibility check, not the security mechanism; the isolated runtime still enforces capability
// access when the code executes.
function maskNonCode(source) {
  const input = String(source ?? '').split('');
  const chars = [...input];
  let state = 'code';
  let escaped = false;
  let regexClass = false;
  let previous = '';
  const templateExpressions = [];
  const mask = (index) => { if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '; };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'code'; else mask(index);
      continue;
    }
    if (state === 'block-comment') {
      mask(index);
      if (char === '*' && next === '/') { mask(index + 1); index += 1; state = 'code'; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      mask(index);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if ((state === 'single' && char === "'")
        || (state === 'double' && char === '"')) state = 'code';
      continue;
    }
    if (state === 'template') {
      mask(index);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '`') state = 'code';
      else if (char === '$' && next === '{') {
        mask(index + 1);
        index += 1;
        templateExpressions.push(1);
        state = 'code';
      }
      continue;
    }
    if (state === 'regex') {
      mask(index);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) {
        state = 'code';
        while (/[a-z]/i.test(chars[index + 1] ?? '')) { mask(index + 1); index += 1; }
      }
      continue;
    }
    if (char === '/' && next === '/') { mask(index); mask(index + 1); index += 1; state = 'line-comment'; continue; }
    if (char === '/' && next === '*') { mask(index); mask(index + 1); index += 1; state = 'block-comment'; continue; }
    if (char === "'") { mask(index); state = 'single'; continue; }
    if (char === '"') { mask(index); state = 'double'; continue; }
    if (char === '`') { mask(index); state = 'template'; continue; }
    if (char === '/' && (!previous || /[=(:,!&|?{}[;\n]/.test(previous))) {
      mask(index);
      state = 'regex';
      regexClass = false;
      escaped = false;
      continue;
    }
    if (templateExpressions.length > 0 && char === '{') {
      templateExpressions[templateExpressions.length - 1] += 1;
    } else if (templateExpressions.length > 0 && char === '}') {
      const last = templateExpressions.length - 1;
      templateExpressions[last] -= 1;
      if (templateExpressions[last] === 0) {
        mask(index);
        templateExpressions.pop();
        state = 'template';
        continue;
      }
    }
    if (!/\s/.test(char)) previous = char;
  }
  return chars.join('');
}

function capabilityDiagnostics(code) {
  const masked = maskNonCode(code);
  const diagnostics = [];
  const rooted = /\b(Zotero|ZU)\b/g;
  for (const match of masked.matchAll(rooted)) {
    const rest = masked.slice(match.index + match[0].length);
    const next = rest.match(/^\s*(.)/)?.[1] ?? '';
    if (next !== '.') {
      diagnostics.push(diagnostic(
        'error',
        'UNANALYZABLE_ZOTERO_ACCESS',
        `${match[1]} 必须通过受支持的静态点号成员访问，不能使用别名、解构或计算成员`,
        { path: match[1] },
      ));
    }
  }
  const paths = [];
  const memberAccess = /\b(Zotero|ZU)((?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g;
  for (const match of masked.matchAll(memberAccess)) {
    const path = `${match[1]}${match[2].replace(/\s+/g, '')}`;
    if (!paths.includes(path)) paths.push(path);
  }

  for (const path of paths) {
    if (SUPPORTED_ZOTERO_PATHS.has(path)) continue;
    if (MULTIPLE_SELECTION_PATHS.has(path)) {
      diagnostics.push(diagnostic('error', 'UNSUPPORTED_MULTIPLE_SELECTION', `${path} 所需的多条目选择尚不兼容`, { path }));
    } else if (NESTED_TRANSLATOR_PATHS.has(path)) {
      diagnostics.push(diagnostic('error', 'UNSUPPORTED_NESTED_TRANSLATOR', `${path} 所需的嵌套 Translator 调用尚不兼容`, { path }));
    } else if (LIBRARY_PATHS.has(path)) {
      diagnostics.push(diagnostic('error', 'UNSUPPORTED_LIBRARY_ACCESS', `${path} 所需的 Zotero 文献库能力尚不兼容`, { path }));
    } else {
      diagnostics.push(diagnostic('error', 'UNSUPPORTED_ZOTERO_API', `尚不兼容 ${path}`, { path }));
    }
  }
  return diagnostics;
}

export function parsePdfTranslatorFile(source) {
  const diagnostics = [];
  const parsedHeader = metadataHeader(source);
  if (!parsedHeader) {
    return {
      ok: false,
      compatibility: 'incompatible',
      diagnostics: [diagnostic('error', 'METADATA_HEADER_REQUIRED', '文件必须以 Zotero Translator JSON 元数据头开始')],
      translator: null,
    };
  }
  if (parsedHeader.unterminated) {
    return {
      ok: false,
      compatibility: 'incompatible',
      diagnostics: [diagnostic('error', 'INVALID_METADATA_JSON', 'Translator 元数据头没有结束')],
      translator: null,
    };
  }

  let raw;
  try {
    raw = JSON.parse(parsedHeader.header);
  } catch (error) {
    return {
      ok: false,
      compatibility: 'incompatible',
      diagnostics: [diagnostic('error', 'INVALID_METADATA_JSON', `Translator 元数据不是有效 JSON：${error.message}`)],
      translator: null,
    };
  }

  if (typeof raw.translatorID !== 'string' || !UUID.test(raw.translatorID)) {
    diagnostics.push(diagnostic('error', 'INVALID_TRANSLATOR_ID', 'translatorID 必须是稳定 UUID'));
  }
  if (typeof raw.label !== 'string' || !raw.label.trim()) {
    diagnostics.push(diagnostic('error', 'LABEL_REQUIRED', 'label 不能为空'));
  }
  if (typeof raw.creator !== 'string' || !raw.creator.trim()) {
    diagnostics.push(diagnostic('error', 'CREATOR_REQUIRED', 'creator 不能为空'));
  }
  if (typeof raw.target !== 'string') {
    diagnostics.push(diagnostic('error', 'INVALID_TARGET', 'target 必须是正则表达式字符串'));
  } else {
    try { new RegExp(raw.target); } catch { diagnostics.push(diagnostic('error', 'INVALID_TARGET', 'target 不是有效正则表达式')); }
  }
  if (!Number.isInteger(raw.priority) || raw.priority < 0) {
    diagnostics.push(diagnostic('error', 'INVALID_PRIORITY', 'priority 必须是非负整数'));
  }
  if (raw.translatorType !== 4) {
    diagnostics.push(diagnostic('error', 'WEB_TRANSLATOR_REQUIRED', '只支持 translatorType: 4 的 Zotero Web Translator'));
  }
  const explicitVersion = raw.version;
  const zoteroVersion = raw.lastUpdated;
  if (explicitVersion === undefined && zoteroVersion === undefined) {
    diagnostics.push(diagnostic('error', 'VERSION_REQUIRED', '必须提供非空 version，或保留 Zotero lastUpdated'));
  } else if ((explicitVersion !== undefined && (typeof explicitVersion !== 'string' || !explicitVersion.trim() || explicitVersion.length > 128))
    || (explicitVersion === undefined && (typeof zoteroVersion !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(zoteroVersion)))) {
    diagnostics.push(diagnostic('error', 'INVALID_VERSION', 'version 必须是非空字符串；Zotero lastUpdated 必须使用 YYYY-MM-DD HH:mm:ss'));
  }
  const requestOrigins = normalizedOrigins(raw.requestOrigins, diagnostics);

  const maskedCode = maskNonCode(parsedHeader.code);
  if (!/\b(?:async\s+)?function\s+detectWeb\s*\(/.test(maskedCode)) {
    diagnostics.push(diagnostic('error', 'DETECT_WEB_REQUIRED', '必须声明 detectWeb(document, url)'));
  }
  if (!/\b(?:async\s+)?function\s+doWeb\s*\(/.test(maskedCode)) {
    diagnostics.push(diagnostic('error', 'DO_WEB_REQUIRED', '必须声明 doWeb(document, url)'));
  }

  const structuralErrors = diagnostics.length > 0;
  const capabilities = capabilityDiagnostics(parsedHeader.code);
  diagnostics.push(...capabilities);
  const metadata = {
    translatorID: typeof raw.translatorID === 'string' ? raw.translatorID : '',
    label: typeof raw.label === 'string' ? raw.label.trim() : '',
    creator: typeof raw.creator === 'string' ? raw.creator.trim() : '',
    target: typeof raw.target === 'string' ? raw.target : '',
    priority: raw.priority,
    version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : (typeof raw.lastUpdated === 'string' ? raw.lastUpdated : ''),
    requestOrigins,
    translatorType: raw.translatorType,
  };

  return {
    ok: !structuralErrors,
    compatibility: diagnostics.some((entry) => entry.level === 'error') ? 'incompatible' : 'compatible',
    diagnostics,
    translator: { metadata, code: parsedHeader.code, source: String(source ?? '') },
  };
}

function translatorId(entry) {
  return entry?.translator?.metadata?.translatorID ?? null;
}

function translatorPriority(entry) {
  return entry?.translator?.metadata?.priority ?? Number.MAX_SAFE_INTEGER;
}

// Resolve the effective file set from immutable built-ins and user imports. Recomputing this view
// after a user file is removed naturally reveals the built-in version again.
export function resolvePdfTranslatorVersions({ builtIn = [], imported = [] } = {}) {
  const selectedById = new Map();
  const shadowed = [];
  const rejected = [];
  for (const entry of Array.isArray(builtIn) ? builtIn : []) {
    const id = translatorId(entry);
    if (!id) continue;
    if (selectedById.has(id)) shadowed.push(entry);
    else selectedById.set(id, entry);
  }
  for (const entry of Array.isArray(imported) ? imported : []) {
    const id = translatorId(entry);
    if (!id) continue;
    // An import that cannot pass the static compatibility check is visible to settings, but must
    // not silently disable a working built-in adapter. A compatible, explicitly disabled import
    // does override the built-in version so the user's disable choice remains effective.
    if (entry.ok !== true || entry.compatibility !== 'compatible') {
      rejected.push(entry);
      continue;
    }
    const previous = selectedById.get(id);
    if (previous) shadowed.push(previous);
    selectedById.set(id, entry);
  }

  const selected = [...selectedById.values()];
  const active = selected
    .filter((entry) => entry.enabled !== false && entry.ok === true && entry.compatibility === 'compatible')
    .sort((left, right) => translatorPriority(left) - translatorPriority(right)
      || left.translator.metadata.label.localeCompare(right.translator.metadata.label)
      || translatorId(left).localeCompare(translatorId(right)));
  return { active, selected, shadowed, rejected };
}

function attachmentName(attachment, url, order) {
  const supplied = [attachment?.name, attachment?.title].find((value) => typeof value === 'string' && value.trim());
  if (supplied) return supplied.trim();
  const segment = url.pathname.split('/').filter(Boolean).pop();
  if (segment) {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }
  return `attachment-${order + 1}.pdf`;
}

function isPdfAttachment(attachment, url) {
  const mime = String(attachment?.mimeType || attachment?.contentType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'application/pdf') return true;
  if (/\.pdf$/i.test(url.pathname)) return true;
  return [attachment?.name, attachment?.title].some((value) => typeof value === 'string' && /\.pdf$/i.test(value.trim()));
}

export function normalizePdfAttachments(attachments, { baseUrl } = {}) {
  const diagnostics = [];
  const candidates = [];
  const seen = new Set();

  for (const [order, attachment] of (Array.isArray(attachments) ? attachments : []).entries()) {
    let url;
    try {
      url = baseUrl ? new URL(attachment?.url, baseUrl) : new URL(attachment?.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
      url.hash = '';
    } catch {
      diagnostics.push(diagnostic('warning', 'INVALID_ATTACHMENT_URL', `第 ${order + 1} 个附件没有可用的 HTTP(S) 地址`, { order }));
      continue;
    }
    if (!isPdfAttachment(attachment, url)) {
      diagnostics.push(diagnostic('warning', 'NON_PDF_ATTACHMENT', `第 ${order + 1} 个附件不是 PDF`, { order, url: url.href }));
      continue;
    }
    if (seen.has(url.href)) {
      diagnostics.push(diagnostic('warning', 'DUPLICATE_ATTACHMENT', `第 ${order + 1} 个附件与前一 PDF 地址重复`, { order, url: url.href }));
      continue;
    }
    seen.add(url.href);
    candidates.push({
      url: url.href,
      name: attachmentName(attachment, url, order),
      order,
      primary: attachment?.primary === true,
    });
  }

  const primaryIndexes = candidates.flatMap((candidate, index) => (candidate.primary ? [index] : []));
  if (primaryIndexes.length === 0 && candidates.length > 0) candidates[0].primary = true;
  if (primaryIndexes.length > 1) {
    for (const index of primaryIndexes.slice(1)) candidates[index].primary = false;
    diagnostics.push(diagnostic('warning', 'MULTIPLE_PRIMARY_ATTACHMENTS', 'Translator 标记了多个主 PDF，已使用第一个'));
  }
  return { candidates, diagnostics };
}
