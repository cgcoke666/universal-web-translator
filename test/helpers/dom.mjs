/**
 * 迷你 DOM 实现：只为单元测试服务。
 *
 * 为什么需要它：本机沙箱禁止 spawn 子进程，jsdom 之类的库装了也用不了；
 * 而"采集器/渲染器"的核心价值恰恰在于对 DOM 的处理细节，必须能自动化验证，
 * 不能只靠"打开浏览器看一眼"。
 *
 * 覆盖范围（刻意保持小而准）：
 *  - createElement / createTextNode / appendChild / insertBefore / remove
 *  - setAttribute / getAttribute / hasAttribute / removeAttribute
 *  - querySelectorAll（支持的结果子集：标签、.class、#id、[attr]、[attr="v"]、逗号分组）
 *  - matches（同一子集）
 *  - closest / isConnected / childNodes / children / parentElement / parentNode
 *  - attachShadow + shadowRoot（供 Shadow DOM 穿透测试使用）
 *  - textContent 读写
 *
 * 不支持：CSS 层叠、真实布局、事件冒泡（这些交给浏览器，测试不负责）。
 */

let nodeCounter = 0;

class Node {
  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.nodeValue = null;
    this._uid = (nodeCounter += 1);
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get isConnected() {
    let root = this;
    while (root.parentNode) root = root.parentNode;
    return root.nodeType === 9 || root.__connected === true;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue ?? '';
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

class Text extends Node {
  constructor(value, ownerDocument) {
    super(3, '#text', ownerDocument);
    this.nodeValue = value;
  }
}

class Element extends Node {
  constructor(tagName, ownerDocument) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.shadowRoot = null;
    /** 测试钩子：由测试代码决定元素是否"可见" */
    this.__visible = true;
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** 与真实 DOM 一致：force 省略时取反，返回最终是否存在 */
  toggleAttribute(name, force) {
    const shouldHave = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (shouldHave) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return shouldHave;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  attachShadow() {
    if (!this.shadowRoot) this.shadowRoot = new ShadowRoot(this.ownerDocument, this);
    return this.shadowRoot;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const part of String(selector).split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      collectMatching(this, trimmed, results);
    }
    return dedupe(results);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  matches(selector) {
    return String(selector)
      .split(',')
      .some((part) => matchesSimple(this, part.trim()));
  }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ---- 可见性 API（collector 会调用） ---- */

  checkVisibility() {
    return this.__visible;
  }

  getClientRects() {
    return this.__visible ? [{ width: 100, height: 20 }] : [];
  }
}

class ShadowRoot extends Node {
  constructor(ownerDocument, host) {
    super(11, '#document-fragment', ownerDocument);
    this.host = host;
  }
}

class Document extends Node {
  constructor() {
    super(9, '#document', null);
    this.ownerDocument = this;
    this.documentElement = this.createElement('html');
    this.appendChild(this.documentElement);
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new Element(tagName, this);
  }

  createTextNode(value) {
    return new Text(value, this);
  }

  getElementById(id) {
    return this.querySelectorAll(`#${id}`)[0] ?? null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const part of String(selector).split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      collectMatching(this, trimmed, results);
    }
    return dedupe(results);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item._uid)) continue;
    seen.add(item._uid);
    out.push(item);
  }
  return out;
}

/** 深度优先收集匹配的后代 */
function collectMatching(root, selector, out) {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue;
    if (matchesSimple(child, selector)) out.push(child);
    collectMatching(child, selector, out);
    if (child.shadowRoot) collectMatching(child.shadowRoot, selector, out);
  }
}

/** 支持单个复合选择器：tag.class#id[attr][attr="v"]（用空白分隔的则退化为"只看最后一个"） */
function matchesSimple(el, selector) {
  if (!selector) return false;
  const compound = selector.split(/\s+/).pop();
  if (!compound) return false;
  const parts = compound.match(/([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)/);
  if (!parts) return false;
  const [, tag, classesAndIds, attrs] = parts;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (classesAndIds) {
    const tokens = classesAndIds.match(/[.#][\w-]+/g) ?? [];
    for (const token of tokens) {
      if (token.startsWith('.')) {
        if (!el.className.split(/\s+/).includes(token.slice(1))) return false;
      } else if (el.getAttribute('id') !== token.slice(1)) return false;
    }
  }
  if (attrs) {
    const tokens = attrs.match(/\[[^\]]+\]/g) ?? [];
    for (const token of tokens) {
      const body = token.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) {
        if (!el.hasAttribute(body)) return false;
      } else {
        const name = body.slice(0, eq);
        const raw = body.slice(eq + 1).replace(/^["']|["']$/g, '');
        if (el.getAttribute(name) !== raw) return false;
      }
    }
  }
  return true;
}

/** 造一个已连接的文档，body 内容用 HTML 片段字符串描述 */
export function createDocument(html = '') {
  const doc = new Document();
  parseInto(doc, doc.body, html);
  doc.__connected = true;
  return doc;
}

/**
 * 极简 HTML 解析器：支持标签、属性、文本、自闭合与 void 标签。
 * 直接构建真实元素树（不做中间表示），避免"对象字面量丢掉 nodeType"这类坑。
 * @param {Document} doc
 * @param {Element} parent
 * @param {string} html
 */
export function parseInto(doc, parent, html) {
  const stack = [parent];
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const full = match[0];
    const text = match[4];
    if (text !== undefined) {
      if (text.trim()) {
        stack[stack.length - 1].appendChild(doc.createTextNode(decodeEntities(text)));
      }
      continue;
    }
    if (full.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tagName = match[1];
    const rawAttrs = match[2];
    const selfClose = match[3] === '/';
    const el = doc.createElement(tagName);
    if (rawAttrs) {
      const attrRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let attrMatch;
      while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
        const name = attrMatch[1];
        const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
        el.setAttribute(name, decodeEntities(value));
      }
    }
    stack[stack.length - 1].appendChild(el);
    const voidTag = ['br', 'img', 'input', 'hr', 'meta', 'link'].includes(tagName.toLowerCase());
    if (!selfClose && !voidTag) stack.push(el);
  }
  return parent;
}

/** 保留旧名字，供需要"片段数组"的调用方使用 */
export function parseFragment(doc, html) {
  const holder = new Document().createElement('div');
  parseInto(doc, holder, html);
  return holder.childNodes;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 把整棵树的文本节点收集出来（断言用） */
export function textNodesOf(node) {
  const out = [];
  const walk = (current) => {
    if (current.nodeType === 3) out.push(current);
    for (const child of current.childNodes) walk(child);
    if (current.shadowRoot) walk(current.shadowRoot);
  };
  walk(node);
  return out;
}

export { Document, Element, Text };
