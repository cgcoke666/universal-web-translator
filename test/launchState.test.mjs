/**
 * 悬浮球/面板"启动状态"推导单测。
 *
 * 这个状态机决定用户看到的每一个字（指示灯颜色、状态名、按钮文案），
 * 一旦推导错就会出现"显示离线就绪但点了没反应"这种最伤信任的问题，
 * 因此每个分支都要有用例钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDICATOR_TONES, computeLaunchState, describeEngine } from '../src/content/launchState.js';

/** 常用探测结果的简写 */
const AVAILABLE = { supported: true, status: 'available' };
const DOWNLOADABLE = { supported: true, status: 'downloadable' };
const UNAVAILABLE = { supported: true, status: 'unavailable' };
const UNSUPPORTED = { supported: false, status: 'unsupported' };

/* ------------------------------------------------------------------ *
 * 待命 / 工作态
 * ------------------------------------------------------------------ */

test('待命：还没探测出结果时是中性的 idle，且按钮仍然可用', () => {
  const state = computeLaunchState({ probe: null, remoteFallback: true });
  assert.equal(state.status, 'standby');
  assert.equal(state.indicator, 'idle');
  assert.equal(state.buttonDisabled, false);
  assert.equal(state.action, 'translate');
  // 关键：探测前不能显示"就绪"的绿灯，否则状态在骗人
  assert.notEqual(state.indicator, 'ok');
});

test('探测中：结论未知时保持待命，既不亮绿灯也不报错', () => {
  const state = computeLaunchState({ probe: { supported: true, status: 'probing' } });
  assert.equal(state.status, 'standby');
  assert.equal(state.indicator, 'idle');
  assert.equal(state.buttonDisabled, false);
});

test('翻译中：按钮禁用并显示"翻译中…"，不再引导用户重复点击', () => {
  const state = computeLaunchState({ translating: true, probe: AVAILABLE });
  assert.equal(state.status, 'preparing');
  assert.equal(state.indicator, 'busy');
  assert.equal(state.buttonText, '翻译中…');
  assert.equal(state.buttonDisabled, true);
  assert.equal(state.action, 'none');
});

test('下载语言包中：按钮显示百分比，且这是"禁用"而不是可重复点击', () => {
  const state = computeLaunchState({ busy: true, probe: DOWNLOADABLE, downloadPercent: 42 });
  assert.equal(state.label, '下载语言包');
  assert.match(state.buttonText, /42%/);
  assert.equal(state.buttonDisabled, true);
});

/* ------------------------------------------------------------------ *
 * 离线就绪（最重要的一条路径）
 * ------------------------------------------------------------------ */

test('离线就绪：一键开启，提示文本点明隐私优势', () => {
  const state = computeLaunchState({ probe: AVAILABLE, enableOnDevice: true, remoteFallback: true });
  assert.equal(state.status, 'ready');
  assert.equal(state.indicator, 'ok');
  assert.equal(state.label, '离线就绪');
  assert.equal(state.buttonText, '开启翻译');
  assert.equal(state.action, 'translate');
  assert.match(state.detail, /不离开本机/);
});

test('已翻译：主按钮变为还原，且不再显示"开启翻译"', () => {
  const state = computeLaunchState({ translated: true, probe: AVAILABLE });
  assert.equal(state.buttonText, '还原原文');
  assert.equal(state.action, 'restore');
  assert.equal(state.buttonDisabled, false);
});

/* ------------------------------------------------------------------ *
 * 需下载语言包：有/无远端兜底行为不同
 * ------------------------------------------------------------------ */

test('需下载 + 有远端兜底：仍然允许直接翻译，并说明会走远端', () => {
  const state = computeLaunchState({ probe: DOWNLOADABLE, remoteFallback: true });
  assert.equal(state.status, 'needs-pack');
  assert.equal(state.indicator, 'warn');
  assert.equal(state.action, 'translate', '不能把用户卡在下载上');
  assert.match(state.detail, /远端通道/);
});

test('需下载 + 无远端兜底：必须先下载，按钮改为"下载语言包并翻译"', () => {
  const state = computeLaunchState({ probe: DOWNLOADABLE, remoteFallback: false });
  assert.equal(state.action, 'download-and-translate');
  assert.equal(state.buttonText, '下载语言包并翻译');
  assert.equal(state.buttonDisabled, false);
});

/* ------------------------------------------------------------------ *
 * 降级与不可用
 * ------------------------------------------------------------------ */

test('浏览器不支持内置翻译但有兜底：如实说明并给出远端就绪', () => {
  const state = computeLaunchState({ probe: UNSUPPORTED, remoteFallback: true });
  assert.equal(state.status, 'ready-remote');
  assert.equal(state.indicator, 'ok');
  assert.equal(state.label, '远端就绪');
  assert.match(state.detail, /Chrome 138\+/);
  assert.equal(state.action, 'translate');
});

test('语言对在端上不可用：走远端通道而不是报错', () => {
  const state = computeLaunchState({ probe: UNAVAILABLE, remoteFallback: true });
  assert.equal(state.status, 'ready-remote');
  assert.equal(state.action, 'translate');
});

test('用户在设置里关掉内置翻译：不再提示"离线就绪"', () => {
  const state = computeLaunchState({ probe: AVAILABLE, enableOnDevice: false, remoteFallback: true });
  assert.equal(state.status, 'ready-remote');
  assert.equal(state.label, '远端通道');
});

test('端上与远端都不可用：明确告知并引导去设置，而不是装作能用', () => {
  const state = computeLaunchState({ probe: UNAVAILABLE, remoteFallback: false });
  assert.equal(state.status, 'unavailable');
  assert.equal(state.indicator, 'off');
  assert.equal(state.buttonText, '打开设置');
  assert.equal(state.action, 'settings');
});

test('每个状态都有对应的指示灯配色，不会漏配导致样式失效', () => {
  const statuses = [
    computeLaunchState({}),
    computeLaunchState({ translated: true }),
    computeLaunchState({ translating: true }),
    computeLaunchState({ probe: AVAILABLE }),
    computeLaunchState({ probe: DOWNLOADABLE, remoteFallback: false }),
    computeLaunchState({ probe: UNSUPPORTED }),
    computeLaunchState({ remoteFallback: false, probe: UNAVAILABLE })
  ];
  for (const state of statuses) {
    assert.ok(INDICATOR_TONES[state.status], `${state.status} 缺少指示灯配色`);
    assert.equal(state.indicator, INDICATOR_TONES[state.status]);
    assert.ok(state.label && state.buttonText, `${state.status} 缺少文案`);
  }
});

/* ------------------------------------------------------------------ *
 * 引擎标识
 * ------------------------------------------------------------------ */

test('describeEngine：把引擎 id 讲成用户看得懂的名字', () => {
  assert.equal(describeEngine({ provider: 'on-device' }), '内置翻译 · 离线');
  assert.equal(describeEngine({ provider: 'microsoft' }), 'Microsoft 通道');
  assert.equal(describeEngine({ provider: 'cache' }), '本地缓存');
  assert.equal(describeEngine({ provider: 'ollama' }), 'Ollama · 本地');
  assert.equal(describeEngine({ provider: 'mystery' }), 'mystery');
  assert.equal(describeEngine({}), '内置翻译优先');
  assert.equal(describeEngine({ enableOnDevice: false }), '远端通道');
});
