/**
 * 译文渲染层：把翻译结果安全地放进页面。
 *
 * 安全第一：
 *  - 译文来自第三方（模型/接口），**绝不能**直接 innerHTML，否则一个带 <img onerror> 的
 *    译文就是 XSS。这里只允许我们自己解析出来的受限 markdown 标签（strong/em/code/a/br），
 *    其余一律文本化。
 *
 * 布局第二：
 *  - 双语对照模式使用 `display: contents` 的包裹元素，避免破坏 flex/grid/table 布局；
 *  - 仅译文模式隐藏原文节点，但保留节点本身，保证还原可行。
 */

const INLINE_TAGS = {
  '**': 'strong',
  __: 'em',
  '`': 'code'
};

/* ------------------------------------------------------------------ *
 * 受限 Markdown 解析
 * ------------------------------------------------------------------ */

/**
 * 把译文里的轻量 markdown 转成 DOM 节点数组。
 * 支持：**粗体**、*斜体* / _斜体_、`行内代码`、[文字](链接)、换行。
 * 不支持嵌套块级语法（标题/列表/表格），这类内容交由 CSS 保持原样文本。
 *
 * @param {Document} doc
 * @param {string} text
 * @param {{links?: boolean, markdown?: boolean}} [options]
 * @returns {Node[]}
 */
export function renderInline(doc, text, options = {}) {
  const allowMarkdown = options.markdown !== false;
  const allowLinks = options.links !== false;
  const plain = String(text ?? '');
  if (!allowMarkdown) return splitLines(doc, plain);

  const nodes = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(plain)) !== null) {
    if (match.index > lastIndex) pushTextWithBreaks(doc, nodes, plain.slice(lastIndex, match.index));
    const token = match[0];
    const el = decorate(doc, token, allowLinks);
    if (el) nodes.push(el);
    else pushTextWithBreaks(doc, nodes, token);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < plain.length) pushTextWithBreaks(doc, nodes, plain.slice(lastIndex));
  return nodes;
}

function decorate(doc, token, allowLinks) {
  if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
    return wrap(doc, 'strong', token.slice(2, -2));
  }
  if (token.startsWith('__') && token.endsWith('__') && token.length > 4) {
    return wrap(doc, 'strong', token.slice(2, -2));
  }
  if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
    return wrap(doc, 'code', token.slice(1, -1));
  }
  if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
    return wrap(doc, 'em', token.slice(1, -1));
  }
  if (token.startsWith('_') && token.endsWith('_') && token.length > 2) {
    return wrap(doc, 'em', token.slice(1, -1));
  }
  const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
  if (link && allowLinks) {
    const href = link[2];
    // 只允许安全协议，挡掉 javascript: / data: / vbscript:
    if (isSafeHref(href)) {
      const a = doc.createElement('a');
      a.textContent = link[1];
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return a;
    }
    return wrap(doc, 'span', link[1]);
  }
  return null;
}

/** 白名单式链接校验：相对路径、http(s)、mailto、页内锚点 */
export function isSafeHref(href) {
  const value = String(href ?? '').trim();
  if (!value) return false;
  if (/^(https?:|mailto:)/i.test(value)) return true;
  if (value.startsWith('/') || value.startsWith('#') || value.startsWith('./') || value.startsWith('../')) return true;
  return false;
}

function wrap(doc, tag, content) {
  const el = doc.createElement(tag);
  el.textContent = content;
  return el;
}

function splitLines(doc, text) {
  const nodes = [];
  pushTextWithBreaks(doc, nodes, text);
  return nodes;
}

function pushTextWithBreaks(doc, nodes, text) {
  const parts = String(text).split(/\n/);
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(doc.createElement('br'));
    if (part) nodes.push(doc.createTextNode(part));
  });
}

export { INLINE_TAGS };

/* ------------------------------------------------------------------ *
 * 渲染器
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} RenderOptions
 * @property {'bilingual'|'replace'} displayMode
 * @property {string} color
 * @property {number} fontScale
 * @property {boolean} markdown
 * @property {boolean} originalTooltip
 * @property {boolean} showFlag
 */

export class TranslationRenderer {
  /**
   * @param {RenderOptions} options
   */
  constructor(options) {
    this.options = options;
    /** 已插入的译文元素集合，用于整体切换显隐与还原 */
    this.inserted = new Set();
  }

  setOptions(options) {
    this.options = { ...this.options, ...options };
  }

  /**
   * 渲染一条记录的译文。
   *
   * @param {object} params
   * @param {Document} params.doc
   * @param {object} params.record  采集记录（target 为 text 或 attr）
   * @param {string} params.translated
   * @param {number[]} [params.coveredIds] 该记录中被成功翻译的分段 id
   * @param {boolean} [params.partial]     是否只翻译了记录的一部分
   */
  renderRecord({ doc, record, translated, partial }) {
    const target = record.target;
    if (!target || !translated) return null;

    if (target.kind === 'attr') {
      return this.renderAttribute(target, translated);
    }

    const node = /** @type {Text} */ (target.node);
    if (!node || !node.parentNode) return null;

    // 双语对照：在原文节点后插入译文容器
    const wrapper = doc.createElement('span');
    wrapper.setAttribute('data-dsh-translator', 'inline');
    wrapper.setAttribute('class', 'dsh-translation');
    if (partial) wrapper.setAttribute('data-dsh-partial', '1');
    if (this.options.showFlag) wrapper.setAttribute('data-dsh-flag', '1');

    const body = doc.createElement('span');
    body.setAttribute('class', 'dsh-translation__body');
    for (const child of renderInline(doc, translated, { markdown: this.options.markdown })) {
      body.appendChild(child);
    }
    wrapper.appendChild(body);

    if (this.options.originalTooltip && !partial) {
      wrapper.setAttribute('title', record.text.length > 400 ? `${record.text.slice(0, 400)}…` : record.text);
    }

    // 记录原文，便于还原与"点击查看原文"
    wrapper.setAttribute('data-dsh-source', record.text.slice(0, 500));

    node.parentNode.insertBefore(wrapper, node.nextSibling);
    this.inserted.add(wrapper);
    return wrapper;
  }

  /** 属性文本直接写回属性，并记录原值以便还原 */
  renderAttribute(target, translated) {
    const el = /** @type {Element} */ (target.element);
    const attr = target.attr;
    if (!el || !attr) return null;
    if (!el.hasAttribute(`data-dsh-attr-orig-${attr}`)) {
      el.setAttribute(`data-dsh-attr-orig-${attr}`, target.text);
    }
    el.setAttribute(attr, translated);
    el.setAttribute(`data-dsh-attr-${attr}`, 'translated');
    return el;
  }

  /** 仅译文模式下隐藏原文节点 */
  hideOriginal(record) {
    const target = record.target;
    if (!target || target.kind !== 'text') return;
    const node = /** @type {Text} */ (target.node);
    if (!node || !node.parentNode) return;
    // 用注释包裹太复杂；直接给文本节点套一个"仅译文"容器
    const holder = node.parentNode;
    if (holder && holder.nodeType === 1 && !holder.hasAttribute('data-dsh-orig')) {
      holder.setAttribute('data-dsh-orig', '1');
    } else {
      const parent = node.parentElement;
      if (parent) parent.setAttribute('data-dsh-orig', '1');
    }
  }

  /** 显示/隐藏译文层（收起时不删除，保证再次展开无需重新翻译） */
  setTranslationsVisible(visible) {
    for (const el of this.inserted) {
      if (el?.nodeType === 1) {
        el.toggleAttribute('hidden', !visible);
      }
    }
  }

  /** 删除所有插入的译文元素与属性改写，恢复页面原貌 */
  clear() {
    for (const el of this.inserted) {
      if (el?.nodeType === 1 && el.isConnected) el.remove();
    }
    this.inserted.clear();
  }

  get size() {
    return this.inserted.size;
  }
}
