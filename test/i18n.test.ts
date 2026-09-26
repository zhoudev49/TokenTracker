// i18n.js 的 Node 单元测试：语言检测、切换持久化、占位符替换、flatpickr locale、词典完整性。
// i18n.js 是浏览器脚本，这里用最小 DOM stub 让其可在 Node 中加载。
// 注意：编译后本文件位于 dist/test/，i18n 产物与页面文件在项目根 public/ 下，需回退两级。
"use strict";
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

const MODULE = path.join(__dirname, "..", "..", "public", "i18n.js");

function loadI18n({ browserLang = "zh-CN", stored = null }: { browserLang?: string; stored?: string | null } = {}) {
  const storage: Record<string, string> = {};
  if (stored) storage["token-tracker-lang"] = stored;
  (global as Record<string, unknown>).window = global;
  (global as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (k in storage ? storage[k] : null),
    setItem: (k: string, v: string) => { storage[k] = v; },
  };
  Object.defineProperty(global, "navigator", { value: { language: browserLang }, configurable: true });
  (global as Record<string, unknown>).document = { querySelectorAll: () => [], getElementById: () => null, documentElement: { lang: "" } };
  delete require.cache[require.resolve(MODULE)];
  require(MODULE);
  return (global as Record<string, unknown>).I18N as {
    t: (key: string, ...args: unknown[]) => string;
    switchLang: (next: string) => void;
    onChange: (fn: (next: string) => void) => void;
    getLang: () => string;
    dateTimeLocale: () => string;
    flatpickrLocale: () => { weekdays: { shorthand: string[] }; months: { longhand: string[] }; firstDayOfWeek: number } | undefined;
    dict: Record<string, Record<string, string>>;
  };
}

test("detects zh from browser language", () => {
  const I18N = loadI18n({ browserLang: "zh-CN" });
  assert.equal(I18N.getLang(), "zh");
  assert.equal(I18N.t("filter.startDate"), "开始日期");
});

test("detects en from browser language", () => {
  const I18N = loadI18n({ browserLang: "en-US" });
  assert.equal(I18N.getLang(), "en");
  assert.equal(I18N.t("filter.startDate"), "Start date");
});

test("stored preference wins over browser language", () => {
  const I18N = loadI18n({ browserLang: "zh-CN", stored: "en" });
  assert.equal(I18N.getLang(), "en");
  assert.equal(I18N.t("filter.reset"), "Reset");
});

test("switchLang persists and updates translations", () => {
  const I18N = loadI18n({ browserLang: "zh-CN" });
  assert.equal(I18N.t("sessions.records", 42), "42 条记录");
  I18N.switchLang("en");
  assert.equal(I18N.getLang(), "en");
  assert.equal(I18N.t("sessions.records", 42), "42 records");
  assert.equal((global as unknown as { localStorage: { getItem: (k: string) => string | null } }).localStorage.getItem("token-tracker-lang"), "en");
  I18N.switchLang("zh");
  assert.equal(I18N.t("sessions.records", 42), "42 条记录");
});

test("placeholder interpolation with multiple args", () => {
  const I18N = loadI18n({ browserLang: "zh-CN" });
  assert.equal(I18N.t("sync.complete", 5, 2, 100, 1), "同步完成：扫描 5 个文件，更新 2 个，写入 100 条事件，失败 1 个。");
  I18N.switchLang("en");
  assert.equal(I18N.t("sync.complete", 5, 2, 100, 1), "Sync complete: scanned 5 files, updated 2, imported 100 events, 1 failed.");
});

test("missing key falls back to zh dictionary", () => {
  const I18N = loadI18n({ browserLang: "en" });
  assert.equal(I18N.t("chart.noData"), "No data");
});

test("zh flatpickr locale", () => {
  const I18N = loadI18n({ browserLang: "zh-CN" });
  const loc = I18N.flatpickrLocale();
  assert.equal(loc!.weekdays.shorthand[0], "日");
  assert.equal(loc!.months.longhand[0], "一月");
  assert.equal(loc!.firstDayOfWeek, 1);
});

test("en flatpickr locale is undefined (library default)", () => {
  const I18N = loadI18n({ browserLang: "en-US" });
  assert.equal(I18N.flatpickrLocale(), undefined);
});

test("zh and en dictionaries have identical key sets", () => {
  const I18N = loadI18n({ browserLang: "zh-CN" });
  const zhKeys = Object.keys(I18N.dict.zh).sort();
  const enKeys = Object.keys(I18N.dict.en).sort();
  assert.deepEqual(zhKeys, enKeys);
});

test("onChange handlers are invoked with the new language", () => {
  const I18N = loadI18n({ browserLang: "zh-CN" });
  const calls: string[] = [];
  I18N.onChange((next) => calls.push(next));
  I18N.switchLang("en");
  assert.deepEqual(calls, ["en"]);
});

test("every i18n key referenced by HTML/JS exists in the dictionary", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const root = path.join(__dirname, "..", "..", "public");
  const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
  const usedKeys = new Set<string>();
  for (const file of ["index.html", "sessions.html", "session.html", "settings.html"]) {
    for (const m of read(file).matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) usedKeys.add(m[1]);
  }
  for (const file of ["common.js", "overview.js", "sessions.js", "session.js", "settings.js"]) {
    // 匹配 t("key") 与带参数的 t("key", ...) 调用，防止漏检带参数调用的键
    for (const m of read(file).matchAll(/\bt\("([a-zA-Z0-9.]+)"(?:,|\))/g)) usedKeys.add(m[1]);
  }
  const I18N = loadI18n({ browserLang: "zh-CN" });
  const zhKeys = new Set(Object.keys(I18N.dict.zh));
  const missing = [...usedKeys].filter((k) => !zhKeys.has(k));
  assert.deepEqual(missing, []);
});
