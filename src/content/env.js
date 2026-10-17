/**
 * 运行环境探测与注入 CSS。
 *
 * 为什么单独一个文件：
 *  1. manifest 里 `all_frames: true` 会让脚本进入所有 iframe。子 frame 不应该独立
 *     翻译整页（会和父页重复请求、重复渲染），因此需要一个可靠的"是否顶层"判断；
 *  2. 译文样式必须走扩展自己的 CSS 文件，避免被站点 CSP 拦截 style 注入。
 */

/** 是否顶层窗口。注意 sandboxed iframe 里访问 top 可能抛异常。 */
export const IS_TOP_FRAME = (() => {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
})();

/** 当前 frame 的 URL（about:blank / srcdoc 情况下可能为空） */
export const FRAME_URL = (() => {
  try {
    return location.href;
  } catch {
    return '';
  }
})();

/**
 * 注入译文样式表。使用 chrome.runtime.getURL + <link>，
 * 这样样式属于扩展上下文，不受页面 CSP / 站点重置样式影响。
 * @param {(path: string) => string} resolveUrl
 */
export function injectStyles(resolveUrl) {
  if (document.getElementById('dsh-translator-style')) return;
  const link = document.createElement('link');
  link.id = 'dsh-translator-style';
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = resolveUrl('content.css');
  (document.head || document.documentElement)?.appendChild(link);
}

/**
 * 判断当前 frame 是否需要参与整页翻译。
 * 规则：顶层 frame 永远参与；子 frame 只在"看起来像正文"时参与（宽度足够且非同源小挂件）。
 */
export function shouldHandleFrame() {
  if (IS_TOP_FRAME) return true;
  try {
    const rect = document.documentElement?.getBoundingClientRect?.();
    if (!rect) return false;
    const area = rect.width * rect.height;
    // 太小的 iframe 一般是广告/统计/按钮挂件，不翻译
    return rect.width >= 320 && area >= 200_000;
  } catch {
    return false;
  }
}
