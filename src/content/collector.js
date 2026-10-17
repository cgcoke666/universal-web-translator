/**
 * DOM 采集器：把页面里"该翻译的文字"找出来，并保持可在任意时刻精确还原。
 *
 * 适配要点（决定了一款翻译扩展能覆盖多少网站）：
 *  1. **只取叶子文本节点**：有元素子节点的元素不直接取文本，避免把整块 HTML 拍平成一行；
 *  2. **可见性判定**：display:none / visibility:hidden / 零尺寸 / aria-hidden 一律跳过，
 *     否则会把模板、预加载内容、隐藏菜单都送去翻译，白白烧配额；
 *  3. **代码与噪音白名单**：pre/code/kbd/svg/输入框/编辑器（Monaco、CodeMirror、Ace）跳过；
 *  4. **Shadow DOM 递归**：现代站点大量使用 Web Components，必须穿透 closed/open shadow root；
 *  5. **属性文本**：placeholder / aria-label / alt / title / value(button) 也可翻译；
 *  6. **对照关系登记**：每个被翻译的文本节点都登记到 registry，还原时不依赖 DOM 结构是否变化。
 */

import { DEFAULT_SKIP_SELECTORS, createLogger, defaultIsVisible } from '../shared/constants.js';
import { isProbablyCode, isTranslatableText } from '../shared/lang.js';

/* ------------------------------------------------------------------ *
 * 类型（JSDoc，工程不使用 TypeScript 编译）
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} CollectConfig
 * @property {string[]} skipSelectors      追加的跳过选择器（站点适配用）
 * @property {string[]} onlySelectors      只翻译这些容器内部（空 = 全页）
 * @property {string[]} [noiseSelectors]   噪音选择器（导航/页脚等），受 skipNoise 控制
 * @property {boolean} skipNoise
 * @property {number} minTextLength
 * @property {number} maxNodeLength
 * @property {boolean} translatePlaceholder
 * @property {boolean} translateAriaLabel
 * @property {boolean} translateImageAlt
 * @property {boolean} translateTitle
 * @property {boolean} translateShadowDom
 * @property {number} [maxNodes]           单轮采集上限，防止超大页面卡死
 * @property {(el: Element) => boolean} [isVisible]
 */

/**
 * @typedef {object} TextTarget
 * @property {'text'|'attr'} kind
 * @property {Node} node
 * @property {Element} element
 * @property {string} text
 * @property {string} [attr]
 */

/**
 * @typedef {object} SegmentRecord
 * @property {number} id
 * @property {TextTarget} target
 * @property {string} text
 */

/* ------------------------------------------------------------------ *
 * 采集器
 * ------------------------------------------------------------------ */

export class DomCollector {
  /**
   * @param {CollectConfig} config
   */
  constructor(config) {
    this.config = config;
    /** 已登记的原文节点 → 记录（原始文本 + 所属段落 id） */
    this.records = new WeakMap();
    /** 需要在还原时把属性写回的目标 */
    this.attrRecords = [];
    this.log = createLogger('collector', () => false);
  }

  setDebug(fn) {
    this.log = createLogger('collector', fn);
  }

  /**
   * 扫描 root，返回待翻译分段。
   * @param {ParentNode} root
   * @param {{limit?: number}} [options]
   * @returns {SegmentRecord[]}
   */
  collect(root, options = {}) {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const limit = options.limit ?? this.config.maxNodes ?? 4000;
    /** @type {SegmentRecord[]} */
    const segments = [];
    /** @type {Node[]} */
    const textNodes = [];
    /** @type {TextTarget[]} */
    const attrTargets = [];
    let id = 0;

    const skipSelectors = [...DEFAULT_SKIP_SELECTORS, ...(this.config.skipSelectors || [])];
    const noiseSelectors = this.config.skipNoise ? this.config.noiseSelectors || [] : [];
    const skipJoined = skipSelectors.filter(Boolean).join(',');
    const noiseJoined = noiseSelectors.filter(Boolean).join(',');
    const onlyJoined = (this.config.onlySelectors || []).filter(Boolean).join(',');

    const isVisible = this.config.isVisible ?? defaultIsVisible;

    /** 判断某节点是否位于被跳过区域内 */
    const isSkipped = (node) => {
      let el = node.nodeType === 1 ? node : node.parentElement;
      while (el) {
        if (el.hasAttribute?.('data-dsh-block')) return true;
        if (skipJoined && el.matches?.(skipJoined)) return true;
        if (noiseJoined && el.matches?.(noiseJoined)) return true;
        el = el.parentElement;
      }
      return false;
    };

    /**
     * 深度优先遍历：收集叶子文本节点 + 属性目标。
     * @param {Node} node
     */
    const walk = (node) => {
      if (textNodes.length + attrTargets.length >= limit) return;

      // Document / DocumentFragment / ShadowRoot：本身没有文本，下探子节点即可。
      // 这一分支非常重要——content script 传入的 root 就是 document。
      if (node.nodeType === 9 || node.nodeType === 11) {
        for (const child of node.childNodes) walk(child);
        return;
      }

      if (node.nodeType === 3) {
        // 文本节点
        const parent = node.parentElement;
        if (!parent || isSkipped(parent)) return;
        if (!isVisible(parent)) return;
        const text = node.nodeValue ?? '';
        if (!text.trim()) return;
        if (this.records.has(node)) return; // 已经处理过且未还原
        if (text.length > (this.config.maxNodeLength ?? 6000)) return;
        textNodes.push(node);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = /** @type {Element} */ (node);
      const tag = el.tagName;

      // 已经是我们插入的译文容器，跳过整个子树
      if (el.hasAttribute('data-dsh-translator') || el.id === 'dsh-translator-root') return;
      if (!isVisible(el)) return;

      // 属性文本要在"跳过判定"之前采集：
      // <input placeholder>、<img alt>、<button title> 这类元素本身就在跳过选择器里
      // （它们是输入控件/媒体元素），但它们的占位符与提示文字恰恰是应该翻译的内容。
      this.collectAttributes(el, attrTargets, isVisible);

      if (isSkipped(el)) {
        // 仍然要穿透 shadow root（有些站点把正常内容放在 shadow 里）
        if (this.config.translateShadowDom && el.shadowRoot) walk(el.shadowRoot);
        return;
      }
      if (onlyJoined && !matchesSelfOrAncestor(el, onlyJoined)) {
        // 语义是"只翻译位于匹配区域内的文字"：自身不匹配时，只要**有后代**命中就继续下探，
        // 否则整棵子树放弃。注意不能直接返回——祖先节点（html/body/包裹层）几乎都不匹配。
        if (!el.querySelector(onlyJoined)) return;
      }

      // 叶子文本：没有元素子节点时，文本节点直接是它的内容
      let hasElementChild = false;
      for (const child of el.childNodes) {
        if (child.nodeType === 1) {
          hasElementChild = true;
          break;
        }
      }
      if (!hasElementChild) {
        for (const child of el.childNodes) {
          if (child.nodeType === 3) {
            const text = child.nodeValue ?? '';
            if (!text.trim() || this.records.has(child)) continue;
            if (text.length > (this.config.maxNodeLength ?? 6000)) continue;
            textNodes.push(child);
          }
        }
      } else {
        for (const child of el.childNodes) walk(child);
      }

      // Shadow DOM 穿透
      if (this.config.translateShadowDom && el.shadowRoot) walk(el.shadowRoot);
    };

    const scope = this.resolveScope(root);
    for (const node of scope) walk(node);

    // 组装分段：每个文本节点一个分段（切分交给 segmenter）
    for (const node of textNodes) {
      const parent = node.parentElement;
      if (!parent) continue;
      const text = node.nodeValue ?? '';
      const target = { kind: 'text', node, element: parent, text };
      const record = { id: id += 1, target, text };
      this.records.set(node, record);
      segments.push(record);
    }
    for (const target of attrTargets) {
      const record = { id: id += 1, target, text: target.text };
      this.attrRecords.push(record);
      segments.push(record);
    }

    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    this.log.debug(`采集 ${segments.length} 段，用时 ${Math.round(elapsed)}ms`);
    return segments;
  }

  /**
   * 采集后代中的属性文本（placeholder / aria-label / alt / title）。
   * @param {Element} el
   * @param {TextTarget[]} out
   * @param {(el: Element) => boolean} isVisible
   */
  collectAttributes(el, out, isVisible) {
    const cfg = this.config;
    /** @type {Array<[string, boolean]>} */
    const candidates = [];
    if (cfg.translatePlaceholder) candidates.push(['placeholder', true]);
    if (cfg.translateAriaLabel) candidates.push(['aria-label', false]);
    if (cfg.translateImageAlt) candidates.push(['alt', false]);
    if (cfg.translateTitle) candidates.push(['title', false]);

    for (const [attr, needsVisibility] of candidates) {
      const value = el.getAttribute(attr);
      if (!value || !value.trim()) continue;
      if (value.length > (cfg.maxNodeLength ?? 6000)) continue;
      if (!isTranslatableText(value, cfg.minTextLength ?? 2)) continue;
      if (isProbablyCode(value)) continue;
      if (!needsVisibility && attr === 'alt' && !isVisible(el)) continue;
      // input 的 placeholder 常常在隐藏容器里，这里仍要求元素存在
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !isVisible(el)) continue;
      out.push({ kind: 'attr', node: el, element: el, text: value, attr });
    }
  }

  /**
   * 计算扫描起点。
   *
   * 始终从 root 开始遍历：onlySelectors 的语义由 walk 里的"自身或后代命中"判断实现。
   * 早期版本把命中元素当作 root，会在规则写错或内容尚未渲染时静默翻不到任何内容，
   * 排查成本很高，因此这里保持"入口单一、策略在遍历中判断"。
   */
  resolveScope(root) {
    return [root];
  }

  /** 已登记记录（供渲染层与还原层查询） */
  getRecord(node) {
    return this.records.get(node);
  }

  /** 该节点是否已经处理过 */
  has(node) {
    return this.records.has(node);
  }

  /** 还原登记表：DOM 被改动后，对已不存在的节点做清理 */
  prune() {
    this.attrRecords = this.attrRecords.filter((record) => record.element?.isConnected);
  }

  reset() {
    this.records = new WeakMap();
    this.attrRecords = [];
  }
}

/* ------------------------------------------------------------------ *
 * 说明
 * ------------------------------------------------------------------ *
 * 可见性判定 `defaultIsVisible` 位于 shared/constants.js，因为 popup/options 与
 * 未来的其它入口也可能需要同一套判断；collector 通过注入的 config.isVisible 使用它，
 * 这样单元测试可以替换成恒真实现。
 */

/**
 * 元素自身或任一祖先是否匹配选择器。
 * 用于 onlySelectors："只翻译文章正文"这类需求，语义是"位于匹配区域内"，
 * 而不是"匹配的元素本身"。
 * @param {Element} el
 * @param {string} selector
 */
function matchesSelfOrAncestor(el, selector) {
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.matches?.(selector)) return true;
    node = node.parentElement;
  }
  return false;
}
