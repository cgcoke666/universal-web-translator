/**
 * Chrome 内置 Translator API 的测试桩件。
 *
 * 真实环境里 `Translator` 由 Chrome 注入；测试里我们手工造一个形状一致的
 * 假实现，覆盖"能力探测 / 语言包状态 / 下载进度 / 各类错误"全部分支。
 * 这样端上路径的核心逻辑（实例复用、串行化、降级判定）都能在 Node 里验证，
 * 不必真的开一个 Chrome 138 去点按钮。
 */

/**
 * @param {{
 *   available?: string | string[],
 *   translate?: (text: string, callIndex: number, sourceLanguage: string, targetLanguage: string) => unknown,
 *   createError?: Error | null,
 *   downloadEvents?: Array<{loaded: number, total: number}>,
 *   availabilityThrows?: Error | null,
 *   hasAvailability?: boolean
 * }} [options]
 */
export function createTranslatorStub(options = {}) {
  const {
    available = 'available',
    translate,
    createError = null,
    createHangs = false,
    downloadEvents = [],
    availabilityThrows = null,
    hasAvailability = true
  } = options;

  const state = {
    /** 每次 create 的入参 */
    createCalls: [],
    /** 每次 translate 收到的文本 */
    translateCalls: [],
    /** 被 destroy 的实例数 */
    destroyed: 0,
    /** 探测调用次数 */
    availabilityCalls: [],
    /** 当前正在执行的 translate 数量（用于验证串行化） */
    activeTranslations: 0,
    maxActiveTranslations: 0,
    /** 每次探测按顺序取出一个返回值 */
    availabilityQueue: Array.isArray(available) ? [...available] : null
  };

  const api = {
    async availability({ sourceLanguage, targetLanguage }) {
      state.availabilityCalls.push(`${sourceLanguage}>${targetLanguage}`);
      if (availabilityThrows) throw availabilityThrows;
      if (state.availabilityQueue && state.availabilityQueue.length > 0) {
        return state.availabilityQueue.shift();
      }
      return Array.isArray(available) ? 'available' : available;
    },
    async create({ sourceLanguage, targetLanguage, monitor }) {
      state.createCalls.push(`${sourceLanguage}>${targetLanguage}`);
      // 模拟语言包下载进度回调
      if (monitor && downloadEvents.length > 0) {
        const fakeMonitor = {
          addEventListener(type, listener) {
            if (type !== 'downloadprogress') return;
            for (const event of downloadEvents) listener(event);
          }
        };
        monitor(fakeMonitor);
      }
      if (createError) throw createError;
      // 模拟"网络受限时下载既不给结果也不报错"：create 永远不 settle
      if (createHangs) return new Promise(() => {});
      return {
        sourceLanguage,
        targetLanguage,
        async translate(text) {
          const callIndex = state.translateCalls.length;
          state.translateCalls.push(text);
          state.activeTranslations += 1;
          state.maxActiveTranslations = Math.max(state.maxActiveTranslations, state.activeTranslations);
          try {
            // 真正让出事件循环，暴露并发的调用顺序问题
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (translate) return translate(text, callIndex, sourceLanguage, targetLanguage);
            return `[${targetLanguage}]${text}`;
          } finally {
            state.activeTranslations -= 1;
          }
        },
        async destroy() {
          state.destroyed += 1;
        }
      };
    }
  };

  if (!hasAvailability) delete api.availability;

  return {
    api,
    state,
    install() {
      globalThis.Translator = api;
    },
    uninstall() {
      delete globalThis.Translator;
    }
  };
}

/** 造一个符合 DOMException 形状的错误（测试里不需要真的 DOMException） */
export function domError(name, message = '') {
  const error = new Error(message || name);
  error.name = name;
  return error;
}
