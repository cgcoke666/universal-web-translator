/**
 * 分段器单测：分段正确性直接决定"译文能不能对回原文"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleTranslated, mergePieces, segmentRecords, splitText } from '../src/content/segmenter.js';

test('splitText：英文按句号切分并保持 offset 精确', () => {
  const text = 'First sentence here. Second sentence follows! Third one?';
  const parts = splitText(text);
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.equal(text.slice(part.start, part.end).trim(), part.text, 'offset 必须能还原出原文片段');
  }
  assert.deepEqual(parts.map((p) => p.text), ['First sentence here.', 'Second sentence follows!', 'Third one?']);
});

test('splitText：中文句号/问号/感叹号同样识别', () => {
  const text = '这是第一句。这是第二句！这是第三句？最后一段';
  const parts = splitText(text);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((p) => p.text), ['这是第一句。', '这是第二句！', '这是第三句？', '最后一段']);
});

test('splitText：超长无标点文本会被硬切分且不丢字符', () => {
  const text = `${'a'.repeat(3000)}`;
  const parts = splitText(text, { hardLimit: 500 });
  assert.ok(parts.length >= 6, `应被切成多段，实际 ${parts.length}`);
  const rebuilt = parts.map((p) => text.slice(p.start, p.end)).join('');
  assert.equal(rebuilt.length, text.length);
});

test('splitText：超长中文长句在逗号处断开', () => {
  const sentence = '这是一段很长的中文内容，'.repeat(200);
  const parts = splitText(sentence, { hardLimit: 300 });
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal(sentence.slice(part.start, part.end).trim(), part.text);
  }
});

test('segmentRecords 把相邻短句合并进同一分段以减少请求', () => {
  const records = [{ recordId: 1, text: 'Hello there. How are you? I am fine.', target: { kind: 'text' } }];
  const merged = segmentRecords(records, { batchMaxChars: 1000, minTextLength: 2 });
  assert.equal(merged.length, 1);
  assert.match(merged[0].text, /Hello there\. How are you\? I am fine\./);
});

test('segmentRecords 不合并被换行/列表符号分隔的文本', () => {
  const records = [{ recordId: 1, text: 'Item one\n- Item two\nItem three', target: { kind: 'text' } }];
  const pieces = segmentRecords(records, { batchMaxChars: 1000 });
  assert.ok(pieces.length >= 2, `换行分隔的列表不应合并，实际 ${pieces.length}`);
});

test('segmentRecords 尊重字符预算，不做无限制合并', () => {
  const text = 'Sentence number one. Sentence number two. Sentence number three.';
  const pieces = segmentRecords([{ recordId: 1, text, target: { kind: 'text' } }], {
    batchMaxChars: 30
  });
  assert.ok(pieces.length > 1, '预算 30 字符时不应全部合并');
  for (const piece of pieces) assert.ok(piece.text.length <= 40);
});

test('segmentRecords 属性文本整条作为一个分段，不按句子切', () => {
  const records = [{ recordId: 7, text: 'Search the whole site now. Quickly.', target: { kind: 'attr' } }];
  const pieces = segmentRecords(records, { minTextLength: 2 });
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].text, 'Search the whole site now. Quickly.');
});

test('segmentRecords 过滤代码片段与过短文本', () => {
  const records = [
    { recordId: 1, text: 'https://example.com/some/path', target: { kind: 'text' } },
    { recordId: 2, text: 'a', target: { kind: 'text' } },
    { recordId: 3, text: 'Real content to translate.', target: { kind: 'text' } }
  ];
  const pieces = segmentRecords(records, { minTextLength: 2 });
  assert.deepEqual(pieces.map((p) => p.text), ['Real content to translate.']);
});

test('assembleTranslated 把分段译文精确回填为完整译文', () => {
  const original = 'Hello world. Goodbye world.';
  const pieces = splitText(original);
  const parts = pieces.map((piece) => ({
    start: piece.start,
    end: piece.end,
    text: piece.text === 'Hello world.' ? '你好，世界。' : piece.text === 'Goodbye world.' ? '再见，世界。' : piece.text
  }));
  assert.equal(assembleTranslated(original, parts), '你好，世界。 再见，世界。');
});

test('assembleTranslated 对乱序片段按 offset 排序后拼接', () => {
  const original = 'AAA BBB';
  const parts = [
    { start: 4, end: 7, text: '乙' },
    { start: 0, end: 3, text: '甲' }
  ];
  assert.equal(assembleTranslated(original, parts), '甲 乙');
});

test('mergePieces 只在同一记录内合并', () => {
  const records = [
    { recordId: 1, text: 'One. Two.' },
    { recordId: 2, text: 'Three. Four.' }
  ];
  const pieces = [
    { id: 1, recordId: 1, text: 'One.', start: 0, end: 4 },
    { id: 2, recordId: 1, text: 'Two.', start: 5, end: 9 },
    { id: 3, recordId: 2, text: 'Three.', start: 0, end: 6 }
  ];
  const merged = mergePieces(pieces, 100, records);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'One. Two.');
  assert.equal(merged[1].text, 'Three.');
});
