/**
 * 采集器单测：这些用例就是"能适配大多数网站"的证据。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DomCollector } from '../src/content/collector.js';
import { createDocument } from './helpers/dom.mjs';

const baseConfig = {
  skipSelectors: [],
  onlySelectors: [],
  noiseSelectors: [],
  skipNoise: false,
  minTextLength: 2,
  maxNodeLength: 6000,
  translatePlaceholder: true,
  translateAriaLabel: false,
  translateImageAlt: false,
  translateTitle: false,
  translateShadowDom: true,
  isVisible: () => true
};

function collector(overrides = {}) {
  return new DomCollector({ ...baseConfig, ...overrides });
}

test('只采集叶子文本节点，不把整块 HTML 拍平成一行', () => {
  const doc = createDocument(`
    <article>
      <h1>Hello world</h1>
      <p>First paragraph with <strong>bold</strong> text.</p>
    </article>`);
  const segments = collector().collect(doc);
  const texts = segments.map((s) => s.text.trim());
  assert.deepEqual(texts, ['Hello world', 'First paragraph with', 'bold', 'text.']);
});

test('有元素子节点时不重复采集父节点文本', () => {
  const doc = createDocument('<div><span>one</span><span>two</span></div>');
  const segments = collector().collect(doc);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((s) => s.text), ['one', 'two']);
});

test('跳过 script/style/code/pre 与输入控件', () => {
  const doc = createDocument(`
    <div>
      <script>var x = 1;</script>
      <style>.a{color:red}</style>
      <code>npm install</code>
      <pre>const a = 1;</pre>
      <textarea>editable</textarea>
      <input value="ignore" />
      <p>Real content here</p>
    </div>`);
  const segments = collector().collect(doc);
  assert.deepEqual(segments.map((s) => s.text.trim()), ['Real content here']);
});

test('站点自定义跳过选择器生效', () => {
  const doc = createDocument('<div class="ad">Buy now</div><p>Keep me</p>');
  const segments = collector({ skipSelectors: ['.ad'] }).collect(doc);
  assert.deepEqual(segments.map((s) => s.text), ['Keep me']);
});

test('data-dsh-block 标记的子树整体跳过', () => {
  const doc = createDocument('<section data-dsh-block><p>Skip me</p></section><p>Keep me</p>');
  const segments = collector().collect(doc);
  assert.deepEqual(segments.map((s) => s.text), ['Keep me']);
});

test('skipNoise 打开后跳过 nav/footer', () => {
  const html = '<nav><a href="#">Home</a></nav><footer>© 2026</footer><p>Body text</p>';
  assert.equal(collector().collect(createDocument(html)).length, 3);
  const segments = collector({
    skipNoise: true,
    noiseSelectors: ['nav', 'footer']
  }).collect(createDocument(html));
  assert.deepEqual(segments.map((s) => s.text), ['Body text']);
});

test('不可见元素被跳过', () => {
  const doc = createDocument('<div id="hidden"><p>Hidden text</p></div><p>Visible text</p>');
  const hidden = doc.getElementById('hidden');
  hidden.__visible = false;
  const segments = collector({ isVisible: (el) => el.checkVisibility() }).collect(doc);
  assert.deepEqual(segments.map((s) => s.text), ['Visible text']);
});

test('穿透 Shadow DOM 采集 Web Components 内容', () => {
  const doc = createDocument('<my-card></my-card><p>Light DOM text</p>');
  const host = doc.querySelector('my-card');
  const shadow = host.attachShadow();
  const p = doc.createElement('p');
  p.appendChild(doc.createTextNode('Shadow text'));
  shadow.appendChild(p);

  const texts = collector().collect(doc).map((s) => s.text);
  assert.ok(texts.includes('Shadow text'), `期望包含 Shadow text，实际为 ${JSON.stringify(texts)}`);

  const withoutShadow = collector({ translateShadowDom: false }).collect(createDocument('<my-card></my-card>'));
  assert.equal(withoutShadow.length, 0);
});

test('采集属性文本：placeholder / aria-label / alt / title', () => {
  const doc = createDocument('<input placeholder="Search here" /><img src="a.png" alt="Logo image" />');
  const segments = collector({
    translateAriaLabel: true,
    translateImageAlt: true,
    translateTitle: true
  }).collect(doc);
  const attrTargets = segments.filter((s) => s.target.kind === 'attr');
  assert.deepEqual(
    attrTargets.map((s) => `${s.target.attr}=${s.text}`),
    ['placeholder=Search here', 'alt=Logo image']
  );
});

test('onlySelectors 限定只翻译指定区域', () => {
  const doc = createDocument('<article><p>Article text</p></article><aside><p>Aside text</p></aside>');
  const segments = collector({ onlySelectors: ['article'] }).collect(doc);
  assert.deepEqual(segments.map((s) => s.text), ['Article text']);
});

test('已登记节点不会被重复采集（增量翻译的关键）', () => {
  const doc = createDocument('<p>One</p>');
  const c = collector();
  assert.equal(c.collect(doc).length, 1);
  assert.equal(c.collect(doc).length, 0);
  assert.equal(c.has(doc.querySelector('p').childNodes[0]), true);
});

test('maxNodes 限制单轮采集量，避免超大页面卡死', () => {
  const parts = [];
  for (let i = 0; i < 50; i += 1) parts.push(`<p>Paragraph number ${i}</p>`);
  const doc = createDocument(parts.join(''));
  const segments = collector({ maxNodes: 10 }).collect(doc);
  assert.ok(segments.length <= 20, `单轮采集应受限，实际 ${segments.length}`);
});

test('超长文本节点被跳过（由 maxNodeLength 控制）', () => {
  const long = 'This is a fairly long sentence used to verify the length guard. '.repeat(4);
  const doc = createDocument(`<p>${long}</p>`);
  assert.equal(collector({ maxNodeLength: 50 }).collect(doc).length, 0);
  assert.equal(collector({ maxNodeLength: 5000 }).collect(createDocument(`<p>${long}</p>`)).length, 1);
});
