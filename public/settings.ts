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
      // initShell 自己注册的 onChange 会把状态文案重置成「连接中」，而指示灯仍是绿色，
      // 切换语言后本页就显示「连接中」+ 绿点，自相矛盾。
      // 本页没有别的动态文案，因此在语言切换后重新写回已连接状态即可。
      I18N.onChange(() => { setConnection("online", t("status.ready")); });
    } catch (error) {
      console.error(error);
      setConnection("error", t("status.initFailed"));
      showStatusI18n("status.serverDown", [], true);
    }
  })();
})();
