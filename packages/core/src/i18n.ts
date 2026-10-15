/**
 * The language of what Tickbird says on its pages: English, or Chinese where
 * the reader's language is Chinese. Each version sets it once from its host
 * (VS Code's display language, the terminal's locale) or from the reader's
 * own choice, and every string on a page is written in place as both:
 * t('Background', '后台').
 */
export type Language = 'en' | 'zh';

let current: Language = 'en';

export const language = (): Language => current;
export function setLanguage(next: Language): void { current = next; }

/** A locale tag (zh-cn, zh_CN.UTF-8, en-US…) as one of the two languages: Chinese for any zh, else English. */
export const languageOf = (tag: string | undefined): Language => /^zh(?:[-_.]|$)/i.test(tag ?? '') ? 'zh' : 'en';

/** The reader's choice when it names one of the two languages, else the host's locale. */
export const chooseLanguage = (choice: string | undefined, locale: string | undefined): Language =>
  choice === 'en' || choice === 'zh' ? choice : languageOf(locale);

/** The words in the page's language. */
export const t = (en: string, zh: string): string => current === 'zh' ? zh : en;

/** A count with its noun: "1 file", "3 files"; Chinese counts with a measure word, written in `zh`. */
export const count = (n: number, one: string, many: string, zh: string): string => current === 'zh' ? `${n} ${zh}` : `${n} ${n === 1 ? one : many}`;

/** How many times: "3 times", "3 次". */
export const times = (n: number): string => current === 'zh' ? `${n} 次` : `${n} times`;
