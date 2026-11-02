window.__ModuleLoader__.load({
  id: "dsh-antigravity",
  factory(require) {
    const React = require("react");
    const { createPortal } = require("react-dom");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const STYLE_ID = "dsh-antigravity-settings-style";
    const API = "/antigravity/api";
    const NS = "dsh-antigravity";
    const ANTIGRAVITY_SVG_PATH =
      "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z";

    const zh = {
      pageDesc: "登录 Google Antigravity / Cloud Code Assist，查看号池总监控与各账户独立额度。",
      currentAccount: "当前账号",
      login: "登录",
      loggingIn: "登录中...",
      refresh: "刷新",
      refreshing: "刷新中...",
      logout: "退出",
      loading: "Loading...",
      notSignedIn: "未登录",
      notSignedInDesc: "点击右上角登录后，会在浏览器中完成 Google OAuth，登录成功后这里会显示 quota。",
      noQuotaDesc: "暂无 quota 数据，点击刷新。",
      fetchingQuota: "正在获取 quota...",
      quota: "额度",
      resetPrefix: "重置: {time}",
      resetUnavailable: "重置: n/a",
      resetNow: "现在",
      timeDayHour: "{days}天 {hours}时",
      timeHourMin: "{hours}h {minutes}m",
      timeMin: "{minutes}m",
      updatedAt: "更新时间：{time}",
      modelSelector: "模型选择器",
      modelSelectorDesc: "勾选后会出现在 DSH 的 Antigravity 模型列表中。",
      selectAll: "全选",
      unselectAll: "全不选",
      loadingModels: "正在加载模型配置...",
      modelSelectorNote: "勾选即自动保存。重新打开模型选择器即可看到最新列表；运行中的旧会话不受影响。",
      quotaLabel: "额度: {percent}%",
      quotaBadgeTooltip: "Google Antigravity 额度: 剩余 {percent}% · 重置时间 {reset}",
      loginFailed: "登录失败",
    };

    const en = {
      pageDesc: "Sign in to Google Antigravity / Cloud Code Assist and monitor pool totals and per-account quotas.",
      currentAccount: "Current Account",
      login: "Sign in",
      loggingIn: "Signing in...",
      refresh: "Refresh",
      refreshing: "Refreshing...",
      logout: "Sign out",
      loading: "Loading...",
      notSignedIn: "Not signed in",
      notSignedInDesc: "Click Sign in to complete Google OAuth in your browser. Quotas will appear here after login.",
      noQuotaDesc: "No quota data yet. Click Refresh.",
      fetchingQuota: "Fetching quota data...",
      quota: "Quota",
      resetPrefix: "Reset: {time}",
      resetUnavailable: "Reset: n/a",
      resetNow: "now",
      timeDayHour: "{days}d {hours}h",
      timeHourMin: "{hours}h {minutes}m",
      timeMin: "{minutes}m",
      updatedAt: "Updated at: {time}",
      modelSelector: "Model Selector",
      modelSelectorDesc: "Checked models will appear in DSH's Antigravity model list.",
      selectAll: "Select all",
      unselectAll: "Deselect all",
      loadingModels: "Loading model configuration...",
      modelSelectorNote: "Changes are saved automatically. Reopen the model picker to see the updated list; running sessions are unaffected.",
      quotaLabel: "Quota: {percent}%",
      quotaBadgeTooltip: "Google Antigravity Quota: {percent}% remaining · Resets in {reset}",
      loginFailed: "Login failed",
    };

    function createTranslator(ctx) {
      const boundT = (ctx && ctx.locale && typeof ctx.locale.bind === "function")
        ? ctx.locale.bind(NS)
        : null;

      return function t(key, params) {
        if (boundT) {
          try {
            const res = boundT(key, params);
            if (res && res !== key && res !== `${NS}.${key}`) return res;
          } catch (_) {}
        }
        const active = (ctx && ctx.locale && typeof ctx.locale.getLocale === "function")
          ? ctx.locale.getLocale()?.active
          : null;
        const isZh = active ? active.startsWith("zh") : (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
        const dict = isZh ? zh : en;
        let text = dict[key] || en[key] || zh[key] || key;
        if (params && typeof params === "object") {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return text;
      };
    }

    function patchNavIcon() {
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent && span.textContent.trim() === "Antigravity") {
          const btn = span.closest("button");
          if (btn) {
            const svg = btn.querySelector("svg");
            if (svg) {
              svg.setAttribute("viewBox", "0 0 110 113");
              svg.setAttribute("width", "16");
              svg.setAttribute("height", "16");
              svg.setAttribute("fill", "none");
              const path = svg.querySelector("path");
              if (!path || path.getAttribute("d") !== ANTIGRAVITY_SVG_PATH) {
                svg.innerHTML = `<path d="${ANTIGRAVITY_SVG_PATH}" fill="currentColor"/>`;
              }
            }
          }
        }
      }
    }

    function initNavObserver() {
      patchNavIcon();
      if (window.__antigravityNavObserver) return;
      const observer = new MutationObserver(() => {

      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      window.addEventListener("click", patchNavIcon, true);
      window.setInterval(patchNavIcon, 300);
      window.__antigravityNavObserver = observer;
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dsha-wrap{box-sizing:border-box;width:100%;max-width:760px;padding:0 0 24px;color:var(--dsw-alias-label-primary,#111827)}
.dsha-page-head{display:flex;align-items:center;gap:10px}
.dsha-brand-icon{color:var(--dsw-alias-label-primary,#111827);flex-shrink:0}
.dsha-page-title{margin:0;color:var(--dsw-alias-label-primary,#111827);font-size:20px;font-weight:700;line-height:28px}
.dsha-page-desc{margin:8px 0 18px;color:var(--dsw-alias-label-secondary,#8b93a1);font-size:13px;line-height:20px}
.dsha-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;padding:16px;box-shadow:none}
.dsha-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dsha-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;color:var(--dsw-alias-label-primary,#111827)}
.dsha-ok{width:18px;height:18px;border-radius:999px;border:2px solid var(--dsw-alias-state-success-primary,#10b981);position:relative;flex:0 0 auto}
.dsha-ok:after{content:"";position:absolute;left:4px;top:2px;width:6px;height:9px;border:solid var(--dsw-alias-state-success-primary,#10b981);border-width:0 2px 2px 0;transform:rotate(45deg)}
.dsha-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsha-btn{border:1px solid var(--dsw-alias-border-l2,#d7dce3);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111827);border-radius:10px;padding:7px 12px;font-size:13px;line-height:18px;cursor:pointer}
.dsha-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f7f8fa)}
.dsha-btn:disabled{cursor:not-allowed;opacity:.55}
.dsha-btn-primary{border-color:var(--dsw-alias-brand-primary,#111827);background:var(--dsw-alias-brand-primary,#111827);color:var(--dsw-alias-bg-overlay,#fff)}
.dsha-btn-primary:hover{filter:brightness(1.12)}
.dsha-account{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding:12px;border:1px solid var(--dsw-alias-border-l1,#eef1f5);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fafbfc);color:var(--dsw-alias-label-secondary,#4b5563)}
.dsha-email{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:650;min-width:0}
.dsha-email-mark{width:16px;height:12px;border:1.8px solid currentColor;border-radius:3px;opacity:.65;position:relative;flex:0 0 auto}
.dsha-email-mark:before{content:"";position:absolute;left:1px;right:1px;top:1px;height:7px;border-bottom:1.8px solid currentColor;transform:skewY(-28deg)}
.dsha-email-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef2ff);color:var(--dsw-alias-brand-primary,#3f46d8);border:1px solid var(--dsw-alias-border-l1,#dfe5ff);padding:4px 9px;font-size:12px;font-weight:800;letter-spacing:.02em}
.dsha-diamond{width:8px;height:8px;border-radius:2px;background:var(--dsw-alias-brand-primary,#4f5bf6);transform:rotate(45deg)}
.dsha-quota-title{margin:16px 0 6px;color:var(--dsw-alias-label-primary,#111827);font-size:14px;font-weight:700}
.dsha-quota-group{margin-top:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2,#fafbfc);border:1px solid var(--dsw-alias-border-l1,#eef1f5);border-radius:10px}
.dsha-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.dsha-group-title{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#111827)}
.dsha-group-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsha-row{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,#edf1f5)}
.dsha-row:first-of-type{border-top:0;padding-top:0}
.dsha-rowtop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary,#4b5563);font-weight:600;font-size:13px}
.dsha-metrics{display:flex;align-items:baseline;gap:10px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#8b93a1);font-size:12px}
.dsha-percent{font-size:13px;font-weight:750;color:var(--dsw-alias-state-success-primary,#059669)}
.dsha-percent-cyan{color:var(--dsw-alias-brand-primary,#0284c7)}
.dsha-bar{height:6px;margin-top:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#edf1f5);overflow:hidden}
.dsha-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary,#10b981)}
.dsha-fill-cyan{background:var(--dsw-alias-brand-primary,#06b6d4)}
.dsha-empty{border:1px dashed var(--dsw-alias-border-l2,#d8dee8);border-radius:10px;padding:14px;color:var(--dsw-alias-label-secondary,#747f90);background:var(--dsw-alias-bg-layer-2,#fafbfc);font-size:13px;line-height:20px}
.dsha-error{margin-top:12px;color:var(--dsw-alias-state-error-primary,#991b1b);background:var(--dsw-alias-bg-layer-2,#fff5f5);border:1px solid var(--dsw-alias-state-error-primary,#fecaca);border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
.dsha-note{margin-top:12px;color:var(--dsw-alias-label-secondary,#8b93a1);font-size:12px;line-height:18px}
.dsha-model-card{margin-top:14px}
.dsha-model-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.dsha-model-title{font-size:14px;font-weight:700;color:var(--dsw-alias-label-primary,#111827)}
.dsha-model-desc{margin-top:3px;color:var(--dsw-alias-label-secondary,#8b93a1);font-size:12px;line-height:18px}
.dsha-mini-actions{display:flex;gap:8px;white-space:nowrap}
.dsha-mini-btn{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4f5bf6);font-size:12px;line-height:18px;cursor:pointer;padding:0}
.dsha-mini-btn:hover{text-decoration:underline}
.dsha-model-list{border:1px solid var(--dsw-alias-border-l1,#eef1f5);border-radius:10px;overflow:hidden}
.dsha-model-row{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;background:var(--dsw-alias-bg-layer-2,#fff);border-top:1px solid var(--dsw-alias-border-l1,#eef1f5);cursor:pointer}
.dsha-model-row:hover{background:var(--dsw-alias-interactive-bg-hover,#fafbfc)}
.dsha-model-row:first-child{border-top:0}
.dsha-check{margin-top:1px;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#111827);flex:0 0 auto}
.dsha-model-text{min-width:0;flex:1 1 auto}
.dsha-model-name{display:block;font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#111827);line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-model-sub{display:block;margin-top:3px;color:var(--dsw-alias-label-secondary,#9aa3b0);font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-model-label{display:inline-flex;align-items:center;gap:6px;vertical-align:baseline;white-space:nowrap}
.dsha-model-label-name{white-space:nowrap}
.dsha-model-name-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsha-quota-pill{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums;border:1px solid transparent;vertical-align:middle;user-select:none;pointer-events:none}
.dsha-quota-pill-trigger{padding:0 5px;font-size:10px;line-height:15px;margin-left:2px}
.dsha-quota-pill-good{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 14%,transparent);color:var(--dsw-alias-state-success-primary,#059669);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 28%,transparent)}
.dsha-quota-pill-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 28%,transparent)}
.dsha-quota-pill-low{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 14%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 28%,transparent)}
.dsha-quota-pill-reset{font-size:10px;opacity:0.8;font-weight:500}
.dsha-composer-quota{display:inline-flex;align-items:center;gap:5px;height:28px;box-sizing:border-box;padding:0 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font-family:inherit;font-size:12px;font-weight:500;line-height:20px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;user-select:none;transition:background 120ms ease}
.dsha-composer-quota:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05))}
.dsha-composer-quota[data-level="good"] .dsha-quota-pct{color:var(--dsw-alias-state-success-primary,#059669);font-weight:600}
.dsha-composer-quota[data-level="warn"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 30%,transparent)}
.dsha-composer-quota[data-level="warn"] .dsha-quota-pct{color:var(--dsw-alias-state-warn-primary,#d97706);font-weight:600}
.dsha-composer-quota[data-level="low"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 30%,transparent)}
.dsha-composer-quota[data-level="low"] .dsha-quota-pct{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600}
.dsha-composer-quota .dsha-quota-reset{font-size:11px;opacity:.75}
.dsha-composer-quota[data-level="unknown"]{color:var(--dsw-alias-label-secondary)}
.dsha-quota-stale{font-size:10px;opacity:.8}
.dsha-quota-popover{position:fixed;z-index:10000;box-sizing:border-box;width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#202124);box-shadow:0 12px 40px #0003;font:12px/1.5 system-ui;outline:none;text-align:left}
.dsha-quota-popover header,.dsha-quota-popover footer,.dsha-detail-row-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsha-quota-popover header{font-size:14px;margin-bottom:12px}
.dsha-quota-popover button{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:inherit;padding:3px 8px;font:inherit;cursor:pointer}
.dsha-quota-popover button:focus-visible,.dsha-composer-quota:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsha-quota-popover button:disabled{opacity:.55;cursor:wait}
.dsha-detail-group{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsha-detail-group h4{margin:0 0 5px;font-size:12px;overflow-wrap:anywhere}
.dsha-detail-group p,.dsha-detail-note{margin:4px 0;color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}
.dsha-detail-row{margin:8px 0}
.dsha-detail-row progress{display:block;appearance:none;width:100%;height:5px;border:0;border-radius:5px;overflow:hidden;margin:5px 0;background:var(--dsw-alias-bg-layer-2);accent-color:var(--dsw-alias-brand-primary)}
.dsha-detail-row progress::-webkit-progress-bar{background:var(--dsw-alias-bg-layer-2)}
.dsha-detail-row progress::-webkit-progress-value{background:var(--dsw-alias-brand-primary)}
.dsha-detail-reset{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsha-detail-warning{font-size:11px;color:var(--dsw-alias-state-warn-primary)}
.dsha-quota-popover footer{margin-top:10px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.dsha-pool{margin:0 0 16px;padding:16px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222)}
.dsha-pool-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.dsha-pool-account{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,#eee);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dsha-pool-identity{display:flex;flex-direction:column;gap:3px;font-size:12px;overflow-wrap:anywhere}
.dsha-pool-active{color:var(--dsw-alias-state-success-primary,#059669)}
.dsha-pool-actions{display:flex;gap:5px;flex-wrap:wrap}
.dsha-pool-quota{flex-basis:100%;font-size:12px}
.dsha-pool .dsha-btn{background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:inherit;border-color:var(--dsw-alias-border-l2,#ddd)}
.dsha-pool-monitor{margin-bottom:14px;color:var(--dsw-alias-label-primary,#222);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.dsha-pool-monitor>.dsha-detail-row progress{display:block;width:100%;height:6px;accent-color:var(--dsw-alias-brand-primary,#2675df)}
.dsha-pool-monitor .dsha-detail-row-head{flex-wrap:wrap;gap:4px 10px}
.dsha-pool-detail{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,#eee)}
.dsha-pool-detail summary{cursor:pointer;font-weight:600}
.dsha-pool-monitor button{background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:inherit;border-color:var(--dsw-alias-border-l2,#ddd)}
.dsha-pool-total{margin:0;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsha-pool-total .dsha-detail-row-head{flex-wrap:nowrap;gap:8px}
.dsha-pool-total .dsha-detail-row-head>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-pool-total strong{white-space:nowrap;font-variant-numeric:tabular-nums}
.dsha-pool-total progress{margin:5px 0 0;height:4px!important}
.dsha-pool-total select{min-width:0;max-width:62%;border:0;background:transparent;color:inherit;font:inherit;text-overflow:ellipsis}
.dsha-pool-status{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary);margin:8px 0}
.dsha-pool-more>summary,.dsha-pool-manage>summary,.dsha-pool-models>summary,.dsha-settings-detail>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;padding:5px 0}
.dsha-pool-more[open]>summary,.dsha-pool-manage[open]>summary,.dsha-settings-detail[open]>summary{margin-bottom:8px;color:var(--dsw-alias-label-primary)}
.dsha-settings-detail.dsha-card{padding:10px 16px}
.dsha-pool-monitor{margin-bottom:8px}
.dsha-pool-head{margin-bottom:6px}
.dsha-availability{margin:4px 0 0;font-size:10px;color:var(--dsw-alias-label-secondary)}
.dsha-runtime-line{font-size:11px;margin:6px 0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsha-runtime-line>summary{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-runtime-line[data-runtime-phase="failed"]>summary{color:var(--dsw-alias-state-warn-primary)}
`;
      document.head.append(style);
    }

    let quotaCache = { map: new Map(), groups: [], fetchedAt: 0, loading: false, error: "" };
    let quotaRequest;
    let quotaController;
    let quotaTimer;
    let quotaDisposed = false;
    let quotaGeneration = 0;
    function clearQuotaCache() {
      quotaGeneration += 1;
      quotaController?.abort();
      quotaController = undefined;
      quotaRequest = undefined;
      quotaCache = { map: new Map(), groups: [], fetchedAt: 0, loading: false, error: "" };
      notifyQuota();
    }
    const quotaListeners = new Set();

    function subscribeQuota(listener) {
      quotaListeners.add(listener);
      if (!quotaTimer) quotaTimer = window.setInterval(() => {
        if (document.visibilityState !== "hidden") void ensureQuotaLoaded(true);
      }, 60000);
      return () => {
        quotaListeners.delete(listener);
        if (!quotaListeners.size) {
          window.clearInterval(quotaTimer);
          quotaTimer = undefined;
          quotaGeneration += 1;
          quotaController?.abort();
          quotaController = undefined;
          quotaRequest = undefined;
          quotaCache = { ...quotaCache, loading: false };
        }
      };
    }

    function notifyQuota() {
      for (const fn of [...quotaListeners]) fn(quotaCache);
    }

    function getCachedModelQuota(modelId) {
      return quotaCache.map.get(modelId);
    }

    function updateQuotaCacheFromOptions(options, detail) {
      if (!Array.isArray(options) || quotaDisposed) return;
      const sameAccount = !detail?.accountId || detail.accountId === quotaCache.accountId;
      quotaCache = {
        accountId: detail?.accountId || quotaCache.accountId,
        map: new Map(options.filter(o => o && typeof o.id === "string").map(o => [o.id, { ...o }])),
        groups: Array.isArray(detail?.groups) ? detail.groups : sameAccount ? quotaCache.groups : [],
        fetchedAt: Number.isFinite(detail?.fetchedAt) ? detail.fetchedAt : sameAccount ? quotaCache.fetchedAt : 0,
        loading: false,
        error: "",
      };
      notifyQuota();
    }

    async function ensureQuotaLoaded(force = false) {
      if (quotaDisposed) return quotaCache;
      if (quotaRequest) return quotaRequest;
      if (!force && quotaCache.fetchedAt > 0 && Date.now() - quotaCache.fetchedAt < 60000) return quotaCache;
      quotaCache = { ...quotaCache, loading: true, error: "" };
      notifyQuota();
      quotaController = new AbortController();
      const controller = quotaController;
      const generation = quotaGeneration;
      const timeout = window.setTimeout(() => controller.abort(), 30000);
      quotaRequest = (async () => {
        try {
          // /status alone serves an existing cache; a refresh must actually query /quota.
          const status = await api("/status", { signal: controller.signal });
          if (generation !== quotaGeneration) return quotaCache;
          if (status.authenticated === false) {
            quotaCache = { map: new Map(), groups: [], fetchedAt: 0, loading: false, error: "未登录 / Signed out" };
            notifyQuota();
            return quotaCache;
          }
          if (status.models?.options) updateQuotaCacheFromOptions(status.models.options, status.quota);
          if (force || !status.quota?.fetchedAt || Date.now() - status.quota.fetchedAt >= 60000) {
            const detail = await api("/quota", { signal: controller.signal });
            if (generation !== quotaGeneration || (status.accountId && detail.accountId && detail.accountId !== status.accountId)) return quotaCache;
            updateQuotaCacheFromOptions(detail.models?.options || [], detail);
          }
        } catch (error) {
          if (!quotaDisposed && generation === quotaGeneration) {
            quotaCache = { ...quotaCache, loading: false, error: "刷新失败，以下为上次数据 / Refresh failed; showing last data" };
            notifyQuota();
          }
        } finally {
          window.clearTimeout(timeout);
          if (quotaController === controller) { quotaController = undefined; quotaRequest = undefined; }
        }
        return quotaCache;
      })();
      return quotaRequest;
    }

    // Pool snapshots never update quotaCache: model-picker values belong to one account.
    let poolCache = { accounts: [], rows: [], accountCount: 0, fetchedAt: 0, loadedAt: 0, loading: false, error: "" };
    let poolRequest;
    let poolController;
    let poolTimer;
    let poolGeneration = 0;
    const poolListeners = new Set();
    function notifyPool() { for (const listener of [...poolListeners]) listener(poolCache); }
    function stopPoolRequest() {
      poolGeneration += 1;
      poolController?.abort();
      poolController = undefined;
      poolRequest = undefined;
    }
    function invalidatePool() {
      stopPoolRequest();
      poolCache = { ...poolCache, loadedAt: 0, loading: false, stale: true };
      notifyPool();
      if (poolListeners.size) void ensurePoolLoaded();
    }
    function subscribePool(listener) {
      poolListeners.add(listener);
      if (!poolTimer) poolTimer = window.setInterval(() => {
        if (document.visibilityState !== "hidden") void ensurePoolLoaded();
      }, 60000);
      return () => {
        poolListeners.delete(listener);
        if (!poolListeners.size) {
          window.clearInterval(poolTimer);
          poolTimer = undefined;
          stopPoolRequest();
          poolCache = { ...poolCache, loading: false };
        }
      };
    }
    async function ensurePoolLoaded(force = false) {
      if (quotaDisposed) return poolCache;
      if (poolRequest) {
        if (!force || poolController?.force) return poolRequest;
        stopPoolRequest(); // A forced POST supersedes an in-flight cached GET.
      }
      if (!force && poolCache.loadedAt && Date.now() - poolCache.loadedAt < 60000) return poolCache;
      const controller = new AbortController();
      controller.force = force;
      poolController = controller;
      const generation = poolGeneration;
      poolCache = { ...poolCache, loading: true, error: "" };
      notifyPool();
      const timeout = window.setTimeout(() => controller.abort(), 60000);
      const request = (async () => {
        try {
          const value = await api("/pool-quota", { method: force ? "POST" : "GET", signal: controller.signal });
          if (quotaDisposed || generation !== poolGeneration || controller.signal.aborted) return poolCache;
          poolCache = { ...value, accounts: Array.isArray(value.accounts) ? value.accounts : [], rows: Array.isArray(value.rows) ? value.rows : [], loadedAt: Date.now(), loading: false, error: "" };
          notifyPool();
        } catch (error) {
          if (!quotaDisposed && generation === poolGeneration) {
            poolCache = { ...poolCache, loading: false, error: `号池刷新失败，保留上次数据：${error instanceof Error ? error.message : String(error)}` };
            notifyPool();
          }
        } finally {
          window.clearTimeout(timeout);
          if (poolController === controller) { poolController = undefined; poolRequest = undefined; }
        }
        return poolCache;
      })();
      poolRequest = request;
      return request;
    }
    function usePoolQuota() {
      const [snapshot, setSnapshot] = useState(poolCache);
      useEffect(() => {
        const unsubscribe = subscribePool(setSnapshot);
        setSnapshot(poolCache);
        void ensurePoolLoaded();
        return unsubscribe;
      }, []);
      return snapshot;
    }
    // Cheap Host-local request state; polling never refreshes upstream quota.
    let runtimeCache = { routes: [], health: { state: "idle" }, loadedAt: 0, error: "" };
    let runtimeRequest, runtimeController, runtimeTimer;
    let runtimeGeneration = 0;
    const runtimeListeners = new Set();
    function stopRuntime() {
      runtimeGeneration += 1;
      runtimeController?.abort();
      runtimeController = undefined;
      runtimeRequest = undefined;
      window.clearInterval(runtimeTimer);
      runtimeTimer = undefined;
    }
    async function ensureRuntimeLoaded() {
      if (quotaDisposed || !runtimeListeners.size) return runtimeCache;
      if (runtimeRequest) return runtimeRequest;
      const controller = new AbortController(), generation = runtimeGeneration;
      runtimeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      runtimeRequest = (async () => {
        try {
          const value = await api("/runtime-status", { signal: controller.signal });
          if (generation !== runtimeGeneration || quotaDisposed) return runtimeCache;
          runtimeCache = { ...value, routes: Array.isArray(value.routes) ? value.routes : [], loadedAt: Date.now(), error: "" };
        } catch {
          if (generation !== runtimeGeneration || quotaDisposed) return runtimeCache;
          runtimeCache = { ...runtimeCache, error: "运行状态暂不可用" };
        } finally {
          window.clearTimeout(timeout);
          if (runtimeController === controller) { runtimeController = undefined; runtimeRequest = undefined; }
        }
        for (const listener of [...runtimeListeners]) listener(runtimeCache);
        return runtimeCache;
      })();
      return runtimeRequest;
    }
    function useRuntimeStatus() {
      const [snapshot, setSnapshot] = useState(runtimeCache);
      useEffect(() => {
        runtimeListeners.add(setSnapshot);
        setSnapshot(runtimeCache);
        void ensureRuntimeLoaded();
        if (!runtimeTimer) runtimeTimer = window.setInterval(() => {
          if (document.visibilityState !== "hidden") void ensureRuntimeLoaded();
        }, 3000);
        return () => { runtimeListeners.delete(setSnapshot); if (!runtimeListeners.size) stopRuntime(); };
      }, []);
      return snapshot;
    }
    function availabilityText(summary) {
      if (!summary || !Number.isFinite(summary.availableCount)) return "额度可用：未知";
      return `额度可用 ${summary.availableCount}/${summary.accountCount}${summary.unknownCount ? ` · ${summary.unknownCount} 未知` : ""}`;
    }
    function RuntimeRequestLine({ snapshot, poolDiagnostics, modelId }) {
      const h = React.createElement;
      const route = snapshot.routes.find(item => !modelId || item.modelId === modelId);
      const phases = { requesting: "请求中", streaming: "生成中", succeeded: "已完成", failed: "仍失败", aborted: "已取消" };
      const state = !route ? "暂无本进程请求记录" : route.retrying ? `换号重试 ${route.attempt}/${route.maxAttempts}` : route.recovered ? "已恢复" : phases[route.phase] || route.phase;
      return h("details", { className: "dsha-runtime-line", "data-runtime-phase": route?.phase || "idle" },
        h("summary", null, snapshot.error || (route ? `最近请求：${route.label || route.email || (route.accountId ? "账户" : "未选账户")} · ${state}` : state)),
        h("p", { className: "dsha-detail-note" }, "仅 Antigravity · 同进程最近记录，不代表当前会话；重启后清空。"),
        route ? h(React.Fragment, null,
          h("p", null, route.reason || "路由原因未提供"),
          h("p", null, `${route.modelId} · 尝试 ${route.attempt}/${route.maxAttempts} · ${new Date(route.updatedAt).toLocaleString()}`),
          route.failure ? h("p", { className: "dsha-detail-warning" }, `${route.recovered ? "此前：" : "失败："}${route.failure.label || "失败原因未知"}${route.failure.code ? ` (${route.failure.code})` : ""}`) : null,
          (route.failure || snapshot.diagnostics || poolDiagnostics) ? h("p", { className: "dsha-detail-note" }, `阶段 ${route.failure?.phase || (snapshot.diagnostics || poolDiagnostics)?.phase || "未知"} · 类别 ${route.failure?.kind || (snapshot.diagnostics || poolDiagnostics)?.kind || "未知"}${(route.failure?.code || (snapshot.diagnostics || poolDiagnostics)?.code) ? ` · 代码 ${route.failure?.code || (snapshot.diagnostics || poolDiagnostics)?.code}` : ""}`) : null,
          h("p", { className: "dsha-detail-note" }, "仅输出前的额度/限流错误可有界换号；网络错误或已输出内容不盲目重放。")) : null);
    }
    function poolRowForModel(snapshot, modelId) {
      const rows = snapshot.rows || [];
      if (/^(claude|gpt)/i.test(modelId || "")) {
        const weekly = rows.find(row => row.id === "bucket:3p-weekly");
        const fiveHour = rows.find(row => row.id === "bucket:3p-5h");
        return (Number.isFinite(weekly?.totalPercent) && weekly.knownCount !== 0 ? weekly : fiveHour) || weekly;
      }
      return rows.find(row => row.id === `model:${modelId}`);
    }
    function poolNumbers(row, snapshot) {
      const count = Number.isFinite(row?.accountCount) ? row.accountCount : Number.isFinite(snapshot.accountCount) ? snapshot.accountCount : snapshot.accounts.length;
      const known = Number.isFinite(row?.knownCount) ? row.knownCount : row?.complete ? count : 0;
      return {
        total: Number.isFinite(row?.totalPercent) && known > 0 ? row.totalPercent : undefined,
        capacity: Number.isFinite(row?.capacityPercent) ? row.capacityPercent : count * 100,
        unknown: Math.max(0, count - known), known, count,
      };
    }
    function poolAmount(row, snapshot) {
      const { total, capacity } = poolNumbers(row, snapshot);
      return `${total === undefined ? "—" : total.toFixed(1)}/${capacity}%`;
    }
    function QuotaDetailRow({ row, label }) {
      const h = React.createElement;
      const value = quotaPercentOf(row);
      return h("div", { className: "dsha-detail-row" },
        h("div", { className: "dsha-detail-row-head" }, h("span", null, label || row.label || row.name || row.id),
          h("strong", null, value === undefined ? "上游未提供" : `${value.toFixed(1)}%`)),
        value === undefined ? null : h("progress", { max: 100, value, "aria-label": `${label || row.label || row.id}剩余 ${value.toFixed(1)}%` }),
        h("div", { className: "dsha-detail-reset", title: row.resetTime ? new Date(row.resetTime).toLocaleString() : undefined }, quotaResetText(row.resetTime)));
    }
    function PoolQuotaMonitor({ snapshot, modelId }) {
      const h = React.createElement;
      const runtime = useRuntimeStatus();
      const rows = snapshot.rows || [];
      const [geminiId, setGeminiId] = useState("model:gemini-3.8-flash");
      const geminiRows = rows.filter(row => row.kind === "model" && /^model:gemini/i.test(row.id));
      const selectedGemini = modelId ? geminiRows.find(row => row.id === `model:${modelId}`)
        : geminiRows.find(row => row.id === geminiId) || geminiRows[0];
      const showGemini = /^gemini/i.test(modelId || "") || (!modelId && !!selectedGemini);
      const geminiTarget = modelId || selectedGemini?.id.slice(6) || "";
      const normalizeGroup = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const geminiWeeklyReported = snapshot.accounts.some(account => (account.groups || []).some(group =>
        (/^Gemini(?: models)?$/i.test((group.displayName || "").trim()) || normalizeGroup(group.displayName) === normalizeGroup(geminiTarget))
        && (group.buckets || []).some(bucket => /week|周/i.test(`${bucket.window || ""} ${bucket.id || bucket.bucketId || ""}`))));
      const groupAvailability = /^(claude-|gpt-oss-)/.test(modelId || "")
        ? snapshot.availability?.models?.[modelId] || snapshot.availability?.thirdParty : snapshot.availability?.thirdParty;
      const summary = rows.filter(row => row.id === "bucket:3p-weekly" || row.id === "bucket:3p-5h" || row === selectedGemini);
      const stale = snapshot.stale || !!snapshot.error || snapshot.accounts.some(account => account.stale || account.error) || (snapshot.fetchedAt > 0 && Date.now() - snapshot.fetchedAt > 120000);
      return h("section", { className: "dsha-pool-monitor", "aria-label": "Antigravity 号池总监控", "aria-busy": snapshot.loading },
        h("div", { className: "dsha-pool-head" }, h("strong", null, `号池总览 · ${snapshot.accountCount ?? snapshot.accounts.length} 个账户`),
          h("button", { type: "button", className: "dsha-btn", disabled: snapshot.loading, onClick: () => { void ensurePoolLoaded(true); } }, snapshot.loading ? "刷新全部中…" : "刷新全部")),
        summary.map(row => {
          const numbers = poolNumbers(row, snapshot);
          const label = row.id === "bucket:3p-weekly" ? "Claude / GPT · 周额度"
            : row.id === "bucket:3p-5h" ? "Claude / GPT · 5 小时" : row.label || row.id.slice(6);
          return h("div", { key: row.id, className: "dsha-detail-row dsha-pool-total", "data-pool-row": row.id },
            h("div", { className: "dsha-detail-row-head" }, !modelId && row === selectedGemini && geminiRows.length > 1
              ? h("select", { "aria-label": "总览 Gemini 模型", value: selectedGemini.id, onChange: event => setGeminiId(event.target.value) },
                geminiRows.map(model => h("option", { key: model.id, value: model.id }, model.label || model.id.slice(6))))
              : h("span", null, label), h("strong", null, poolAmount(row, snapshot))),
            numbers.total === undefined || !numbers.capacity ? null : h("progress", { max: numbers.capacity, value: numbers.total, "aria-label": `${label}号池已知合计 ${poolAmount(row, snapshot)}` }),
            numbers.unknown ? h("p", { className: "dsha-detail-warning" }, `已知 ${numbers.known}/${numbers.count} · ${numbers.unknown} 个未知，未按 0 计入`) : null,
            row.id === "bucket:3p-5h" || (row.id === "bucket:3p-weekly" && !summary.some(item => item.id === "bucket:3p-5h"))
              ? h("p", { className: "dsha-availability", "data-availability": "3p" }, availabilityText(groupAvailability))
              : row.kind === "model" ? h("p", { className: "dsha-availability", "data-availability": row.id.slice(6) }, availabilityText(snapshot.availability?.models?.[row.id.slice(6)])) : null);
        }),
        !summary.length ? h("p", { className: "dsha-detail-note" }, snapshot.loading ? "正在加载号池额度…" : "暂无汇总额度，未知不等于 0%。") : null,
        showGemini ? h("p", { className: "dsha-detail-note", "data-gemini-weekly": geminiWeeklyReported ? "reported" : "not-reported" }, geminiWeeklyReported
          ? "Gemini 周额度：部分账户已返回，见账户明细；模型余额不等于独立周余额。"
          : "Gemini 周额度：本次接口未返回，不代表没有周限制；模型余额仅代表接口当前窗口。") : null,
        h("div", { className: "dsha-pool-status" }, h("span", null, "等权估算 · 各限额独立"),
          h("span", null, snapshot.fetchedAt ? `${stale ? "数据不全/过期 · " : ""}${new Date(snapshot.fetchedAt).toLocaleTimeString()}` : "尚无数据")),
        snapshot.error ? h("p", { className: "dsha-detail-warning", role: "status" }, snapshot.error) : null,
        h(RuntimeRequestLine, { snapshot: runtime, poolDiagnostics: snapshot.diagnostics, modelId }),
        h("details", { className: "dsha-pool-more" },
          h("summary", null, `账户明细与说明（${snapshot.accounts.length}）`),
          h("p", { className: "dsha-detail-note" }, "等权账户指数，不是真实 tokens 总量；不同套餐不能视为准确总量。周限额与 5h 独立计算，不相加。额度可用数仅代表额度条件满足，不保证网络或上游服务健康；未知不作可用。"),
          snapshot.note ? h("p", { className: "dsha-detail-note" }, snapshot.note) : null,
          h("p", { className: "dsha-detail-note" }, "调度：新会话按额度余量、在途请求与最近使用分配；同会话尽量固定，低额或限流时切换。百分比不是可用 tokens，不能据此精确预测可用次数。"),
          showGemini ? h("p", { className: "dsha-detail-note" }, "Claude / GPT 周额度不属于 Gemini。Google 有周限制，但内部额度接口不保证为每个模型返回独立周余额。") : null,
          snapshot.accounts.map(account => {
          const groups = Array.isArray(account.groups) ? account.groups : [];
          const buckets = Array.isArray(account.bucketRows) ? account.bucketRows : [];
          const models = Array.isArray(account.modelRows) && account.modelRows.length ? account.modelRows : account.models?.options || [];
          const availability = /^gemini/i.test(modelId || "") ? snapshot.availability?.models?.[modelId] : groupAvailability;
          const decision = availability?.accounts?.find(item => item.id === account.id);
          const stateLabel = { available: "额度条件满足", blocked: "额度受限或冷却", unknown: "部分额度未知", "signed-out": "未登录" }[decision?.state] || "额度未知";
          return h("details", { key: account.id, className: "dsha-pool-detail", "data-pool-account": account.id },
            h("summary", null, `${account.label || account.email || account.id}${account.stale ? " · 旧数据" : ""}${account.error ? " · 查询失败" : ""}${account.hasCredential === false ? " · 无凭证" : ""}`),
            h("p", { className: "dsha-detail-note" }, account.email || "邮箱未提供"),
            h("p", { className: "dsha-detail-note" }, `${/^gemini/i.test(modelId || "") ? modelId : "Claude / GPT"}：${stateLabel}`),
            h("p", { className: "dsha-detail-note" }, account.fetchedAt ? `${account.stale ? "旧数据时间" : "独立额度更新于"} ${new Date(account.fetchedAt).toLocaleString()}` : "尚无独立额度数据"),
            account.error ? h("p", { className: "dsha-detail-warning" }, typeof account.error === "string" ? account.error : JSON.stringify(account.error)) : null,
            groups.length ? groups.map((group, index) => h("div", { className: "dsha-detail-group", key: index },
              h("h4", null, group.displayName || "共享额度"),
              (group.buckets || []).map((row, at) => h(QuotaDetailRow, { key: row.id || at, row, label: bucketLabel(row) })))) :
              buckets.map((row, index) => h(QuotaDetailRow, { key: row.id || index, row, label: bucketLabel(row) })),
            models.length ? h("details", { className: "dsha-pool-models" }, h("summary", null, `模型明细（${models.length}）`),
              models.map((row, index) => h(QuotaDetailRow, { key: row.id || index, row, label: row.label || row.name || row.id }))) : null,
            !groups.length && !buckets.length && !models.length ? h("p", { className: "dsha-detail-note" }, "额度未知，未按 0 处理。") : null);
        })));

    }

    function quotaPercentOf(row) {
      if (Number.isFinite(row?.remainingPercent)) return Math.max(0, Math.min(100, row.remainingPercent));
      if (Number.isFinite(row?.remainingFraction)) return Math.max(0, Math.min(100, row.remainingFraction * 100));
      return undefined;
    }

    function quotaResetText(time) {
      const timestamp = Date.parse(time || "");
      if (!Number.isFinite(timestamp)) return "重置时间未提供";
      const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60000));
      if (!minutes) return "已到重置时间，等待刷新";
      if (minutes >= 1440) return `${Math.floor(minutes / 1440)}天 ${Math.floor(minutes % 1440 / 60)}小时后重置`;
      if (minutes >= 60) return `${Math.floor(minutes / 60)}小时 ${minutes % 60}分后重置`;
      return `${minutes}分钟后重置`;
    }

    function bucketLabel(bucket) {
      if (/week|周/i.test(`${bucket.window || ""} ${bucket.id || ""} ${bucket.label || ""}`)) return "周限额 / Weekly";
      if (/5h|five.hour/i.test(`${bucket.window || ""} ${bucket.id || ""} ${bucket.label || ""}`)) return "5 小时限额 / 5h";
      return bucket.label || bucket.window || "上游额度";
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options && options.headers ? options.headers : {}),
        },
      });
      const body = await response.json().catch(() => ({ ok: false, error: "invalid-json" }));
      if (!response.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      return body.value;
    }

    function AntigravityIcon({ size = 20, className = "" }) {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 110 113",
          width: size,
          height: size,
          fill: "none",
          className,
          style: { flexShrink: 0, display: "inline-block", verticalAlign: "middle" },
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
        },
        React.createElement("path", {
          d: "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z",
          fill: "currentColor",
        }),
      );
    }

    function extractModelVersion(model) {
      const name = String(model && model.name ? model.name : "");
      const id = String(model && model.id ? model.id : "");
      const idMatch = id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
        || id.match(/\b(\d+(?:\.\d+)+)\b/);
      if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

      const nameMatch = name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
        || name.match(/\b(\d+(?:\.\d+)+)\b/);
      if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

      return [0];
    }

    function compareVersionsDesc(v1, v2) {
      const len = Math.max(v1.length, v2.length);
      for (let i = 0; i < len; i++) {
        const num1 = v1[i] !== undefined ? v1[i] : 0;
        const num2 = v2[i] !== undefined ? v2[i] : 0;
        if (num1 !== num2) return num2 - num1;
      }
      return 0;
    }

    function getFamilyOrder(model) {
      const text = `${model && model.id ? model.id : ""} ${model && model.name ? model.name : ""}`.toLowerCase();
      if (text.includes("gemini")) return 1;
      if (text.includes("claude")) return 2;
      if (text.includes("gpt")) return 3;
      return 4;
    }

    function getVariantScore(model) {
      const text = `${model && model.name ? model.name : ""} ${model && model.id ? model.id : ""}`.toLowerCase();
      if (text.includes("ultra")) return 1;
      if (text.includes("pro") && !text.includes("lite")) return 2;
      if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
      if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
      if (text.includes("image")) return 5;
      if (text.includes("lite") && !text.includes("thinking")) return 6;
      if (text.includes("lite") && text.includes("thinking")) return 7;
      return 10;
    }

    function compareAntigravityModels(a, b) {
      const famA = getFamilyOrder(a);
      const famB = getFamilyOrder(b);
      if (famA !== famB) return famA - famB;

      const verA = extractModelVersion(a);
      const verB = extractModelVersion(b);
      const verComp = compareVersionsDesc(verA, verB);
      if (verComp !== 0) return verComp;

      const variantA = getVariantScore(a);
      const variantB = getVariantScore(b);
      if (variantA !== variantB) return variantA - variantB;

      return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
    }

    function compareAntigravityModelOptions(a, b) {
      const aEnabled = Boolean(a && a.enabled);
      const bEnabled = Boolean(b && b.enabled);
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      return compareAntigravityModels(a, b);
    }

    function formatReset(resetTime, t) {
      if (!resetTime) return "n/a";
      const timestamp = Date.parse(resetTime);
      if (!Number.isFinite(timestamp)) return resetTime;
      const delta = timestamp - Date.now();
      if (delta <= 0) return t ? t("resetNow") : "now";
      const totalMinutes = Math.round(delta / 60000);
      const days = Math.floor(totalMinutes / (60 * 24));
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return t ? t("timeDayHour", { days, hours }) : `${days}d ${hours}h`;
      if (hours > 0) return t ? t("timeHourMin", { hours, minutes }) : `${hours}h ${minutes}m`;
      return t ? t("timeMin", { minutes }) : `${minutes}m`;
    }

    function resetText(row, t) {
      if (row && row.resetLabel) return t ? t("resetPrefix", { time: row.resetLabel }) : `Reset: ${row.resetLabel}`;
      if (row && row.resetTime) return t ? t("resetPrefix", { time: formatReset(row.resetTime, t) }) : `Reset: ${formatReset(row.resetTime, t)}`;
      return t ? t("resetUnavailable") : "Reset: n/a";
    }

    function percentOf(row) {
      return quotaPercentOf(row);
    }

    function QuotaRow({ row, accent, t }) {
      const percent = percentOf(row);
      const width = percent === undefined ? 0 : Math.max(0, Math.min(100, percent));
      return React.createElement("div", { className: "dsha-row" },
        React.createElement("div", { className: "dsha-rowtop" },
          React.createElement("div", null, row.label || row.displayName || row.id || (t ? t("quota") : "Quota")),
          React.createElement("div", { className: "dsha-metrics" },
            React.createElement("span", null, resetText(row, t)),
            React.createElement("span", { className: `dsha-percent${accent === "cyan" ? " dsha-percent-cyan" : ""}` }, percent === undefined ? "上游未提供" : `${percent}%`),
          ),
        ),
        React.createElement("div", { className: "dsha-bar" },
          React.createElement("div", {
            className: `dsha-fill${accent === "cyan" ? " dsha-fill-cyan" : ""}`,
            style: { width: `${width}%` },
          }),
        ),
      );
    }

    function QuotaGroup({ group, accent, t }) {
      const buckets = Array.isArray(group && group.buckets) ? group.buckets : [];
      return React.createElement("div", { className: "dsha-quota-group" },
        React.createElement("div", { className: "dsha-group-head" },
          React.createElement("span", { className: "dsha-group-title" }, group.displayName || (t ? t("quota") : "Quota group")),
          group.description && React.createElement("span", { className: "dsha-group-desc" }, group.description),
        ),
        buckets.map((bucket, index) => React.createElement(QuotaRow, {
          key: bucket.id || bucket.bucketId || bucket.label || bucket.displayName || index,
          row: bucket,
          accent,
          t,
        })),
      );
    }

    function modelMeta(option, t) {
      const parts = [];
      if (Array.isArray(option.inputModalities) && option.inputModalities.includes("image")) parts.push("image");
      if (Array.isArray(option.reasoningEfforts) && option.reasoningEfforts.length) {
        parts.push(`thinking: ${option.reasoningEfforts.join("/")}`);
      }
      return parts.join(" · ");
    }

    function ModelOptionRow({ option, disabled, onToggle, t }) {
      const hasQuota = typeof option.remainingPercent === "number";
      const pct = hasQuota ? Math.round(option.remainingPercent) : null;
      const level = !hasQuota ? "" : pct > 30 ? "good" : pct > 15 ? "warn" : "low";
      const tooltip = hasQuota
        ? (t ? t("quotaBadgeTooltip", { percent: option.remainingPercent.toFixed(1), reset: option.resetLabel || "n/a" }) : `Remaining ${option.remainingPercent.toFixed(1)}%`)
        : undefined;

      return React.createElement("label", { className: "dsha-model-row" },
        React.createElement("input", {
          className: "dsha-check",
          type: "checkbox",
          checked: !!option.enabled,
          disabled,
          onChange: (event) => onToggle(option.id, event.target.checked),
        }),
        React.createElement("span", { className: "dsha-model-text" },
          React.createElement("span", { className: "dsha-model-name-line" },
            React.createElement("span", { className: "dsha-model-name" }, option.name || option.id),
            hasQuota && React.createElement("span", {
              className: `dsha-quota-pill dsha-quota-pill-${level}`,
              "data-level": level,
              title: tooltip,
            },
              `${pct}%`,
              option.resetLabel ? React.createElement("span", { className: "dsha-quota-pill-reset" }, ` · ${option.resetLabel}`) : null,
            ),
          ),
          React.createElement("span", { className: "dsha-model-sub" }, modelMeta(option, t) || option.id),
        ),
      );
    }

    function AntigravityComposerQuota(props) {
      const { sessionId, ctx } = props;
      const [current, setCurrent] = useState(() => {
        const rootDirs = ctx && typeof ctx.get === "function" ? ctx.get("modelDirectories") : undefined;
        const dir = (rootDirs && sessionId && typeof rootDirs.directoryFor === "function")
          ? rootDirs.directoryFor(sessionId)?.store
          : undefined;
        return dir && typeof dir.getSnapshot === "function" ? dir.getSnapshot()?.current : undefined;
      });

      useEffect(() => {
        const rootDirs = ctx && typeof ctx.get === "function" ? ctx.get("modelDirectories") : undefined;
        const dir = (rootDirs && sessionId && typeof rootDirs.directoryFor === "function")
          ? rootDirs.directoryFor(sessionId)?.store
          : undefined;
        if (!dir) return;
        const update = () => {
          if (typeof dir.getSnapshot === "function") {
            setCurrent(dir.getSnapshot()?.current);
          }
        };
        update();
        if (typeof dir.subscribe === "function") {
          return dir.subscribe(update);
        }
      }, [sessionId, ctx]);

      const isAntigravity = current?.provider === "antigravity";
      const modelId = current?.model;
      const [snapshot, setSnapshot] = useState(quotaCache);
      const [poolSnapshot, setPoolSnapshot] = useState(poolCache);
      const [open, setOpen] = useState(false);
      const [position, setPosition] = useState({ left: 12, top: 12 });
      const trigger = useRef(null);
      const panel = useRef(null);
      const panelId = React.useId();
      const [clock, setClock] = useState(Date.now());

      useEffect(() => {
        setOpen(false);
        if (!isAntigravity) return;
        setSnapshot(quotaCache);
        const unsubscribe = subscribeQuota(setSnapshot);
        const unsubscribePool = subscribePool(setPoolSnapshot);
        setPoolSnapshot(poolCache);
        void ensureQuotaLoaded();
        void ensurePoolLoaded();
        return () => { unsubscribe(); unsubscribePool(); };
      }, [isAntigravity, modelId]);

      useEffect(() => {
        if (!open || !isAntigravity) return;
        const tick = window.setInterval(() => setClock(Date.now()), 30000);
        const outside = (event) => {
          if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
        };
        const escape = (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        };
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", escape, true);
        panel.current?.focus();
        return () => {
          window.clearInterval(tick);
          document.removeEventListener("pointerdown", outside, true);
          document.removeEventListener("keydown", escape, true);
        };
      }, [open, isAntigravity]);

      React.useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
          const rect = trigger.current?.getBoundingClientRect();
          const pop = panel.current;
          if (!rect || !pop) return;
          const width = pop.offsetWidth;
          const height = pop.offsetHeight;
          const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
          const above = rect.top - height - 8;
          const top = above >= 12 ? above : Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12));
          setPosition({ left, top });
        };
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
        if (panel.current) observer?.observe(panel.current);
        return () => {
          observer?.disconnect();
          window.removeEventListener("resize", place);
          window.removeEventListener("scroll", place, true);
        };
      }, [open, snapshot, poolSnapshot, clock]);

      if (!isAntigravity) return null;
      const selectedPoolRow = poolRowForModel(poolSnapshot, modelId);
      const numbers = poolNumbers(selectedPoolRow, poolSnapshot);
      const pct = numbers.total === undefined || !numbers.capacity ? undefined : numbers.total / numbers.capacity * 100;
      const stale = !!poolSnapshot.error || poolSnapshot.stale || poolSnapshot.accounts.some(account => account.stale || account.error) || (poolSnapshot.fetchedAt > 0 && Date.now() - poolSnapshot.fetchedAt > 120000);
      const level = stale || numbers.unknown || pct === undefined ? "unknown" : pct > 30 ? "good" : pct > 15 ? "warn" : "low";
      const h = React.createElement;
      const detail = open ? createPortal(h("section", {
        ref: panel, id: panelId, role: "dialog", "aria-label": "Antigravity 额度详情", tabIndex: -1,
        className: "dsha-quota-popover", style: position,
      },
        h("header", null, h("strong", null, "Antigravity 额度"), h("button", {
          type: "button", "aria-label": "关闭额度详情", onClick: () => { setOpen(false); trigger.current?.focus(); },
        }, "×")),
        h(PoolQuotaMonitor, { snapshot: poolSnapshot, modelId }),

      ), document.body) : null;
      return h(React.Fragment, null,
        h("button", {
          ref: trigger, type: "button", className: "dsha-composer-quota", "data-level": level,
          "aria-label": `Antigravity 号池额度：已知合计 ${poolAmount(selectedPoolRow, poolSnapshot)}${numbers.unknown ? `，${numbers.unknown} 个账户未知` : ""}，等权账户指数，点击查看详情`,
          "aria-haspopup": "dialog", "aria-expanded": open, "aria-controls": open ? panelId : undefined,
          title: "点击查看额度详情", onClick: () => { setOpen(value => !value); },
        }, h(AntigravityIcon, { size: 14 }),
          h("span", { className: "dsha-quota-pct" }, `池 ${poolAmount(selectedPoolRow, poolSnapshot)}`),
          numbers.unknown ? h("span", { className: "dsha-quota-stale" }, `+${numbers.unknown}未知`) : null,
          stale ? h("span", { className: "dsha-quota-stale" }, "旧") : null),
        detail,
      );
    }

    function useScopedApi() {
      const scope = useRef({ active: true, controller: new AbortController() });
      useEffect(() => {
        scope.current = { active: true, controller: new AbortController() };
        return () => { scope.current.active = false; scope.current.controller.abort(); };
      }, []);
      const isLive = useCallback(() => scope.current.active && !quotaDisposed, []);
      const request = useCallback(async (path, options) => {
        const current = scope.current;
        const value = await api(path, { ...options, signal: current.controller.signal });
        if (!current.active || current !== scope.current || quotaDisposed) throw new DOMException("Unmounted", "AbortError");
        return value;
      }, []);
      return [request, isLive];
    }

    function AccountPoolPanel({ roster, pendingLogin, onLogin, onChanged }) {
      const h = React.createElement;
      const snapshot = usePoolQuota();
      const [requestApi, isLive] = useScopedApi();
      const [busyId, setBusyId] = useState("");
      const [error, setError] = useState("");
      const [quotas, setQuotas] = useState({});
      const accounts = roster?.accounts || [];
      const act = async (action, account) => {
        if (action === "remove" && !window.confirm(`从本机号池移除 ${account.label || account.email || "此账户"}？不会删除 Google 账户，也不会自动切换到其他账户。`)) return;
        setBusyId(account.id);
        setError("");
        try {
          const result = await requestApi("/accounts", { method: "POST", body: JSON.stringify({ action, id: account.id, confirm: action === "remove" }) });
          if (action === "quota") setQuotas(previous => ({ ...previous, [account.id]: result }));
          else {
            clearQuotaCache();
            await onChanged();
          }
          if (isLive()) invalidatePool();
        } catch (err) { if (isLive()) setError(err instanceof Error ? err.message : "账户操作失败"); }
        finally { if (isLive()) setBusyId(""); }
      };
      return h("section", { className: "dsha-pool", "aria-label": "Antigravity 账户池" },
        h(PoolQuotaMonitor, { snapshot }),
        h("details", { className: "dsha-pool-manage", open: !accounts.length || pendingLogin },
          h("summary", null, `管理账户（${accounts.length}）`),
          h("div", { className: "dsha-pool-head" }, h("span", null, "登录与手动切换"),
            h("button", { className: "dsha-btn", type: "button", disabled: !!busyId || pendingLogin, onClick: onLogin }, pendingLogin ? "等待 Google 授权…" : "添加账户")),
          h("p", { className: "dsha-note" }, "凭证仅保存在本机。手动切换只影响新请求；仅输出前遇到配额类错误可换号，已输出的回复不重放。"),
        accounts.length ? accounts.map(account => h("div", { key: account.id, className: "dsha-pool-account" },
          h("div", { className: "dsha-pool-identity" }, h("strong", null, account.label || account.email || "Google 账户"),
            h("span", null, account.email || "邮箱未提供"),
            account.active ? h("span", { className: "dsha-pool-active" }, "当前账户") : null,
            account.hasCredential === false ? h("span", null, "已退出，需重新登录") : null),
          h("div", { className: "dsha-pool-actions" },
            !account.active ? h("button", { type: "button", className: "dsha-btn", disabled: !!busyId || pendingLogin || account.hasCredential === false, onClick: () => act("select", account) }, "切换到此账户") : null,
            h("button", { type: "button", className: "dsha-btn", disabled: !!busyId || account.hasCredential === false, onClick: () => act("quota", account) }, busyId === account.id ? "处理中…" : "查看额度"),
            h("button", { type: "button", className: "dsha-btn", disabled: !!busyId || pendingLogin, onClick: () => act("remove", account) }, "移除")),
          quotas[account.id] ? h("div", { className: "dsha-pool-quota" },
            h("p", { className: "dsha-note" }, `该账户独立查询 · ${new Date(quotas[account.id].fetchedAt).toLocaleTimeString()}`),
            (quotas[account.id].groups || []).map((group, index) => h(QuotaGroup, { key: index, group })),
            !(quotas[account.id].groups || []).length ? h("p", null, "上游未返回分组周限额") : null,
            (quotas[account.id].modelRows || []).filter(row => Number.isFinite(row.remainingPercent)).slice(0, 6).map(row => h("p", { key: row.id }, `${row.label || row.id} · 剩余 ${row.remainingPercent.toFixed(1)}%`))) : null,
        )) : h("p", { className: "dsha-note" }, "暂无账户。添加第一个账户后，再添加第二个即可。")),
        error ? h("div", { role: "alert", className: "dsha-error" }, error) : null,
      );
    }

    function AntigravitySettings({ ctx }) {
      const [requestApi, isLive] = useScopedApi();
      const [, setLocaleRev] = useState(0);
      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== "function") return;
        return ctx.locale.subscribe(() => {
          setLocaleRev((r) => r + 1);
        });
      }, [ctx]);

      const tr = useMemo(() => createTranslator(ctx), [ctx]);

      const [status, setStatus] = useState({ loading: true });
      const [quota, setQuota] = useState(undefined);
      const [modelConfig, setModelConfig] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [modelBusy, setModelBusy] = useState(false);
      const [error, setError] = useState("");
      const pollRef = useRef(undefined);

      const refreshStatus = useCallback(async () => {
        const value = await requestApi("/status");
        setStatus({ loading: false, ...value });
        if (value.quota) setQuota(value.quota);
        if (value.models) {
          setModelConfig(value.models);
          if (Array.isArray(value.models.options)) {
            updateQuotaCacheFromOptions(value.models.options, value.quota || value);
          }
        }
        return value;
      }, []);

      const refreshQuota = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const value = await requestApi("/quota", { method: "POST" });
          void ensurePoolLoaded();
          setQuota(value);
          if (value.models) {
            setModelConfig(value.models);
            if (Array.isArray(value.models.options)) {
              updateQuotaCacheFromOptions(value.models.options, value.quota || value);
            }
          }
          await refreshStatus();
        } catch (err) {
          if (isLive()) setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (isLive()) setBusy(false);
        }
      }, [refreshStatus]);

      useEffect(() => {
        installStyle();


        let cancelled = false;
        void refreshStatus()
          .then((value) => {
            if (!cancelled && value.authenticated) void refreshQuota();
          })
          .catch((err) => {
            if (!cancelled) {
              setStatus({ loading: false, authenticated: false });
              if (isLive()) setError(err instanceof Error ? err.message : String(err));
            }
          });
        return () => {
          cancelled = true;
          if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
      }, [refreshQuota, refreshStatus]);

      const startLogin = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const value = await requestApi("/login", { method: "POST" });
          if (value.authUrl) window.open(value.authUrl, "_blank", "noopener,noreferrer");
          if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
          pollRef.current = window.setInterval(async () => {
            try {
              const next = await refreshStatus();
              if (next.login && next.login.status === "complete") {
                window.clearInterval(pollRef.current);
                pollRef.current = undefined;
                await refreshQuota();
              }
              if (next.login && next.login.status === "error") {
                window.clearInterval(pollRef.current);
                pollRef.current = undefined;
                setError(next.login.error || tr("loginFailed"));
              }
            } catch (err) {
              if (isLive()) setError(err instanceof Error ? err.message : String(err));
            }
          }, 2000);
        } catch (err) {
          if (isLive()) setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (isLive()) setBusy(false);
        }
      }, [refreshQuota, refreshStatus, tr]);

      const logout = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const value = await requestApi("/logout", { method: "POST" });
          clearQuotaCache();
          invalidatePool();
          setStatus({ loading: false, ...value });
          setQuota(undefined);
        } catch (err) {
          if (isLive()) setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (isLive()) setBusy(false);
        }
      }, []);

      const saveModels = useCallback(async (enabledModelIds) => {
        setModelBusy(true);
        setError("");
        try {
          const value = await requestApi("/models", {
            method: "POST",
            body: JSON.stringify({ enabledModelIds }),
          });
          setModelConfig(value);
        } catch (err) {
          if (isLive()) setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (isLive()) setModelBusy(false);
        }
      }, []);

      const toggleModel = useCallback((modelId, enabled) => {
        const current = new Set(modelConfig && Array.isArray(modelConfig.enabledModelIds) ? modelConfig.enabledModelIds : []);
        if (enabled) current.add(modelId);
        else current.delete(modelId);
        void saveModels([...current]);
      }, [modelConfig, saveModels]);

      const setAllModels = useCallback((enabled) => {
        const ids = enabled && modelConfig && Array.isArray(modelConfig.options)
          ? modelConfig.options.map((option) => option.id)
          : [];
        void saveModels(ids);
      }, [modelConfig, saveModels]);

      const quotaGroups = useMemo(() => {
        if (!quota) return [];
        if (Array.isArray(quota.groups) && quota.groups.length > 0) {
          return quota.groups;
        }
        if (Array.isArray(quota.bucketRows) && quota.bucketRows.length > 0) {
          const map = new Map();
          for (const b of quota.bucketRows) {
            const grp = b.group || "Quota";
            if (!map.has(grp)) map.set(grp, []);
            map.get(grp).push(b);
          }
          return [...map.entries()].map(([displayName, buckets]) => ({ displayName, buckets }));
        }
        return [];
      }, [quota]);

      const fallbackModelRows = useMemo(() => {
        if (quotaGroups.length > 0) return [];
        if (!quota || !Array.isArray(quota.modelRows)) return [];
        return quota.modelRows.filter((row) => typeof row.remainingFraction === "number");
      }, [quota, quotaGroups]);

      const modelOptions = useMemo(() => {
        const options = modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options : [];
        return [...options].sort(compareAntigravityModelOptions);
      }, [modelConfig]);
      const plan = quota && quota.planLabel ? quota.planLabel : "";
      const isPro = /pro|paid|plus/i.test(plan);
      const email = status.email || (status.loading ? tr("loading") : tr("notSignedIn"));

      return React.createElement("div", { className: "dsha-wrap" },
        React.createElement("div", { className: "dsha-page-head" },
          React.createElement(AntigravityIcon, { size: 24, className: "dsha-brand-icon" }),
          React.createElement("h2", { className: "dsha-page-title" }, "Antigravity"),
        ),
        React.createElement("p", { className: "dsha-page-desc" }, tr("pageDesc")),
        React.createElement(AccountPoolPanel, {
          roster: status.accounts,
          pendingLogin: status.login?.status === "pending",
          onLogin: startLogin,
          onChanged: async () => { const next = await refreshStatus(); if (next.authenticated) await refreshQuota(); else setQuota(undefined); },
        }),
        React.createElement("details", { className: "dsha-card dsha-settings-detail" },
          React.createElement("summary", null, "登录状态与单号参考"),
          React.createElement("div", { className: "dsha-head" },
            React.createElement("div", { className: "dsha-title" },
              React.createElement(AntigravityIcon, { size: 18, className: "dsha-brand-icon" }),
              React.createElement("span", null, `${tr("currentAccount")} · 单号参考，非实际路由`),
            ),
            React.createElement("div", { className: "dsha-actions" },
              !status.authenticated && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy, onClick: startLogin }, busy ? tr("loggingIn") : tr("login")),
              status.authenticated && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy, onClick: refreshQuota }, busy ? tr("refreshing") : tr("refresh")),
              status.authenticated && React.createElement("button", { className: "dsha-btn", disabled: busy, onClick: logout }, tr("logout")),
            ),
          ),
          React.createElement("div", { className: "dsha-account" },
            React.createElement("div", { className: "dsha-email" },
              React.createElement("span", { className: "dsha-email-mark", "aria-hidden": "true" }),
              React.createElement("span", { className: "dsha-email-text" }, email),
            ),
            isPro && React.createElement("span", { className: "dsha-badge" },
              React.createElement("span", { className: "dsha-diamond", "aria-hidden": "true" }),
              "PRO",
            ),
          ),
          !status.authenticated && React.createElement("div", { className: "dsha-empty" }, tr("notSignedInDesc")),
          status.authenticated && !quota && React.createElement("div", { className: "dsha-empty" }, busy ? tr("fetchingQuota") : tr("noQuotaDesc")),
          status.authenticated && (quotaGroups.length > 0 || fallbackModelRows.length > 0) && React.createElement("div", { className: "dsha-quota-title" }, tr("quota")),
          status.authenticated && quotaGroups.map((group, index) => {
            const isCyan = /claude|gpt|3p|openai|anthropic/i.test(`${group.displayName || ""} ${group.description || ""}`);
            return React.createElement(QuotaGroup, {
              key: group.displayName || index,
              group,
              accent: isCyan ? "cyan" : "green",
              t: tr,
            });
          }),
          status.authenticated && quotaGroups.length === 0 && fallbackModelRows.map((row, index) => {
            const isCyan = /claude|gpt|3p|openai|anthropic/i.test(`${row.id || ""} ${row.label || ""}`);
            return React.createElement(QuotaRow, {
              key: row.id || row.label || index,
              row,
              accent: isCyan ? "cyan" : "green",
              t: tr,
            });
          }),
          error && React.createElement("div", { className: "dsha-error" }, error),
          quota && React.createElement("div", { className: "dsha-note" },
            tr("updatedAt", { time: new Date(quota.fetchedAt).toLocaleString() }),
          ),
        ),
        status.authenticated && React.createElement("details", { className: "dsha-card dsha-model-card dsha-settings-detail" },
          React.createElement("summary", null, `模型开关（${modelOptions.filter(option => option.enabled).length}/${modelOptions.length}）`),
          React.createElement("div", { className: "dsha-model-head" },
            React.createElement("div", null,
              React.createElement("div", { className: "dsha-model-title" }, tr("modelSelector")),
              React.createElement("div", { className: "dsha-model-desc" }, tr("modelSelectorDesc")),
            ),
            React.createElement("div", { className: "dsha-mini-actions" },
              React.createElement("button", { className: "dsha-mini-btn", disabled: modelBusy, onClick: () => setAllModels(true) }, tr("selectAll")),
              React.createElement("button", { className: "dsha-mini-btn", disabled: modelBusy, onClick: () => setAllModels(false) }, tr("unselectAll")),
            ),
          ),
          modelOptions.length === 0
            ? React.createElement("div", { className: "dsha-empty" }, tr("loadingModels"))
            : React.createElement("div", { className: "dsha-model-list" },
                modelOptions.map((option) => React.createElement(ModelOptionRow, {
                  key: option.id,
                  option,
                  disabled: modelBusy,
                  onToggle: toggleModel,
                  t: tr,
                })),
              ),
          React.createElement("div", { className: "dsha-note" }, tr("modelSelectorNote")),
        ),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        installStyle();

        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { zh, en });
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "antigravity",
          order: 12,
          label: () => "Antigravity",
        }, (props) => React.createElement(AntigravitySettings, { ...props, ctx })));

        ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
          name: "conversation.input.right",
          id: "antigravity-quota",
          order: 16,
        }, (props) => React.createElement(AntigravityComposerQuota, { ...props, ctx })));

        if (typeof ctx.effect === "function") ctx.effect(() => () => {
          quotaDisposed = true;
          quotaGeneration += 1;
          quotaController?.abort();
          stopPoolRequest();
          stopRuntime();
          runtimeListeners.clear();
          window.clearInterval(quotaTimer);
          window.clearInterval(poolTimer);
          quotaListeners.clear();
          poolListeners.clear();
        }, "antigravity: quota lifecycle");
      },
    };
  },
});
