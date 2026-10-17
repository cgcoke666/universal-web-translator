/**
 * 渲染器单测。
 *
 * 重点不是"好不好看"，而是两件要命的事：
 *  1. **安全**：译文来自第三方，绝不能被当成 HTML 执行（XSS）；
 *  2. **可还原**：插入的节点必须能被完整撤回，页面回到原样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TranslationRenderer, isSafeHref, renderInline } from '../src/content/renderer.js';
import { createDocument } from './helpers/dom.mjs';

const baseOptions = {
  displayMode: 'bilingual',
  color: '#4b7bec',
  fontScale: 0.95,
  markdown: true,
  originalTooltip: true,
  showFlag: true
};

test('renderInline：粗体/斜体/行内代码/链接被转成受限标签', () => {
  const doc = createDocument('');
  const nodes = renderInline(doc, 'Use **bold**, *italic*, `code` and [link](https://example.com).', {});
  const html = nodes.map(serialize).join('');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>link<\/a>/);
});

test('renderInline：原始 HTML 不会被解析成元素（防 XSS）', () => {
  const doc = createDocument('');
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const nodes = renderInline(doc, payload, {});
  const html = nodes.map(serialize).join('');
  assert.ok(!html.includes('<img'), `不应生成 img 元素：${html}`);
  assert.ok(!html.includes('<script'), `不应生成 script 元素：${html}`);
  assert.ok(html.includes('&lt;img'), '原始尖括号应保留为文本');
});

test('isSafeHref 拦截危险协议', () => {
  assert.equal(isSafeHref('https://example.com'), true);
  assert.equal(isSafeHref('mailto:a@b.com'), true);
  assert.equal(isSafeHref('/relative/path'), true);
  assert.equal(isSafeHref('#anchor'), true);
  assert.equal(isSafeHref('javascript:alert(1)'), false);
  assert.equal(isSafeHref('data:text/html;base64,PHNjcmlwdD4='), false);
  assert.equal(isSafeHref('vbscript:msgbox'), false);
});

test('renderInline：危险链接只保留文字，不生成 a 标签', () => {
  const doc = createDocument('');
  const nodes = renderInline(doc, '[click me](javascript:alert(1))', {});
  const html = nodes.map(serialize).join('');
  assert.ok(!html.includes('<a'), `不应生成链接：${html}`);
  assert.ok(html.includes('click me'));
});

test('renderInline：换行转成 <br>', () => {
  const doc = createDocument('');
  const html = renderInline(doc, 'line one\nline two', {}).map(serialize).join('');
  assert.match(html, /line one<br>line two/);
});

test('renderRecord：在原文后插入译文容器，保留原文节点', () => {
  const doc = createDocument('<p>Hello world</p>');
  const p = doc.querySelector('p');
  const textNode = p.childNodes[0];
  const renderer = new TranslationRenderer(baseOptions);

  const wrapper = renderer.renderRecord({
    doc,
    record: { id: 1, text: 'Hello world', target: { kind: 'text', node: textNode, element: p, text: 'Hello world' } },
    translated: '你好，世界'
  });

  assert.ok(wrapper, '应返回插入的元素');
  assert.equal(p.textContent, 'Hello world你好，世界');
  assert.equal(p.childNodes[0], textNode, '原文文本节点必须保持原位');
  assert.equal(p.childNodes[1].getAttribute('data-dsh-translator'), 'inline');
  assert.equal(renderer.size, 1);
});

test('renderRecord：双语容器带原文 tooltip，便于对照', () => {
  const doc = createDocument('<p>Original text</p>');
  const p = doc.querySelector('p');
  const renderer = new TranslationRenderer(baseOptions);
  const wrapper = renderer.renderRecord({
    doc,
    record: { id: 1, text: 'Original text', target: { kind: 'text', node: p.childNodes[0], element: p, text: 'Original text' } },
    translated: '译文'
  });
  assert.equal(wrapper.getAttribute('title'), 'Original text');
  assert.equal(wrapper.getAttribute('data-dsh-source'), 'Original text');
});

test('renderRecord：属性文本写回属性并记录原值', () => {
  const doc = createDocument('<input placeholder="Search" />');
  const input = doc.querySelector('input');
  const renderer = new TranslationRenderer(baseOptions);
  renderer.renderRecord({
    doc,
    record: { id: 2, text: 'Search', target: { kind: 'attr', node: input, element: input, text: 'Search', attr: 'placeholder' } },
    translated: '搜索'
  });
  assert.equal(input.getAttribute('placeholder'), '搜索');
  assert.equal(input.getAttribute('data-dsh-attr-orig-placeholder'), 'Search');
  assert.equal(input.getAttribute('data-dsh-attr-placeholder'), 'translated');
});

test('clear：删除全部插入内容，页面回到原样', () => {
  const doc = createDocument('<p>Hello</p><p>World</p>');
  const renderer = new TranslationRenderer(baseOptions);
  for (const p of doc.querySelectorAll('p')) {
    renderer.renderRecord({
      doc,
      record: { id: 1, text: p.textContent, target: { kind: 'text', node: p.childNodes[0], element: p, text: p.textContent } },
      translated: '译文'
    });
  }
  assert.equal(renderer.size, 2);
  renderer.clear();
  assert.equal(renderer.size, 0);
  assert.equal(doc.body.textContent, 'HelloWorld');
  assert.equal(doc.body.childNodes.length, 2);
});

test('setTranslationsVisible(false)：隐藏译文但保留节点，可再次展开', () => {
  const doc = createDocument('<p>Hello</p>');
  const p = doc.querySelector('p');
  const renderer = new TranslationRenderer(baseOptions);
  const wrapper = renderer.renderRecord({
    doc,
    record: { id: 1, text: 'Hello', target: { kind: 'text', node: p.childNodes[0], element: p, text: 'Hello' } },
    translated: '你好'
  });
  renderer.setTranslationsVisible(false);
  assert.equal(wrapper.hasAttribute('hidden'), true);
  renderer.setTranslationsVisible(true);
  assert.equal(wrapper.hasAttribute('hidden'), false);
});

test('partial 标记：片段翻译时打上 data-dsh-partial', () => {
  const doc = createDocument('<p>Long text here</p>');
  const p = doc.querySelector('p');
  const renderer = new TranslationRenderer(baseOptions);
  const wrapper = renderer.renderRecord({
    doc,
    record: { id: 1, text: 'Long text here', target: { kind: 'text', node: p.childNodes[0], element: p, text: 'Long text here' } },
    translated: '长文本',
    partial: true
  });
  assert.equal(wrapper.getAttribute('data-dsh-partial'), '1');
  assert.equal(wrapper.getAttribute('title'), null, '片段翻译不应设置整段 tooltip');
});

/** 把伪 DOM 节点序列化成 HTML 字符串用于断言 */
function serialize(node) {
  if (node.nodeType === 3) {
    return node.nodeValue
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  const attrs = [...(node.attributes ?? [])]
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  const tag = node.tagName.toLowerCase();
  const children = node.childNodes.map(serialize).join('');
  if (tag === 'br') return '<br>';
  return `<${tag}${attrs}>${children}</${tag}>`;
}
