"use strict";
/**
 * AdManager：微信小游戏广告变现 —— 激励视频 / 插屏 / Banner。
 *
 * 设计原则（平台规范 + 审核友好）：
 * 1) **全链路优雅降级**：基础库不支持、广告位 ID 未配置（占位）、加载/展示失败——
 *    任一情况广告能力自动视为不可用；激励场景降级为「免费发放」奖励，
 *    玩家永远不被卡住（审核期与流量主开通前体验完全不变）。
 * 2) 激励视频只由**用户主动点击**触发（提示配额用尽 / 金币翻倍），绝不强看。
 * 3) 插屏只在**通关结算退出**这一自然断点弹出，且三重频控：
 *    每 N 胜最多 1 次 + 两次最小间隔 + 会话次数上限。绝不在解谜过程中出现。
 * 4) Banner 仅在菜单/选关等非对局场景展示，对局中隐藏。
 *
 * 上线步骤：小游戏累计独立访客 ≥1000 后在 MP 后台开通流量主 →
 * 创建广告位 → 把 AD_UNITS 里的 ID 填上（或构造时传 units 覆盖）即生效。
 */

/** 广告位 ID：空 = 未开通流量主（广告自动禁用、激励场景全部免费） */
const AD_UNITS = {
  rewardedVideo: "", // 激励视频广告位 adunit-xxxx
  interstitial: "",  // 插屏广告位 adunit-xxxx
  banner: "",        // Banner 广告位 adunit-xxxx
};

class AdManager {
  /**
   * options: {
   *   analytics,        // AnalyticsManager（埋点 ad_* 事件）
   *   units,            // 覆盖 AD_UNITS（测试/多环境用）
   *   everyNWins,       // 插屏：两次数之间的最少胜场（默认 3）
   *   intervalMs,       // 插屏：两次之间的最小间隔毫秒（默认 90s）
   *   sessionCap,       // 插屏：本次会话最多展示次数（默认 6）
   *   now,              // 时钟注入（测试用）
   * }
   */
  constructor(options) {
    const o = options || {};
    this.analytics = o.analytics || null;
    this.units = Object.assign({}, AD_UNITS, o.units || {});
    this.everyNWins = o.everyNWins || 3;
    this.intervalMs = o.intervalMs || 90000;
    this.sessionCap = o.sessionCap || 6;
    this.now = o.now || function () { return Date.now(); };

    this._winCount = 0;
    this._lastInterstitialWin = 0;
    this._lastInterstitialAt = 0;
    this._sessionShown = 0;

    this._rewardedAd = null;
    this._rewardedErrCount = 0;
    this._rewardedBroken = false; // 连续失败 3 次后本会话不再尝试（直接免费发放）
    this._pendingReward = null;   // {reason, cb}（onClose/onError 只消费一次）

    this._interstitialAd = null;
    this._interstitialBroken = false;

    this._bannerAd = null;
    this._bannerBroken = false;
    this.bannerVisible = false;   // UI 据此避让底部布局
  }

  _track(event, data) {
    if (this.analytics && this.analytics.track) {
      try { this.analytics.track(event, data); } catch (e) { /* 埋点失败不致命 */ }
    }
  }

  // ---------------- 激励视频 ----------------

  /** 激励视频当前是否可用（不可用时 UI 不应展示任何"看视频"入口） */
  isRewardedAvailable() {
    return !!(typeof wx !== "undefined" && wx.createRewardedVideoAd &&
      this.units.rewardedVideo && !this._rewardedBroken);
  }

  _ensureRewarded() {
    if (this._rewardedAd) return this._rewardedAd;
    const ad = wx.createRewardedVideoAd({ adUnitId: this.units.rewardedVideo });
    ad.onClose((res) => {
      const p = this._pendingReward;
      this._pendingReward = null;
      if (!p) return; // 已被 onError/catch 兜底消费
      // isEnded 明确为 false = 中途跳过不发奖励；老基础库无 res 时按看完处理（宽松）
      const ended = !res || res.isEnded !== false;
      if (ended) {
        this._track("ad_reward_earned", { reason: p.reason, via: "ad" });
        p.cb({ granted: true, via: "ad" });
      } else {
        this._track("ad_reward_skipped", { reason: p.reason });
        p.cb({ granted: false, via: "skip" });
      }
    });
    ad.onError(() => {
      this._rewardedErrCount++;
      if (this._rewardedErrCount >= 3) {
        this._rewardedBroken = true; // 本会话彻底降级为免费
        this._rewardedAd = null;
      }
      this._grantFallback();
    });
    this._rewardedAd = ad;
    return ad;
  }

  /** 广告不可用/失败：免费发放奖励（玩家永远不被卡住） */
  _grantFallback() {
    const p = this._pendingReward;
    this._pendingReward = null;
    if (!p) return;
    this._track("ad_reward_fallback", { reason: p.reason });
    p.cb({ granted: true, via: "fallback" });
  }

  /**
   * 请求一次激励视频（只应在用户主动点击时调用）。
   * cb({granted, via})：
   *   via "ad"       = 完整看完，发放奖励；
   *   via "fallback" = 广告不可用/加载失败，免费发放（体验无损）；
   *   via "skip"     = 用户中途跳过，未发放（可再次点击重试）。
   */
  requestReward(reason, cb) {
    const callback = cb || function () {};
    if (!this.isRewardedAvailable()) {
      this._track("ad_reward_fallback", { reason });
      callback({ granted: true, via: "fallback" });
      return;
    }
    this._track("ad_prompt_shown", { reason });
    const ad = this._ensureRewarded();
    this._pendingReward = { reason, cb: callback };
    const p = ad.show();
    if (p && p.catch) {
      p.catch(() => {
        ad.load().then(() => ad.show()).catch(() => this._grantFallback());
      });
    }
  }

  // ---------------- 插屏（频控） ----------------

  /** 每次通关计一胜（供频控） */
  notifyWin() { this._winCount++; }

  /**
   * 通关结算页退出等自然断点调用；满足频控才真正展示。
   * 返回是否触发展示。
   */
  maybeShowInterstitial() {
    if (typeof wx === "undefined" || !wx.createInterstitialAd || !this.units.interstitial) return false;
    if (this._interstitialBroken) return false;
    if (this._sessionShown >= this.sessionCap) return false;
    if (this._winCount - this._lastInterstitialWin < this.everyNWins) return false;
    const t = this.now();
    if (t - this._lastInterstitialAt < this.intervalMs) return false;
    let ad = this._interstitialAd;
    if (!ad) {
      ad = wx.createInterstitialAd({ adUnitId: this.units.interstitial });
      if (ad.onError) ad.onError(() => { this._interstitialBroken = true; });
      this._interstitialAd = ad;
    }
    this._lastInterstitialWin = this._winCount;
    this._lastInterstitialAt = t;
    this._sessionShown++;
    this._track("interstitial_shown", { wins: this._winCount });
    const p = ad.show();
    if (p && p.catch) p.catch(() => { /* 未就绪：静默跳过，不重试 */ });
    return true;
  }

  // ---------------- Banner（仅非对局场景） ----------------

  showBanner() {
    if (typeof wx === "undefined" || !wx.createBannerAd || !this.units.banner || this._bannerBroken) return;
    if (!this._bannerAd) {
      const info = wx.getWindowInfo
        ? wx.getWindowInfo()
        : { windowWidth: 375, windowHeight: 667 };
      const w = info.windowWidth;
      const ad = wx.createBannerAd({
        adUnitId: this.units.banner,
        style: { left: 0, top: info.windowHeight - Math.round(w * 0.4), width: w },
      });
      if (ad.onResize) {
        ad.onResize((size) => {
          // 按实际高度贴底，避免遮住内容
          if (size && size.height) ad.style.top = info.windowHeight - size.height;
        });
      }
      if (ad.onError) ad.onError(() => { this._bannerBroken = true; this.bannerVisible = false; });
      this._bannerAd = ad;
    }
    const p = this._bannerAd.show();
    if (p && p.then) {
      p.then(() => { this.bannerVisible = true; }).catch(() => { this.bannerVisible = false; });
    } else {
      this.bannerVisible = true;
    }
    this._track("banner_shown", {});
  }

  hideBanner() {
    this.bannerVisible = false;
    if (this._bannerAd) {
      try { this._bannerAd.hide(); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { AdManager, AD_UNITS };
