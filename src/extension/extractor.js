(async () => {
  try {
    const sourceRoot = document.querySelector('article, main, [role="main"]') || document.body;
    if (!sourceRoot) throw new Error('页面没有可读取正文');
    const root = sourceRoot.cloneNode(true);
    root.querySelectorAll('script,style,noscript,template,nav,aside,form,button,input,select,textarea,svg,canvas,iframe').forEach((node) => node.remove());

    const originalImages = [...sourceRoot.querySelectorAll('img')].slice(0, 30);
    const clonedImages = [...root.querySelectorAll('img')];
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

    for (let index = 0; index < clonedImages.length; index += 1) {
      const clone = clonedImages[index];
      if (index >= 30) { clone.remove(); continue; }
      const original = originalImages[index] || clone;
      const source = candidate(original);
      const image = { label: original.alt?.trim() || `图片 ${index + 1}`, source };
      try { Object.assign(image, await readableBytes(source)); } catch (error) { image.browserWarning = error.message; }
      images.push(image);
      clone.replaceWith(document.createTextNode(`\n\n[[FEISHU_CLIP_IMAGE:${index}]]\n\n`));
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

    const markdown = render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (markdown.length < 20) throw new Error('未提取到足够的正文内容');
    return { title: document.title.trim() || '网页剪藏', sourceUrl: location.href, capturedAt: new Date().toISOString(), markdown, images };
  } catch (error) { return { error: error.message }; }
})()
