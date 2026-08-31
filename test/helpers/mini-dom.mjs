// 手写 mini-DOM，仅覆盖被测脚本用到的 DOM API（仓库测试零依赖约定，不引 linkedom）。
// 支持：nodeType/textContent/childNodes/append/cloneNode/querySelectorAll(单标签)/getAttribute/setAttribute/removeAttribute/remove/replaceWith/after/closest(单标签)。

function link(parent, kids) {
  return kids.filter((kid) => kid && typeof kid === 'object').map((kid) => {
    kid.parentElement = parent;
    return kid;
  });
}

export function textNode(text) {
  return {
    nodeType: 3, nodeValue: text, childNodes: [], parentElement: null,
    get textContent() { return this.nodeValue; },
    after(...nodes) {
      const parent = this.parentElement;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, ...link(parent, nodes));
    },
  };
}

export function element(tag, children = []) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], parentElement: null, attributes: {},
    get textContent() { return this.childNodes.map((c) => c.textContent ?? '').join(''); },
    append(...kids) {
      node.childNodes.push(...link(node, kids));
    },
    getAttribute(name) { return node.attributes[name] ?? null; },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    removeAttribute(name) { delete node.attributes[name]; },
    cloneNode(deep) {
      const copy = element(tag);
      copy.attributes = { ...node.attributes };
      // dataset/currentSrc/src/alt 等是测试夹具后挂的自有数据属性，clone 时一并带上；
      // 方法（闭包引用原节点）与 textContent（getter）不能拷
      Object.assign(copy, Object.fromEntries(
        Object.entries(node).filter(([key, value]) => typeof value !== 'function'
          && !['nodeType', 'tagName', 'childNodes', 'parentElement', 'attributes', 'textContent'].includes(key)),
      ));
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
    // 仅支持单标签（如 closest('pre')），沿父链向上找（含自身）
    closest(selector) {
      if (!/^[a-z]+$/i.test(selector)) return null;
      let current = node;
      while (current) {
        if (current.tagName === selector.toUpperCase()) return current;
        current = current.parentElement;
      }
      return null;
    },
    remove() {
      const parent = node.parentElement;
      if (parent) parent.childNodes = parent.childNodes.filter((c) => c !== node);
      node.parentElement = null;
    },
    replaceWith(...nodes) {
      const parent = node.parentElement;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...link(parent, nodes));
      node.parentElement = null;
    },
    after(...nodes) {
      const parent = node.parentElement;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(node) + 1, 0, ...link(parent, nodes));
    },
  };
  node.append(...children);
  return node;
}
