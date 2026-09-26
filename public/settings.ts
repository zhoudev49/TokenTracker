// 设置页：目前仅保留页面刷新间隔。设置保存在 localStorage，不上传。
// 本页不做任何价格 / 成本相关配置——工具只展示 token 用量与会话详情。
(function () {
  "use strict";
  const TT = window.TT;
  const I18N = window.I18N;
  const { t, getNonNegative, getSettings, saveSettings, loadMetadata, initShell, setConnection, showStatusI18n, hideStatus } = TT;

  const el: Record<string, HTMLElement | null> = {
    refreshInterval: document.getElementById("refreshInterval"),
    form: document.getElementById("settingsForm"),
  };

  (el.form as HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings({
      refreshIntervalSeconds: Math.min(3600, Math.max(5, Math.trunc(getNonNegative((el.refreshInterval as HTMLInputElement).value, 30)))),
    });
    location.href = "index.html";
  });

  (async function main() {
    try {
      await initShell({ active: "settings" });
      await loadMetadata();
      (el.refreshInterval as HTMLInputElement).value = String(getSettings().refreshIntervalSeconds);
      hideStatus();
      setConnection("online", t("status.ready"));
      I18N.onChange(() => { /* 本页无动态文案 */ });
    } catch (error) {
      console.error(error);
      setConnection("error", t("status.initFailed"));
      showStatusI18n("status.serverDown", [], true);
    }
  })();
})();
