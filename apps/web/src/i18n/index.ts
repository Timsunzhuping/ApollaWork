/**
 * 轻量 i18n（生产 P2）：不引第三方库，仅 zustand + 两个语言包。
 *
 * - 语言检测：localStorage `apolla.locale` → `navigator.language` → 默认 zh-CN
 * - 插值：模板写 `{n}`，调用 `t('task.tokens', { n: 123 })`
 * - 缺失 key：开发模式 console.warn 并回落到 key 本身（便于暴露漏翻）；
 *   生产模式回落到 zh-CN 文案（用户永远不会看到裸 key）
 * - 类型安全：key 从 zh-CN 语言包推导，拼错编译期即报错
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { zhCN } from './locales/zh-CN';
import { enUS } from './locales/en-US';

export const LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];

/** 全部可用文案 key（来源：zh-CN 语言包）。 */
export type I18nKey = keyof typeof zhCN;

/** 插值参数：模板里的 `{name}` 会被替换为对应值。 */
export type TParams = Record<string, string | number>;

export type TFunction = (key: I18nKey, params?: TParams) => string;

const MESSAGES: Record<Locale, Record<I18nKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

const STORAGE_KEY = 'apolla.locale';
const DEFAULT_LOCALE: Locale = 'zh-CN';

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** localStorage → navigator.language → 默认 zh-CN。 */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* 隐私模式下 localStorage 可能抛异常，忽略 */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  if (isLocale(nav)) return nav;
  // 只匹配到语言子标签时按前缀归一（如 en、en-GB → en-US；zh-Hans → zh-CN）
  const prefix = nav.toLowerCase().split('-')[0];
  if (prefix === 'en') return 'en-US';
  if (prefix === 'zh') return 'zh-CN';
  return DEFAULT_LOCALE;
}

/** 同步 <html lang>，让浏览器/读屏软件拿到正确语言。 */
function syncDocumentLang(locale: Locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* 忽略写入失败 */
    }
    syncDocumentLang(locale);
    set({ locale });
  },
}));

syncDocumentLang(useI18nStore.getState().locale);

/** 把 `{name}` 占位符替换成实参；缺参数时保留原样，便于发现问题。 */
function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : raw,
  );
}

/** 按指定语言取文案（`useI18n` 与全局 `t` 的共同实现）。 */
export function translate(locale: Locale, key: I18nKey, params?: TParams): string {
  let template: string | undefined = MESSAGES[locale]?.[key];
  if (template === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] 缺失文案：${locale} / ${String(key)}`);
      template = String(key);
    } else {
      template = zhCN[key] ?? String(key);
    }
  }
  return interpolate(template, params);
}

/** 当前语言。 */
export function getLocale(): Locale {
  return useI18nStore.getState().locale;
}

/** 切换语言（立即生效并写入 localStorage）。 */
export function setLocale(locale: Locale): void {
  useI18nStore.getState().setLocale(locale);
}

/**
 * 组件外取文案（如 api.ts 的错误信息）。
 * 组件内请用 `useI18n()`，否则语言切换后不会重渲染。
 */
export const t: TFunction = (key, params) => translate(getLocale(), key, params);

/** 组件内使用：语言变化时自动重渲染。 */
export function useI18n(): { t: TFunction; locale: Locale; setLocale: (l: Locale) => void } {
  const locale = useI18nStore((s) => s.locale);
  const setLocaleAction = useI18nStore((s) => s.setLocale);
  const translateBound = useCallback<TFunction>(
    (key, params) => translate(locale, key, params),
    [locale],
  );
  return { t: translateBound, locale, setLocale: setLocaleAction };
}
