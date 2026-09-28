// 前端全局类型声明（classic script 契约：window.TT / window.I18N / vendor 库全局）。
// 本文件为 script 级 .d.ts（无 import/export），直接向全局作用域合并类型。

interface I18NAPI {
  t(key: string, ...args: unknown[]): string;
  switchLang(next: string): void;
  onChange(fn: (next: string) => void): void;
  applyStatic(): void;
  getLang(): "zh" | "en";
  dateTimeLocale(): "zh-CN" | "en-US";
  /** 中文返回 locale，英文返回 null（调用方应省略 locale 字段，而不是传 undefined）。 */
  flatpickrLocale(): FlatpickrLocale | null;
  lang: string;
  dict: Record<string, Record<string, string>>;
}

interface FlatpickrLocale {
  weekdays: { shorthand: string[]; longhand: string[] };
  months: { shorthand: string[]; longhand: string[] };
  rangeSeparator: string;
  weekAbbreviation: string;
  scrollTitle: string;
  toggleTitle: string;
  firstDayOfWeek: number;
}

interface FlatpickrConfig {
  locale?: unknown;
  dateFormat?: string;
  altInput?: boolean;
  altFormat?: string;
  allowInput?: boolean;
  onChange?: () => void;
}

interface FlatpickrInstance {
  setDate(value: string | Date | number | null, triggerChange?: boolean): void;
  clear(triggerChange?: boolean): void;
  set(key: string, value: unknown): void;
  altInput?: HTMLInputElement;
}

type FlatpickrFactory = (el: HTMLElement, config: FlatpickrConfig) => FlatpickrInstance;

interface TomSelectConfig {
  allowEmptyOption?: boolean;
  onChange?: (value: string) => void;
}

interface TomSelectInstance {
  /** 第二个参数是 silent：传 true 不派发 change 事件。 */
  setValue(value: string, silent?: boolean): void;
  clear(silent?: boolean): void;
  clearOptions(): void;
  addOption(option: { value: string; text: string }): void;
  getValue(): string | string[];
  /** 内部选项 store：TomSelect 只把「已选中」的项同步回原生 <select>，
   *  非选中项只能从这里查到（用于存在性判断）。 */
  readonly options: Record<string, unknown>;
}

type TomSelectFactory = new (el: HTMLElement, config: TomSelectConfig) => TomSelectInstance;

interface ChartInstance {
  data: any;
  options: any;
  update(): void;
}

type ChartFactory = new (ctx: HTMLElement | null, config: Record<string, unknown>) => ChartInstance;

interface TokenTrackerAPI {
  loadSettings(): Record<string, unknown>;
  saveSettings(next: Record<string, unknown>): void;
  getSettings(): {
    refreshIntervalSeconds: number;
    modelPricing: Record<string, unknown>;
  };
  toNumber(value: unknown): number;
  getNonNegative(value: unknown, fallback: number): number;
  formatTokens(value: unknown): string;
  formatPercent(value: unknown): string;
  formatTime(value: unknown): string;
  abbreviate(value: unknown): string;
  createCell(text: unknown, className?: string, title?: string): HTMLTableCellElement;
  t(key: string, ...args: unknown[]): string;
  loadFilterState(): Record<string, string>;
  saveFilterState(state: Record<string, string>): void;
  setSavedFilter(patch: Record<string, string>): void;
  renderNav(activePage: string): void;
  renderFilterBar(onChange: (() => void) | null): void;
  initShell(options: { active: string; filterBar?: boolean; onChange?: (() => void) | null }): Promise<void>;
  loadMetadata(): Promise<void>;
  populateSelect(select: HTMLSelectElement, values: Array<string | { value: string; label: string }>, allLabel: string): void;
  getFilterParams(): URLSearchParams;
  getPricingParam(): string;
  getFilterOptions(): { projects: Array<string | { value: string; label: string }>; models: Array<string | { value: string; label: string }>; platforms: Array<{ value: string; label: string }> };
  getPlatformLabel(platformId: string): string;
  setConnection(state: string, text: string): void;
  showStatus(message: string, isError?: boolean): void;
  showStatusI18n(key: string, args?: unknown[], isError?: boolean): void;
  hideStatus(): void;
  apiFetch(url: string): Promise<any>;
  runSync(options?: { onComplete?: () => Promise<void>; silent?: boolean }): Promise<void>;
  triggerSync(onChange?: (() => void) | null): Promise<void>;
  triggerSyncBackground(onChange?: (() => void) | null): Promise<void>;
  /** renderFn 会收到 isCurrent()，应在**渲染 DOM 之前**调用它丢弃过期响应。 */
  makeLoader(renderFn: (isCurrent: () => boolean, ...args: any[]) => Promise<any>): (...args: any[]) => Promise<any>;
  setFilterValue(id: string, value: string): boolean;
  clearProjectFilter(): void;
}

interface Window {
  TT: TokenTrackerAPI;
  I18N: I18NAPI;
  flatpickr?: FlatpickrFactory;
  TomSelect?: TomSelectFactory;
}

declare var Chart: ChartFactory;
