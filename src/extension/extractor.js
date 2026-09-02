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
