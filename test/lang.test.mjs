/**
 * 语言工具单测：这些判定直接决定"要不要发请求"，错一次就是一次无效调用或漏翻。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLanguage,
  estimateTranslatedLength,
  isAlreadyTarget,
  isProbablyCode,
  isTranslatableText,
  langFamily
} from '../src/shared/lang.js';

test('detectLanguage 能识别常见语言的字符集', () => {
  assert.equal(detectLanguage('Hello, this is a test of the language detector.')?.code, 'en');
  assert.equal(detectLanguage('这是一个中文句子，用于测试语言检测。')?.code, 'zh');
  assert.equal(detectLanguage('これは日本語のテストです。')?.code, 'ja');
  assert.equal(detectLanguage('이것은 한국어 테스트입니다.')?.code, 'ko');
  assert.equal(detectLanguage('Это тест на русском языке.')?.code, 'ru');
  assert.equal(detectLanguage('นี่คือการทดสอบภาษาไทย')?.code, 'th');
  assert.equal(detectLanguage('זהו מבחן בעברית')?.code, 'he');
});

test('日文汉字混排不会被误判为中文', () => {
  // 只要有假名就必须判成日语，否则中文用户会看到"已翻译"的日文原文
  const profile = detectLanguage('東京の天気は晴れです。今日は暖かい。');
  assert.equal(profile?.code, 'ja');
});

test('拉丁语系靠停用词区分', () => {
  assert.equal(detectLanguage('Der schnelle braune Fuchs springt über den faulen Hund und ist nicht müde.')?.code, 'de');
  assert.equal(detectLanguage('Le renard brun rapide saute par-dessus le chien paresseux et ne dort pas.')?.code, 'fr');
  assert.equal(detectLanguage('El zorro marrón rápido salta sobre el perro perezoso y no duerme.')?.code, 'es');
});

test('纯数字/符号/空文本返回 null', () => {
  assert.equal(detectLanguage('1234 5678 90'), null);
  assert.equal(detectLanguage('   '), null);
  assert.equal(detectLanguage('$$$ ### 42%'), null);
});

test('langFamily 把中简中繁归为一族', () => {
  assert.equal(langFamily('zh-CN'), 'zh');
  assert.equal(langFamily('zh-TW'), 'zh');
  assert.equal(langFamily('en-US'), 'en');
});

test('isAlreadyTarget 判断页面是否已经是目标语言', () => {
  assert.equal(isAlreadyTarget('这是一段足够长的中文内容，不需要再翻译一次。', 'zh-CN'), true);
  assert.equal(isAlreadyTarget('This is a long enough English paragraph, it must be translated.', 'zh-CN'), false);
  // 短文本置信度不足时不应误判为"已翻译"
  assert.equal(isAlreadyTarget('你好', 'zh-CN'), false);
});

test('isProbablyCode 拦住代码/路径/版本号，放行正常句子', () => {
  assert.equal(isProbablyCode('https://example.com/a/b'), true);
  assert.equal(isProbablyCode('/usr/local/share/man'), true);
  assert.equal(isProbablyCode('v1.2.3-beta.1'), true);
  assert.equal(isProbablyCode('const x = () => 1;'), true);
  assert.equal(isProbablyCode('function translate(text) { return text; }'), true);
  assert.equal(isProbablyCode('npm install --save-dev'), false);
  assert.equal(isProbablyCode('Hello world, this is a sentence.'), false);
  assert.equal(isProbablyCode('点击这里继续'), false);
});

test('isTranslatableText 综合过滤', () => {
  assert.equal(isTranslatableText('Hello world'), true);
  assert.equal(isTranslatableText('a'), false);
  assert.equal(isTranslatableText('42'), false);
  assert.equal(isTranslatableText('   '), false);
  assert.equal(isTranslatableText('https://example.com/x/y'), false);
});

test('estimateTranslatedLength 反映中英互译的长度变化', () => {
  const english = 'a'.repeat(100);
  const chinese = '中'.repeat(100);
  assert.ok(estimateTranslatedLength(english, 'zh-CN') < english.length);
  assert.ok(estimateTranslatedLength(chinese, 'en') > chinese.length);
});
