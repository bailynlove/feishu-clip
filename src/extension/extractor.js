(async () => {
  try {
    const images = [];
    const iframes = [];
    let browserBytes = 0;

    function candidate(image) {
      const lazy = image.dataset.src || image.dataset.original || image.dataset.lazySrc;
      const set = image.currentSrc || image.srcset?.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).at(-1);
      const raw = lazy || set || image.src;
      try { return new URL(raw, location.href).href; } catch { return null; }
    }

    async function readableBytes(url) {
      if (!url) return null;
      const parsed = new URL(url);
      const readable = parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.origin === location.origin;
      if (!readable) return null;
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) throw new Error('不支持的图片类型');
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 8 * 1024 * 1024 || browserBytes + buffer.byteLength > 40 * 1024 * 1024) throw new Error('图片超过体积限制');
      browserBytes += buffer.byteLength;
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { mimeType, bytesBase64: btoa(binary) };
    }

    const inline = new Set(['A', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'CODE', 'SMALL', 'MARK', 'DEL', 'S', 'SUP', 'SUB']);
    function text(node) { return (node.textContent || '').replace(/\s+/g, ' ').trim(); }

    // 悬浮内容（悬停才展示的隐藏面板，如代码行内的灯泡注解）：
    // 原页面 display:none 子树没有布局盒，用户悬停时才可见。直接在正文里渲染会无标注地混进来，
    // 丢弃又可惜。约定：触发位置留 `悬浮内容{i}` 标记，内容作为注释段落排到所在块之后。
    const HOVER_ATTR = 'data-feishu-clip-hover';
    const HOVER_LIMIT = 20;
    const JUNK_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'ASIDE', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'IFRAME']);
    // 布局盒只在原页面有意义（克隆树未挂载），所以打标在原树上做、随克隆带入；
    // 返回打标过的原元素列表，调用方负责用后 removeAttribute 还原页面
    function tagHoverPanels(sourceRoot) {
      const tagged = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          // MathML 子树（KaTeX 公式的无障碍副本）不下钻：里面的 annotation 存 TeX 源码，
          // 浏览器 UA 样式对它 display:none，会被误判成悬浮面板（labuladong 公式 bug）
          if (child.nodeType !== Node.ELEMENT_NODE || JUNK_TAGS.has(child.tagName) || child.tagName === 'MATH') continue;
          if (typeof child.getClientRects === 'function' && child.getClientRects().length === 0) {
            const content = text(child);
            // 含 iframe 的隐藏容器不打标：iframe 有自己的占位符管线，打标会把占位符随面板一起吞掉；
            // 容器文本按老行为内联渲染，不丢内容
            const hasIframe = child.querySelectorAll('iframe').length > 0;
            // 纯图片面板（labuladong 的 .code-extend-content 只有一张示意图）也算悬浮内容；
            // 文本过短又无图的隐藏容器（装饰点、占位）不算
            const hasImage = child.querySelectorAll('img').length > 0;
            if (!hasIframe && (content.length >= 2 || hasImage) && tagged.length < HOVER_LIMIT) {
              child.setAttribute(HOVER_ATTR, String(tagged.length + 1));
              tagged.push({ original: child, content });
            }
            continue;
          }
          walk(child);
        }
      };
      walk(sourceRoot);
      return tagged;
    }

    // markmap 源收集（#54）：labuladong 的思维导图是 markmap 组件，源 markdown 内嵌在
    // Next.js RSC 流式 payload（内联 script）里，形如 {"content":"---\nmarkmap:\n...\n# 标题\n..."}
    // （JSON 转义形态，可能再被外层字符串套一层转义，逐层反转义直到匹配或没有转义可解）
    function markmapSources() {
      const sources = [];
      if (typeof document.querySelectorAll !== 'function') return sources;
      // 逐层反转义：\uXXXX 是 Next.js 的 XSS 安全编码（< → < 等），单独解码；
      // 其余按 JSON/JS 字符串转义处理（\" → "、\\n 先解成 \n 留给 JSON.parse、未知转义丢反斜杠）
      const unescapeOnce = (value) => value.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (match, char) => {
        if (char[0] === 'u' && char.length === 5) return String.fromCharCode(parseInt(char.slice(1), 16));
        return ({ n: '\n', t: '\t', r: '\r' })[char] ?? char;
      });
      for (const script of document.querySelectorAll('script')) {
        let payload = script.textContent || '';
        for (let round = 0; round < 3; round += 1) {
          let found = 0;
          for (const match of payload.matchAll(/"content"\s*:\s*"((?:\\[\s\S]|[^"\\])*)"/g)) {
            let content = match[1];
            try { content = JSON.parse(`"${content}"`); } catch { /* 已部分反转义的形态，原样使用 */ }
            if (/^---\s*\n\s*markmap:/.test(content)) { sources.push(content); found += 1; }
          }
          if (found > 0 || !payload.includes('\\')) break;
          payload = unescapeOnce(payload);
        }
      }
      return sources;
    }

    // markmap 源 = frontmatter + 标准 markdown 标题树/列表。转写规则：#~###### 标题层级与
    // -/* 列表统一映射为嵌套无序列表（标题每深一级多一层缩进，标题下的列表项再深一层），
    // frontmatter 丢弃；正文行按当前标题层级挂为列表项，避免整段丢失
    function markmapOutline(source) {
      const lines = source.split('\n');
      let start = 0;
      if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
        if (end > 0) start = end + 1;
      }
      const items = [];
      let headingDepth = 0; // 最近一个标题的层级，决定后续列表项/正文行的缩进
      for (const line of lines.slice(start)) {
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          headingDepth = heading[1].length;
          if (heading[2].trim()) items.push({ depth: headingDepth - 1, text: heading[2].trim() });
          continue;
        }
        const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
        if (bullet) {
          if (bullet[2].trim()) items.push({ depth: headingDepth + Math.floor(bullet[1].length / 2), text: bullet[2].trim() });
          continue;
        }
        const plain = line.trim();
        if (plain) items.push({ depth: headingDepth, text: plain });
      }
      return items;
    }

    // 把 {depth, text} 序列建成嵌套 UL/LI，交给 render 的既有列表分支输出缩进；
    // 层级跳变（如 # 直接跳到 ###）压平到当前的下一级，防止出现空的中间层
    function buildOutlineList(items) {
      if (!items.length) return null;
      const rootList = document.createElement('ul');
      const levels = [{ list: rootList, lastLi: null, parentLi: null }]; // levels[d] 服务深度 d
      let maxDepth = 0;
      for (const item of items) {
        const depth = Math.max(0, Math.min(item.depth, maxDepth + 1));
        if (depth > 0) {
          const parent = levels[depth - 1];
          // 子列表属于父层级当前的最后一个 li；父 li 变了（回到浅层又下来）就新建子列表
          if (!levels[depth] || levels[depth].parentLi !== parent.lastLi) {
            const sub = document.createElement('ul');
            (parent.lastLi || parent.list).append(sub);
            levels[depth] = { list: sub, lastLi: null, parentLi: parent.lastLi || null };
          }
        }
        levels.length = depth + 1; // 回到浅层时截断更深层级
        const li = document.createElement('li');
        li.append(document.createTextNode(item.text));
        levels[depth].list.append(li);
        levels[depth].lastLi = li;
        maxDepth = Math.max(maxDepth, depth);
      }
      return rootList;
    }

    // 高亮块（#55）的 XML 岛工具函数：callout 内是 XML 不是 markdown——文本按 XML 规则转义
    // （标签本身不转义），常见行内 markdown 转对应 XML 标签（lark-cli markdown 导入会解析）
    function xmlEscape(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function inlineXml(value) {
      return xmlEscape(value)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    }
    // callout 子块只支持文本/标题/列表/待办/引用且禁止裸文本：把 render 出的 markdown
    // 按空行分块，逐块转成 XML 块（段落 <p>、标题 <hN>、列表 <ul>/<ol>、引用 <blockquote>）
    function calloutBlocks(markdown) {
      return markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => {
        const lines = block.split('\n');
        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
          return `<ul>${lines.map((line) => `<li>${inlineXml(line.replace(/^\s*[-*]\s+/, '').trim())}</li>`).join('')}</ul>`;
        }
        if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
          return `<ol>${lines.map((line) => `<li>${inlineXml(line.replace(/^\s*\d+\.\s+/, '').trim())}</li>`).join('')}</ol>`;
        }
        if (lines.every((line) => /^>\s?/.test(line))) {
          return `<blockquote>${lines.map((line) => `<p>${inlineXml(line.replace(/^>\s?/, '').trim())}</p>`).join('')}</blockquote>`;
        }
        if (lines.length === 1) {
          const heading = block.match(/^(#{1,6})\s+(.*)$/);
          if (heading) return `<h${heading[1].length}>${inlineXml(heading[2].trim())}</h${heading[1].length}>`;
        }
        return `<p>${lines.map((line) => inlineXml(line.trim())).join('<br/>')}</p>`;
      });
    }

    function render(node, depth = 0) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName;
      const children = () => [...node.childNodes].map((child) => render(child, depth)).join('');
      // 伪按钮（div[role=button]，Medium 图片的点击放大容器）里的文字是控件提示
      // （"Press enter or click to view image in full size"），不是正文；但按钮可能
      // 包着正文图片（已被替换成锚点文本），只保留含锚点的子树。须在 P/DIV 等通用
      // 分支之前判定，否则 div 会被提前接管
      if (node.getAttribute('role') === 'button') {
        return [...node.childNodes].map((child) => {
          const rendered = render(child, depth);
          return rendered.includes('[[FEISHU_CLIP_') ? rendered : '';
        }).join('');
      }
      // 高亮块（#55）：labuladong 等站点的提示框（前置知识/一句话总结/注意事项）是 Tailwind
      // 容器 div.bg-{color}-50（首子元素为图标 svg + 标题行），按普通 div 平铺会丢掉视觉分组。
      // 转写为 <callout> XML 岛，颜色映射 light-{color}/{color}，emoji 按色名固定映射。
      // 容器内含 callout 不支持的子块（图片/iframe 占位符、pre、表格、嵌套高亮块）时回退平铺渲染
      if (tag === 'DIV') {
        const colorMatch = (node.getAttribute('class') || '').match(/(?:^|\s)bg-([a-z]+)-50(?:\s|$)/);
        if (colorMatch) {
          const color = colorMatch[1];
          const nested = [...node.querySelectorAll('div')].some((div) => /(?:^|\s)bg-[a-z]+-50(?:\s|$)/.test(div.getAttribute('class') || ''));
          const unsupported = nested
            || node.querySelectorAll('pre').length > 0
            || node.querySelectorAll('table').length > 0
            || (node.textContent || '').includes('[[FEISHU_CLIP_'); // 图片锚点/iframe 占位符
          if (!unsupported) {
            // 首子元素是图标 svg + 标题行（svg 已被垃圾清理带走），保留为 callout 内首个加粗段落
            let titleRowSeen = false;
            let title = '';
            const rest = [];
            for (const child of node.childNodes) {
              if (!titleRowSeen && child.nodeType === Node.ELEMENT_NODE) { titleRowSeen = true; title = text(child); continue; }
              rest.push(render(child, depth));
            }
            const blocks = calloutBlocks(rest.join(''));
            if (title) blocks.unshift(`<p><b>${inlineXml(title)}</b></p>`);
            if (blocks.length > 0) {
              const emoji = { blue: '📘', purple: '📌', yellow: '⚠️', red: '❗', green: '✅' }[color] || '💡';
              return `\n\n<callout emoji="${emoji}" background-color="light-${color}" border-color="${color}">${blocks.join('')}</callout>\n\n`;
            }
          }
        }
      }
      if (/^H[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text(node)}\n\n`;
      if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') return `\n\n${children()}\n\n`;
      if (tag === 'BR') return '  \n';
      if (tag === 'STRONG' || tag === 'B') return `**${children()}**`;
      if (tag === 'EM' || tag === 'I') return `*${children()}*`;
      if (tag === 'DEL' || tag === 'S') return `~~${children()}~~`;
      if (tag === 'CODE' && node.parentElement?.tagName !== 'PRE') return `\`${text(node).replaceAll('`', '\\`')}\``;
      if (tag === 'PRE') return `\n\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
      if (tag === 'BLOCKQUOTE') return `\n\n${text(node).split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
      if (tag === 'A') {
        // 空文字链接（图标按钮类：SVG/图标被清理后什么都没剩，如 Medium 页头的点赞/收藏
        // 动作链接）是控件不是内容：跳过，不回退输出裸 URL
        const label = children().trim();
        if (!label) return '';
        let href; try { href = new URL(node.getAttribute('href'), location.href).href; } catch { href = null; }
        return href && /^https?:/.test(href) ? `[${label.replace(/[\[\]]/g, '\\$&')}](${href})` : label;
      }
      if (tag === 'UL' || tag === 'OL') return `\n${[...node.children].map((child, index) => `${'  '.repeat(depth)}${tag === 'OL' ? `${index + 1}.` : '-'} ${render(child, depth + 1).trim()}`).join('\n')}\n`;
      if (tag === 'LI') return children();
      if (tag === 'TABLE') {
        const rows = [...node.querySelectorAll('tr')].map((row) => [...row.querySelectorAll(':scope > th, :scope > td')].map((cell) => text(cell).replaceAll('|', '\\|')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map((row) => row.length));
        const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
        return `\n\n| ${normalized[0].join(' | ')} |\n| ${Array(width).fill('---').join(' | ')} |\n${normalized.slice(1).map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
      }
      if (inline.has(tag)) return children();
      return children();
    }

    // 单根提取：清理 + 图片管线 + 悬浮内容管线 + 渲染。images/browserBytes 跨根共享（占位符索引连续、流量预算合并）
    async function extractFrom(sourceRoot) {
      const tagged = tagHoverPanels(sourceRoot); // 打标须在克隆前，标记随克隆带入
      const root = sourceRoot.cloneNode(true);
      for (const { original } of tagged) original.removeAttribute(HOVER_ATTR); // 还原原页面，标记只留在克隆树

      // iframe 管线（#47）：正文里的 iframe（如折叠 details 里的算法可视化面板）是有价值的内容，
      // 不能随垃圾清理丢掉。数据只取 src/title/尺寸（都在原树上），克隆树里原位留占位符，
      // 由 bridge 转写成飞书 iframe 块（block_type 26）。须在清理之前做——清理会删掉 iframe。
      // 跟踪像素（≤2px）跳过；不用「无布局盒」过滤，折叠 details 里的 iframe 没有布局盒但内容有价值
      const originalIframes = [...sourceRoot.querySelectorAll('iframe')];
      const clonedIframes = [...root.querySelectorAll('iframe')];
      for (const [cloneIndex, clone] of clonedIframes.entries()) {
        const original = originalIframes[cloneIndex] || clone;
        const raw = (original.getAttribute('src') || '').trim();
        let url = null;
        try {
          const parsed = new URL(raw, location.href); // 注意空串会 resolve 成页面自身 URL，所以先判空
          if (raw && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) url = parsed.href;
        } catch { url = null; }
        const rect = typeof original.getBoundingClientRect === 'function' ? original.getBoundingClientRect() : null;
        // 只过滤「确实渲染成 1-2px 小点」的跟踪 iframe；0x0 多半是折叠 details 里的内容面板
        // （未渲染所以 rect 全零），正是要保留的，不能误杀
        const tiny = rect && rect.width >= 1 && rect.width <= 2 && rect.height >= 1 && rect.height <= 2;
        if (!url || tiny || iframes.length >= 10) { clone.remove(); continue; }
        iframes.push({ url, title: (original.getAttribute('title') || '').trim() || `iframe ${iframes.length + 1}` });
        // 占位符用 P 元素而非文本节点：render 会把文本节点的 \n\n 压成空格，iframe 与 summary
        // 等文本混排（如 details 直挂）时占位符会糊进别的段落，bridge 就定位不到独立锚点块
        const placeholder = document.createElement('p');
        placeholder.append(document.createTextNode(`[[FEISHU_CLIP_IFRAME:${iframes.length - 1}]]`));
        clone.replaceWith(placeholder);
      }

      // canvas 组图管线（#52）：labuladong 的算法图形（加权图、生成树演示）是每容器
      // 多层叠放的 2d canvas、懒渲染（滚入视口才绘制），既不是 <img> 也没有独立 URL，
      // 不处理就整块丢失。按父容器分组，逐组滚入视口等两帧触发绘制，按 DOM 序合成
      // 一张 PNG，以 bytesBase64 接入图片管线（走「下载上传」级，落成真正的飞书图片块）。
      // 与 iframe 同理须在清理前做。原树/克隆树的 canvas 列表按 querySelectorAll 顺序对齐
      const originalCanvases = [...sourceRoot.querySelectorAll('canvas')];
      const clonedCanvases = [...root.querySelectorAll('canvas')];
      const canvasGroups = []; // 按父容器分组，组内保文档序
      const groupByHolder = new Map();
      for (const [canvasIndex, canvas] of originalCanvases.entries()) {
        const holder = canvas.parentElement || canvas;
        if (!groupByHolder.has(holder)) { groupByHolder.set(holder, []); canvasGroups.push(groupByHolder.get(holder)); }
        groupByHolder.get(holder).push(canvasIndex);
      }
      const waitForPaint = () => new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(resolve));
        else setTimeout(resolve, 50);
      });
      const scrollPos = typeof window !== 'undefined' && Number.isFinite(window.scrollX) ? { x: window.scrollX, y: window.scrollY } : null;
      for (const group of canvasGroups.slice(0, 10)) {
        if (images.length >= 30) break; // 与 <img> 共用候选上限
        const layers = group.map((canvasIndex) => originalCanvases[canvasIndex]);
        const width = Math.max(...layers.map((layer) => layer.width || 0));
        const height = Math.max(...layers.map((layer) => layer.height || 0));
        if (!width || !height) continue;
        try {
          const holder = layers[0].parentElement || layers[0];
          if (typeof holder.scrollIntoView === 'function') { holder.scrollIntoView({ block: 'center' }); await waitForPaint(); }
          // 先查源图层有没有绘制（全透明 = 懒渲染未触发/空层组），再合成——
          // 白底打底会把 alpha 全填成 255，合成后就查不出来了
          let painted = false;
          for (const layer of layers) {
            const layerCtx = typeof layer.getContext === 'function' ? layer.getContext('2d') : null;
            if (!layerCtx) continue;
            const data = layerCtx.getImageData(0, 0, layer.width, layer.height).data;
            for (let p = 3; p < data.length; p += 4) if (data[p] !== 0) { painted = true; break; }
            if (painted) break;
          }
          if (!painted) continue;
          const comp = document.createElement('canvas');
          comp.width = width;
          comp.height = height;
          const ctx = comp.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          for (const layer of layers) ctx.drawImage(layer, 0, 0);
          const bytesBase64 = comp.toDataURL('image/png').split(',')[1];
          if (!bytesBase64) continue;
          const byteLength = Math.floor(bytesBase64.length * 3 / 4);
          if (browserBytes + byteLength > 40 * 1024 * 1024) continue; // 与 readableBytes 同一流量预算
          browserBytes += byteLength;
          const index = images.length;
          images.push({ source: null, mimeType: 'image/png', bytesBase64, width, height });
          // 克隆树里组内首个 canvas 原位替换为锚点（与 iframe 同理用 P 元素保持独立段落），
          // 其余层移除；组图落在 nav/aside 等垃圾子树时锚点随后被清理带走，候选成孤儿——
          // bridge 定位不到锚点会降级为一次失败的 media-insert + 警告，不破坏文档
          const firstClone = clonedCanvases[group[0]];
          if (firstClone) {
            const placeholder = document.createElement('p');
            placeholder.append(document.createTextNode(`[[FEISHU_CLIP_IMAGE:${index}]]`));
            firstClone.replaceWith(placeholder);
            for (const canvasIndex of group.slice(1)) clonedCanvases[canvasIndex]?.remove();
          }
        } catch { /* 单组失败（如画布被跨域污染）不拖垮整页提取 */ }
      }
      if (scrollPos && typeof window.scrollTo === 'function') window.scrollTo(scrollPos.x, scrollPos.y);

      // markmap 大纲转写（#54）：导图渲染产物是内联 svg.markmap-svg，垃圾清理会把它整块清掉，
      // 须在清理前把导图原位替换为源 markdown 转写出的嵌套列表。源（RSC payload 内联 script）
      // 与导图按各自的出现顺序配对（spike 确认两者顺序一致）；数量不符说明配对不可靠，全部跳过，
      // 留下的 svg 随垃圾清理移除——不产生空列表或残留。普通 svg（图标等）不受影响
      const markmapSvgs = [...root.querySelectorAll('svg')].filter((svg) => (svg.getAttribute('class') || '').includes('markmap-svg'));
      if (markmapSvgs.length > 0) {
        const sources = markmapSources();
        if (sources.length === markmapSvgs.length) {
          for (const [svgIndex, svg] of markmapSvgs.entries()) {
            const outline = buildOutlineList(markmapOutline(sources[svgIndex]));
            if (outline) svg.replaceWith(outline); // 空大纲的导图不动，随后按垃圾清掉
          }
        }
      }

      // math 也清掉：KaTeX/MathJax 的 MathML 是公式的无障碍副本，正文另有可见渲染（katex-html 等），
      // 保留会让每个公式重复三遍（mrow 文本 + annotation 里的 TeX 源码 + 可见副本）；公式只留可见副本
      root.querySelectorAll('script,style,noscript,template,nav,aside,form,button,input,select,textarea,svg,canvas,iframe,math').forEach((node) => node.remove());

      const originalImages = [...sourceRoot.querySelectorAll('img')].slice(0, 30);
      const clonedImages = [...root.querySelectorAll('img')];
      const preTails = new Map(); // pre 元素 → 当前锚点插入点，保证同一 pre 多图锚点按原顺序排列
      for (const [cloneIndex, clone] of clonedImages.entries()) {
        if (cloneIndex >= 30) { clone.remove(); continue; }
        const original = originalImages[cloneIndex] || clone;
        // 原页面未渲染的图片（display:none 子树内）没有布局盒。若在打标的悬浮面板内
        // （悬停可见，如代码行内灯泡提示图），作为该面板的内容保留并按面板编号标注；
        // 否则用户看不见，剪藏也不应出现，跳过并从克隆树移除，避免产生孤立锚点
        let hoverSeq = null;
        let hoverHolder = null; // 克隆树里的面板元素，锚点兜底用
        if (typeof original.getClientRects === 'function' && original.getClientRects().length === 0) {
          let holder = clone.parentElement;
          while (holder && holder !== root) {
            const seq = holder.getAttribute(HOVER_ATTR);
            if (seq !== null) { hoverSeq = seq; hoverHolder = holder; break; }
            holder = holder.parentElement;
          }
          if (hoverSeq === null) { clone.remove(); continue; }
        }
        const index = images.length;
        const source = candidate(original);
        const image = { label: hoverSeq ? `悬浮内容${hoverSeq}` : original.alt?.trim() || `图片 ${index + 1}`, source };
        // 飞书建图片块需要原始宽高（空块默认 100x100 且绑定 token 不重算），
        // 从 naturalWidth/Height 拿解码后的真实像素；未加载完成时为 0，只带正整数
        const { naturalWidth, naturalHeight } = original;
        if (Number.isInteger(naturalWidth) && naturalWidth > 0 && Number.isInteger(naturalHeight) && naturalHeight > 0) {
          image.width = naturalWidth;
          image.height = naturalHeight;
        }
        try { Object.assign(image, await readableBytes(source)); } catch (error) { image.browserWarning = error.message; }
        images.push(image);
        const anchor = document.createTextNode(`\n\n[[FEISHU_CLIP_IMAGE:${index}]]\n\n`);
        // 悬浮面板的图（尤其纯图面板，没有文字注释）移到块后就是一张无归属的图，
        // 文档里看不出是哪条悬浮内容。锚点前插编号标签段——必须是独立段落（P），
        // 不能与锚点同段，否则 bridge 的 locateAnchors 匹配不到独立锚点块
        let hoverLabel = null;
        if (hoverSeq) {
          hoverLabel = document.createElement('p');
          hoverLabel.append(document.createTextNode(`悬浮内容${hoverSeq}：`));
        }
        // pre 内的 img 原地替换会让锚点成为围栏代码块里的一行文本，导入飞书后落在
        // code 块（block_type 14）里——bridge 既定位不到也删不掉。改为移出最外层 pre
        // （嵌套 pre 时 closest 只拿到内层），让锚点渲染成代码块之后的独立段落
        let pre = clone.closest('pre');
        if (pre) {
          while (pre.parentElement?.closest('pre')) pre = pre.parentElement.closest('pre');
          clone.remove();
          const tail = preTails.get(pre) || pre;
          if (hoverLabel) { tail.after(hoverLabel); hoverLabel.after(anchor); } else { tail.after(anchor); }
          preTails.set(pre, anchor);
        } else if (hoverSeq) {
          // 悬浮面板内的图（不在 pre 里）：面板稍后会被替换为标记，原地锚点会随面板丢失，
          // 移到所在块（段落/列表项等）之后；找不到块级祖先时跟在面板元素后（面板替换不影响兄弟节点）
          let block = clone.parentElement;
          while (block && block !== root && !/^(P|LI|BLOCKQUOTE|TABLE|H[1-6])$/.test(block.tagName)) block = block.parentElement;
          const target = block && block !== root ? block : hoverHolder || clone.parentElement;
          clone.remove();
          const tail = preTails.get(target) || target;
          if (hoverLabel) { tail.after(hoverLabel); hoverLabel.after(anchor); } else { tail.after(anchor); }
          preTails.set(target, anchor);
        } else {
          clone.replaceWith(anchor);
        }
      }

      // 悬浮内容管线：打标元素原位替换为 `悬浮内容{i}` 标记，内容作为注释段落插到
      // 所在块（pre/p/li/blockquote/table/标题）之后；同一块多条注释按序追加（同 pre 锚点的 tail 手法）。
      // 落在被清理掉的垃圾子树（nav/aside 等）里的打标元素在克隆树中已不存在，自然跳过。
      const blockTails = new Map();
      const hoverWalk = (node) => {
        for (const child of [...node.childNodes]) {
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          const seq = child.getAttribute(HOVER_ATTR);
          if (seq !== null) {
            const item = tagged[Number(seq) - 1];
            const marker = document.createTextNode(`悬浮内容${seq}`);
            child.replaceWith(marker);
            if (item.content) { // 纯图片面板没有文字可注，图片已由图片管线按编号标注
              let block = marker.parentElement;
              while (block && block !== root && !/^(P|PRE|LI|BLOCKQUOTE|TABLE|H[1-6])$/.test(block.tagName)) block = block.parentElement;
              // 注释用 P 元素而非文本节点：render 会把文本节点的换行压成空格，多条注释会连在一行；
              // P 渲染为独立段落，每条注释各自一段。列表项内的注释提升到整个列表之后，避免变成列表项
              if (block?.tagName === 'LI' && /^(UL|OL)$/.test(block.parentElement?.tagName)) block = block.parentElement;
              const note = document.createElement('p');
              note.append(document.createTextNode(`悬浮内容${seq}: ${item.content}`));
              if (block && block !== root) {
                const tail = blockTails.get(block) || block;
                tail.after(note);
                blockTails.set(block, note);
              } else {
                marker.after(note); // 没有块级祖先（直接挂在根上）：注释紧跟标记
              }
            }
            continue; // 面板已替换为标记，不再下钻
          }
          hoverWalk(child);
        }
      };
      hoverWalk(root);

      return render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    // frameset 页面（90 年代老站常见）：主文档 document.body 为空/null，正文在同源子 frame 里
    function frameBodies() {
      const bodies = [];
      for (const frame of document.querySelectorAll('frame')) {
        let body = null;
        try { body = frame.contentDocument?.body ?? null; } catch { body = null; } // 跨域 frame 不可读，跳过
        if (body && (body.textContent || '').replace(/\s+/g, '').length >= 20) bodies.push(body);
      }
      return bodies;
    }

    // frameset 文档：body 即 FRAMESET 元素。它本身没有正文（且第三方扩展的注入物会 append 到它上面，
    // 可能超过下方 20 字符阈值导致永不回退），所以 frameset 永远跳过主文档、直接走 frame 回退
    const body = document.body?.tagName === 'FRAMESET' ? null : document.body;
    const primary = document.querySelector('article, main, [role="main"]') || body;
    let markdown = primary ? await extractFrom(primary) : '';
    if (markdown.length < 20) {
      const bodies = frameBodies();
      if (!primary && bodies.length === 0) throw new Error('页面没有可读取正文');
      if (bodies.length > 0) {
        const parts = [];
        for (const body of bodies) parts.push(await extractFrom(body));
        markdown = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
      }
    }
    if (markdown.length < 20) throw new Error('未提取到足够的正文内容');
    return { title: document.title.trim() || '网页剪藏', sourceUrl: location.href, capturedAt: new Date().toISOString(), markdown, images, iframes };
  } catch (error) { return { error: error.message }; }
})()
