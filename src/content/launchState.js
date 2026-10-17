/**
 * 悬浮球 / 控制面板的"启动状态"推导。
 *
 * 为什么要单独一个纯函数模块：
 *  "加速器式"交互的价值全在**状态是否说人话**——待命、离线就绪、需下载语言包、
 *  翻译中、仅远端可用。这些判断散落在 DOM 代码里既容易写错也无法测试，
 *  而这类"按钮文案和实际能力对不上"的问题，用户一眼就会看出来。
 *
 * 输入是 content 侧已有的状态（设置、翻译状态、端上探测结果），输出是
 * 指示灯颜色 / 状态文案 / 主按钮文案 / 主按钮要做什么，全部可单测。
 *
 * @typedef {'standby'|'ready'|'needs-pack'|'preparing'|'translating'|'ready-remote'|'unavailable'} LaunchStatus
 */

/** 状态 → 指示灯配色（与 ui.js 的 CSS 类一一对应） */
export const INDICATOR_TONES = Object.freeze({
  standby: 'idle',
  ready: 'ok',
  'ready-remote': 'ok',
  'needs-pack': 'warn',
  preparing: 'busy',
  translating: 'busy',
  unavailable: 'off'
});

/**
 * 把端上探测结果收敛成几个事实。
 * `status` 为空表示"还没探测过"，必须与"探测过但不可用"区分开：
 * 前者应该显示中性的待命态，后者才该给出结论。把两者混起来会导致
 * 面板在还没探测前就亮着绿灯（或红着灯），用户会觉得状态在骗人。
 * @param {{supported?: boolean, status?: string, enabled?: boolean} | null | undefined} probe
 */
function readProbe(probe) {
  const known = Boolean(probe) && Boolean(probe.status);
  const enabled = probe?.enabled !== false;
  const supported = Boolean(probe?.supported);
  const status = String(probe?.status ?? '');
  return {
    known,
    enabled,
    supported,
    /** 语言包已就绪：可以立刻离线翻译 */
    ready: status === 'available',
    /** 语言包缺失但可下载 */
    downloadable: status === 'downloadable' || status === 'downloading',
    /** 探测正在进行，结论未知 */
    probing: status === 'probing'
  };
}

/**
 * 推导当前应该展示的启动状态。
 *
 * 注意"是否有远端兜底"是硬前提：如果用户只勾了内置翻译、又没有任何远端引擎，
 * 那么语言包没就绪时点按钮会无事发生，此时应该直接说不可用，而不是假装能启动。
 *
 * @param {{
 *   translated?: boolean,
 *   translating?: boolean,
 *   busy?: boolean,
 *   enableOnDevice?: boolean,
 *   remoteFallback?: boolean,
 *   probe?: {supported?: boolean, status?: string, enabled?: boolean} | null,
 *   downloadPercent?: number | null
 * }} input
 * @returns {{status: LaunchStatus, indicator: string, label: string, detail: string,
 *            buttonText: string, buttonDisabled: boolean, action: string}}
 */
export function computeLaunchState(input = {}) {
  const {
    translated = false,
    translating = false,
    busy = false,
    enableOnDevice = true,
    remoteFallback = true,
    probe = null,
    downloadPercent = null
  } = input;

  const device = readProbe({ ...probe, enabled: enableOnDevice });
  const working = Boolean(translating) || Boolean(busy);

  /* ---------- 1. 工作态优先：正在跑的时候不要显示别的 ---------- */
  if (working) {
    const downloading = downloadPercent !== null && downloadPercent !== undefined;
    return {
      status: 'preparing',
      indicator: 'busy',
      label: downloading ? '下载语言包' : '翻译中',
      detail: downloading
        ? `正在下载语言包 ${downloadPercent}%…首次使用需要几 MB`
        : device.ready
          ? '正在使用内置翻译（离线），文本不离开本机'
          : '正在翻译…',
      buttonText: downloading ? `正在下载语言包 ${downloadPercent}%` : '翻译中…',
      buttonDisabled: true,
      action: 'none'
    };
  }

  /* ---------- 2. 已翻译：主按钮变成还原 ---------- */
  if (translated) {
    return {
      status: 'ready',
      indicator: 'ok',
      label: '已翻译',
      detail: '再点一次可还原原文',
      buttonText: '还原原文',
      buttonDisabled: false,
      action: 'restore'
    };
  }

  /* ---------- 3. 内置翻译就绪：真正的一键离线启动 ---------- */
  if (device.enabled && device.supported && device.ready) {
    return {
      status: 'ready',
      indicator: 'ok',
      label: '离线就绪',
      detail: '点一下即可翻译，文本不离开本机',
      buttonText: '开启翻译',
      buttonDisabled: false,
      action: 'translate'
    };
  }

  /* ---------- 4. 语言包缺失但可下载 ---------- */
  if (device.enabled && device.supported && device.downloadable) {
    if (!remoteFallback) {
      // 没有远端兜底时，必须先下载语言包，否则点了也没结果
      return {
        status: 'needs-pack',
        indicator: 'warn',
        label: '需下载语言包',
        detail: '下载后即可离线翻译，只需一次',
        buttonText: '下载语言包并翻译',
        buttonDisabled: false,
        action: 'download-and-translate'
      };
    }
    return {
      status: 'needs-pack',
      indicator: 'warn',
      label: '需下载语言包',
      detail: '现在翻译会走远端通道；下载后可离线、更私密',
      buttonText: '开启翻译',
      buttonDisabled: false,
      action: 'translate'
    };
  }

  /* ---------- 5. 还没探测出结论：保持中性待命，不假装就绪也不报错 ---------- */
  if (!device.known || device.probing) {
    return {
      status: 'standby',
      indicator: 'idle',
      label: '待命',
      detail: remoteFallback ? '点一下即可翻译；打开面板会检测内置翻译是否就绪' : '尚未检测到可用的翻译引擎',
      buttonText: remoteFallback ? '开启翻译' : '打开设置',
      buttonDisabled: false,
      action: remoteFallback ? 'translate' : 'settings'
    };
  }

  /* ---------- 6. 内置翻译不可用，但有远端兜底 ---------- */
  if (remoteFallback) {
    const unsupportedEnv = !device.supported;
    return {
      status: 'ready-remote',
      indicator: 'ok',
      label: unsupportedEnv ? '远端就绪' : '远端通道',
      detail: unsupportedEnv
        ? '当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版），将使用远端引擎'
        : '将使用远端引擎翻译',
      buttonText: '开启翻译',
      buttonDisabled: false,
      action: 'translate'
    };
  }

  /* ---------- 7. 既没有端上也没有远端兜底：明确说清楚 ---------- */
  return {
    status: 'unavailable',
    indicator: 'off',
    label: '不可用',
    detail: '没有可用的翻译引擎：请开启内置翻译，或在设置里配置远端引擎',
    buttonText: '打开设置',
    buttonDisabled: false,
    action: 'settings'
  };
}

/**
 * 端上探测结果 → 面板上显示的引擎名。
 * @param {{provider?: string, enableOnDevice?: boolean}} input
 */
export function describeEngine(input = {}) {
  const provider = String(input.provider ?? '');
  if (provider === 'on-device') return '内置翻译 · 离线';
  if (provider === 'microsoft') return 'Microsoft 通道';
  if (provider === 'google-free') return 'Google 通道';
  if (provider === 'deepl') return 'DeepL';
  if (provider === 'ollama') return 'Ollama · 本地';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'custom') return '自定义网关';
  if (provider === 'cache') return '本地缓存';
  if (provider) return provider;
  return input.enableOnDevice === false ? '远端通道' : '内置翻译优先';
}
