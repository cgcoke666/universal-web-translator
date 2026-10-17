/**
 * "端上优先 + 远端兜底"的组合逻辑。
 *
 * 为什么单独抽出来：这段逻辑原本内联在 content/index.js 的整页翻译循环里，
 * 导致**划词翻译走的是另一条路径**（直接发给 background），完全绕过了内置翻译——
 * 远端一挂，划词就彻底不可用。抽成纯函数后，所有翻译入口共用同一条策略，也能单测。
 *
 * 契约：
 *  - 入参 segments 是需要翻译的文本数组；
 *  - 返回 translations 与入参等长、严格保序，翻不出来的位置为 null；
 *  - provider 是实际产出译文的引擎 id，errors 是去重后的可读错误。
 */

/**
 * 去重错误信息（同一个 provider 可能在多个批次里重复失败，界面不该刷屏）。
 * @param {Array<string|undefined|null>} errors
 * @param {number} [limit]
 */
export function dedupeErrors(errors, limit = 3) {
  const seen = new Set();
  const out = [];
  for (const raw of errors || []) {
    const text = String(raw ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 全部引擎失败时给一句能指导用户行动的话。
 *
 * 原始错误（HTTP 404 / Failed to fetch）对普通用户没有意义，必须补一句"接下来该做什么"。
 * 而且不同失败原因的处置方式完全不同，必须分开说：
 *  - 语言包下载失败 → 是网络问题，反复点下载没用，得换引擎或改善网络；
 *  - 浏览器不支持 → 升级 Chrome 或换引擎；
 *  - 其余（远端 404/被墙）→ 配置可用引擎。
 * @param {string[]} errors
 */
export function buildFailureHint(errors) {
  const detail = dedupeErrors(errors).join('；');
  const joined = `${detail}`;
  let hint;
  if (/语言包|下载|NetworkError|download/i.test(joined)) {
    hint =
      '内置翻译的语言包没能下载成功（网络受限时很常见），所以离线翻译暂时不可用；' +
      '反复点"下载语言包"通常无效。请在设置页改用需要 Key 的引擎（DeepL / OpenAI / DeepSeek），' +
      '或使用本机 Ollama——这些都不依赖 Google 的模型下载服务。';
  } else if (/不支持内置翻译|Chrome 138|unsupported/i.test(joined)) {
    hint = '当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版）。请在设置页配置 DeepL / OpenAI 等引擎。';
  } else {
    hint =
      '没有可用的翻译引擎。若显示"需下载语言包"，点悬浮球里的「提前下载语言包」后重试；' +
      '否则请在设置页配置 DeepL / OpenAI 等引擎。';
  }
  return detail ? `${hint}（${detail}）` : hint;
}

/**
 * 翻译一组分段：先端上，没翻好的部分再交给远端（background 的引擎链）。
 *
 * @param {{
 *   segments: string[],
 *   targetLang: string,
 *   sourceLang?: string,
 *   force?: boolean,
 *   onDeviceEnabled?: boolean,
 *   onDevice?: {translateBatch: (req: object) => Promise<{results: Array<string|null>, provider?: string, error?: string}>} | null,
 *   client?: {translate: (req: object) => Promise<object>} | null,
 *   onProgress?: (percent: number) => void,
 *   onPhase?: (phase: string) => void
 * }} options
 * @returns {Promise<{translations: Array<string|null>, provider: string, errors: string[], failed: boolean}>}
 */
export async function translateWithFallback(options) {
  const {
    segments,
    targetLang,
    sourceLang,
    force = false,
    onDeviceEnabled = true,
    onDevice = null,
    client = null,
    onProgress,
    onPhase
  } = options;

  const texts = Array.isArray(segments) ? segments : [];
  /** @type {Array<string|null>} */
  const translations = new Array(texts.length).fill(null);
  /** @type {string[]} */
  const errors = [];
  let provider = '';
  if (texts.length === 0) {
    return { translations, provider, errors, failed: false };
  }

  /** 还需远端处理的下标 */
  let remoteItems = texts.map((_, index) => index);

  /* ---------- 1. 端上优先：零成本、离线、文本不出设备 ---------- */
  if (onDeviceEnabled && onDevice && typeof onDevice.translateBatch === 'function') {
    try {
      const local = await onDevice.translateBatch({
        segments: texts,
        targetLang,
        sourceLang,
        onProgress,
        onPhase
      });
      if (local && Array.isArray(local.results)) {
        local.results.forEach((value, index) => {
          if (typeof value === 'string' && value.length > 0) translations[index] = value;
        });
      }
      if (local?.provider) provider = local.provider;
      if (local?.error) errors.push(local.error);
    } catch (error) {
      // 端上引擎自己应该把失败收敛成返回值，但这里不能赌它一定做到：
      // 它一抛，整条链路就断了，远端兜底根本没机会执行。
      errors.push(String(error?.message ?? error));
    }
    const done = new Set();
    translations.forEach((value, index) => {
      if (typeof value === 'string' && value) done.add(index);
    });
    remoteItems = remoteItems.filter((index) => !done.has(index));
  }

  /* ---------- 2. 远端兜底：只发端上没翻好的部分 ---------- */
  if (remoteItems.length > 0 && client && typeof client.translate === 'function') {
    let response = null;
    try {
      response = await client.translate({
        segments: remoteItems.map((index) => texts[index]),
        targetLang,
        sourceLang,
        force
      });
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
    if (response && response.ok !== false && response.result) {
      const result = response.result;
      if (!provider) provider = result.provider || '';
      remoteItems.forEach((target, position) => {
        const value = result.translations?.[position];
        if (typeof value === 'string' && value) translations[target] = value;
      });
      if (Array.isArray(result.errors)) errors.push(...result.errors);
    } else if (response) {
      errors.push(String(response.error || '翻译服务无响应'));
    }
  }

  const anyTranslated = translations.some((value) => typeof value === 'string' && value.length > 0);
  const deduped = dedupeErrors(errors);
  if (!anyTranslated) {
    // 一句都翻不出来：把"用户接下来该做什么"放在第一条，原始错误放后面
    return { translations, provider, errors: [buildFailureHint(errors), ...deduped], failed: true };
  }
  return { translations, provider, errors: deduped, failed: false };
}
