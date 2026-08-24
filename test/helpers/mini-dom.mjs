// 手写 mini-DOM，仅覆盖被测脚本用到的 DOM API（仓库测试零依赖约定，不引 linkedom）。
// 支持：nodeType/textContent/childNodes/append/cloneNode/querySelectorAll(单标签)/getAttribute/remove/replaceWith。

export function textNode(text) {
  return {
    nodeType: 3, nodeValue: text, childNodes: [], parentElement: null,
    get textContent() { return this.nodeValue; },
  };
}

export function element(tag, children = []) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], parentElement: null, attributes: {},
    get textContent() { return this.childNodes.map((c) => c.textContent ?? '').join(''); },
    append(...kids) {
      for (const kid of kids) {
        if (kid && typeof kid === 'object') { kid.parentElement = node; node.childNodes.push(kid); }
      }
    },
    getAttribute(name) { return node.attributes[name] ?? null; },
    cloneNode(deep) {
      const copy = element(tag);
      copy.attributes = { ...node.attributes };
      if (deep) {
        for (const child of node.childNodes) {
          copy.append(child.nodeType === 3 ? textNode(child.nodeValue) : child.cloneNode(true));
        }
      }
      return copy;
    },
    // 仅支持单标签选择器（如 'frame'/'img'）；组合选择器在测试夹具中约定无匹配
    querySelectorAll(selector) {
      if (!/^[a-z]+$/i.test(selector)) return [];
      const out = [];
      const walk = (n) => {
        if (n.tagName === selector.toUpperCase()) out.push(n);
        for (const child of n.childNodes ?? []) walk(child);
      };
      walk(node);
      return out;
    },
    querySelector() { return null; },
    remove() {
      const parent = node.parentElement;
      if (parent) parent.childNodes = parent.childNodes.filter((c) => c !== node);
    },
    replaceWith() {},
  };
  node.append(...children);
  return node;
}
