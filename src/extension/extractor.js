(async () => {
  try {
    const images = [];
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
    function render(node, depth = 0) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName;
      const children = () => [...node.childNodes].map((child) => render(child, depth)).join('');
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
        let href; try { href = new URL(node.getAttribute('href'), location.href).href; } catch { href = null; }
        const label = children().trim() || href || '';
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

    // 单根提取：清理 + 图片管线 + 渲染。images/browserBytes 跨根共享（占位符索引连续、流量预算合并）
    async function extractFrom(sourceRoot) {
      const root = sourceRoot.cloneNode(true);
      root.querySelectorAll('script,style,noscript,template,nav,aside,form,button,input,select,textarea,svg,canvas,iframe').forEach((node) => node.remove());

      const originalImages = [...sourceRoot.querySelectorAll('img')].slice(0, 30);
      const clonedImages = [...root.querySelectorAll('img')];
      const preTails = new Map(); // pre 元素 → 当前锚点插入点，保证同一 pre 多图锚点按原顺序排列
      for (const [cloneIndex, clone] of clonedImages.entries()) {
        if (cloneIndex >= 30) { clone.remove(); continue; }
        const original = originalImages[cloneIndex] || clone;
        // 原页面未渲染的图片（display:none 子树内，如代码行内 hover 提示图）没有布局盒，
        // 用户看不见，剪藏也不应出现；跳过并从克隆树移除，避免产生孤立锚点
        if (typeof original.getClientRects === 'function' && original.getClientRects().length === 0) { clone.remove(); continue; }
        const index = images.length;
        const source = candidate(original);
        const image = { label: original.alt?.trim() || `图片 ${index + 1}`, source };
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
        // pre 内的 img 原地替换会让锚点成为围栏代码块里的一行文本，导入飞书后落在
        // code 块（block_type 14）里——bridge 既定位不到也删不掉。改为移出最外层 pre
        // （嵌套 pre 时 closest 只拿到内层），让锚点渲染成代码块之后的独立段落
        let pre = clone.closest('pre');
        if (pre) {
          while (pre.parentElement?.closest('pre')) pre = pre.parentElement.closest('pre');
          clone.remove();
          const tail = preTails.get(pre) || pre;
          tail.after(anchor);
          preTails.set(pre, anchor);
        } else {
          clone.replaceWith(anchor);
        }
      }

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
    return { title: document.title.trim() || '网页剪藏', sourceUrl: location.href, capturedAt: new Date().toISOString(), markdown, images };
  } catch (error) { return { error: error.message }; }
})()
