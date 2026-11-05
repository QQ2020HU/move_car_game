"use strict";
/**
 * 广告变现测试（Node 运行：node tests/test_ads.js）。
 * 覆盖 AdManager 单元测试（降级 / 看完发放 / 跳过 / 出错兜底 / 插屏频控 / Banner）
 * 与 UIManager 集成（提示配额闸门、看视频解锁本关不限次、金币奖励与翻倍、结算退出插屏）。
 * 核心原则验证：广告任何状态（不支持 / 未配置 / 加载失败 / 中途出错）下，
 * 玩家永远不被卡住 —— 激励场景自动降级为免费发放。
 */

const assert = require("assert");

// ---------------- 全局桩件（与 test_ui_smoke.js 同款） ----------------
function makeCtxStub() {
  const handler = {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (!(p in t)) t[p] = function () { return stub; };
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
    apply() { return stub; },
  };
  const stub = new Proxy(function () {}, handler);
  return stub;
}

const touchHandlers = {};
global.requestAnimationFrame = () => 0; // 不启动渲染循环，手动驱动
global.GameGlobal = {};
global.wx = {
  createCanvas: () => ({ width: 0, height: 0, getContext: makeCtxStub }),
  getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, pixelRatio: 2, safeArea: { top: 44 } }),
  onTouchStart: (cb) => { touchHandlers.start = cb; },
  onTouchMove: (cb) => { touchHandlers.move = cb; },
  onTouchEnd: (cb) => { touchHandlers.end = cb; },
  onTouchCancel: (cb) => { touchHandlers.cancel = cb; },
  onWindowResize: () => {},
  onHide: (cb) => { touchHandlers.hide = cb; },
  onShow: (cb) => { touchHandlers.show = cb; },
  getStorageSync: () => null,
  setStorageSync: () => {},
  vibrateShort: () => {},
  // 广告 API（createRewardedVideoAd / createInterstitialAd / createBannerAd）
  // 由各用例按需注入 —— 缺失即触发 AdManager 的降级路径。
};

const { UIManager } = require("../js/ui/UIManager.js");
const { GameManager, GameState } = require("../js/core/GameManager.js");
const { LevelManager } = require("../js/level/LevelManager.js");
const { SaveManager } = require("../js/save/SaveManager.js");
const { AnalyticsManager } = require("../js/platform/AnalyticsManager.js");
const { AudioManager } = require("../js/ui/AudioManager.js");
const { AdManager, AD_UNITS } = require("../js/platform/AdManager.js");

// ---------------- 测试框架（支持 async 用例，顺序执行） ----------------
let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function run() {
  console.log("\n[广告变现测试]");
  for (const t of queue) {
    try { await t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
    catch (e) { failed++; console.error(`  ✗ ${t.name}\n    ${e && e.message}`); }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

// ---------------- 广告桩件 ----------------
let lastRewardedAd = null;
let rewardedDefaults = null; // 创建时注入的失败配置（failShows/failLoads 次数）
function makeFakeRewardedAd() {
  const ad = {
    shown: 0, loadCount: 0,
    failShows: 0, failLoads: 0, // 前 N 次 show/load 拒绝（模拟未就绪/无填充）
    _closeCb: null, _errCb: null,
    load() {
      ad.loadCount++;
      if (ad.failLoads > 0) { ad.failLoads--; return Promise.reject(new Error("no fill")); }
      return Promise.resolve();
    },
    show() {
      ad.shown++;
      if (ad.failShows > 0) { ad.failShows--; return Promise.reject(new Error("no fill")); }
      return Promise.resolve();
    },
    onClose(cb) { ad._closeCb = cb; },
    onError(cb) { ad._errCb = cb; },
    simulateClose(isEnded) { if (ad._closeCb) ad._closeCb({ isEnded }); },
    simulateCloseLegacy() { if (ad._closeCb) ad._closeCb(); }, // 老基础库：无 res
    simulateError() { if (ad._errCb) ad._errCb({ errCode: 1004, errMsg: "no fill" }); },
  };
  return ad;
}
function installRewardedApi() {
  wx.createRewardedVideoAd = (opts) => {
    lastRewardedAd = makeFakeRewardedAd();
    lastRewardedAd.opts = opts;
    if (rewardedDefaults) Object.assign(lastRewardedAd, rewardedDefaults);
    return lastRewardedAd;
  };
}

let fakeInterstitial = null;
function installInterstitialApi() {
  wx.createInterstitialAd = () => {
    const ad = {
      shown: 0,
      show() { ad.shown++; return Promise.resolve(); },
      onError() {},
    };
    fakeInterstitial = ad;
    return ad;
  };
}

let lastBannerAd = null;
function installBannerApi() {
  wx.createBannerAd = (opts) => {
    const ad = {
      style: Object.assign({}, opts.style),
      shown: 0, hidden: 0,
      _rsCb: null,
      show() { ad.shown++; return Promise.resolve(); },
      hide() { ad.hidden++; },
      onResize(cb) { ad._rsCb = cb; },
      onError() {},
    };
    lastBannerAd = ad;
    return ad;
  };
}

function makeRec() {
  const evs = [];
  return { evs, analytics: { track: (e, d) => evs.push([e, d || {}]) } };
}
const tick = () => new Promise((r) => setTimeout(r, 0)); // 冲刷 promise 链

// ---------------- UI 集成组装（ads 全量配置 + 宽松频控） ----------------
const analytics = new AnalyticsManager({ silent: true });
const save = new SaveManager();
const levels = new LevelManager();
const gm = new GameManager(analytics);
const audio = new AudioManager(save);
const adRec = makeRec();
const uiAds = new AdManager({
  analytics: adRec.analytics,
  units: { rewardedVideo: "adunit-test", interstitial: "adunit-i", banner: "adunit-b" },
  everyNWins: 1, intervalMs: 1, sessionCap: 99,
});
const canvas = wx.createCanvas();
const ui = new UIManager(canvas, { gameManager: gm, levelManager: levels, saveManager: save, audio, analytics, ads: uiAds });

function findBtn(x, y, w, h) {
  return ui.buttons.find((b) => b.x === x && b.y === y && b.w === w && b.h === h);
}
function tap(x, y) {
  touchHandlers.start({ touches: [{ clientX: x, clientY: y }] });
}
function enterLevel(idx) {
  ui.startLevel(idx);
  ui.chapterCard = null; // 章节过场卡片直接跳过
  ui.overlay = null;
  assert.strictEqual(ui.scene, "game");
}
// adHint 弹层（ph=330）与胜利弹层（ph=434，含最优解回放按钮行）的确定性布局
const PW = Math.min(320, ui.W - 48), PX = (ui.W - PW) / 2, BX = PX + 28, BW = PW - 56;
const PY_HINT = (ui.H - 330) / 2 - 20;
const PY_WIN = (ui.H - 434) / 2 - 20;
const CX = ui.W / 2;

// ================= AdManager 单元测试 =================

test("出厂默认：AD_UNITS 全空 → 广告整体禁用（上线前体验不变的保证）", () => {
  assert.strictEqual(AD_UNITS.rewardedVideo, "");
  assert.strictEqual(AD_UNITS.interstitial, "");
  assert.strictEqual(AD_UNITS.banner, "");
  const ads = new AdManager({});
  assert.strictEqual(ads.isRewardedAvailable(), false);
  assert.strictEqual(ads.maybeShowInterstitial(), false);
  ads.showBanner(); // 不应抛异常
  assert.strictEqual(ads.bannerVisible, false);
});

test("基础库无激励视频 API → requestReward 立即免费发放（fallback）", () => {
  delete wx.createRewardedVideoAd;
  const rec = makeRec();
  const ads = new AdManager({ analytics: rec.analytics, units: { rewardedVideo: "adunit-x" } });
  assert.strictEqual(ads.isRewardedAvailable(), false);
  let got = null;
  ads.requestReward("hint", (r) => { got = r; });
  assert.deepStrictEqual(got, { granted: true, via: "fallback" });
  assert.ok(rec.evs.some((e) => e[0] === "ad_reward_fallback"));
});

test("广告位 ID 未配置（占位）→ 同样降级免费发放", () => {
  installRewardedApi(); // wx API 存在，但 units.rewardedVideo 为空
  const rec = makeRec();
  const ads = new AdManager({ analytics: rec.analytics, units: {} });
  assert.strictEqual(ads.isRewardedAvailable(), false);
  let got = null;
  ads.requestReward("double", (r) => { got = r; });
  assert.deepStrictEqual(got, { granted: true, via: "fallback" });
});

test("完整看完激励视频 → via 'ad' 发放；回调只消费一次；老基础库无 res 按看完处理", () => {
  const rec = makeRec();
  const ads = new AdManager({ analytics: rec.analytics, units: { rewardedVideo: "adunit-test" } });
  assert.strictEqual(ads.isRewardedAvailable(), true);
  let got = null, calls = 0;
  ads.requestReward("hint", (r) => { got = r; calls++; });
  assert.strictEqual(lastRewardedAd.shown, 1, "应拉起视频");
  assert.strictEqual(lastRewardedAd.opts.adUnitId, "adunit-test");
  lastRewardedAd.simulateClose(true);
  assert.deepStrictEqual(got, { granted: true, via: "ad" });
  lastRewardedAd.simulateClose(true); // 重复回调不应二次发放
  assert.strictEqual(calls, 1);
  assert.ok(rec.evs.some((e) => e[0] === "ad_prompt_shown"));
  assert.ok(rec.evs.some((e) => e[0] === "ad_reward_earned"));
  // 老基础库：onClose 无参数 → 宽松按看完处理
  let got2 = null;
  ads.requestReward("double", (r) => { got2 = r; });
  lastRewardedAd.simulateCloseLegacy();
  assert.deepStrictEqual(got2, { granted: true, via: "ad" });
});

test("用户中途跳过（isEnded=false）→ 不发放；可再次点击重试", () => {
  const rec = makeRec();
  const ads = new AdManager({ analytics: rec.analytics, units: { rewardedVideo: "adunit-test" } });
  let got = null;
  ads.requestReward("hint", (r) => { got = r; });
  lastRewardedAd.simulateClose(false);
  assert.deepStrictEqual(got, { granted: false, via: "skip" });
  assert.ok(rec.evs.some((e) => e[0] === "ad_reward_skipped"));
  // 重试：看完 → 发放
  let got2 = null;
  ads.requestReward("hint", (r) => { got2 = r; });
  lastRewardedAd.simulateClose(true);
  assert.deepStrictEqual(got2, { granted: true, via: "ad" });
});

test("视频出错 → 立即免费兜底；连续 3 次出错本会话标记 broken 彻底降级", () => {
  const rec = makeRec();
  const ads = new AdManager({ analytics: rec.analytics, units: { rewardedVideo: "adunit-test" } });
  for (let i = 0; i < 3; i++) {
    let got = null;
    ads.requestReward("hint", (r) => { got = r; });
    lastRewardedAd.simulateError();
    assert.deepStrictEqual(got, { granted: true, via: "fallback" }, `第 ${i + 1} 次出错应免费发放`);
  }
  assert.strictEqual(ads._rewardedBroken, true);
  assert.strictEqual(ads.isRewardedAvailable(), false);
  // broken 后不再创建/拉起广告，直接同步免费发放
  const adBefore = lastRewardedAd;
  const shownBefore = adBefore.shown; // 前 3 次 requestReward 各拉起过一次
  assert.strictEqual(shownBefore, 3);
  let got = null;
  ads.requestReward("hint", (r) => { got = r; });
  assert.deepStrictEqual(got, { granted: true, via: "fallback" });
  assert.strictEqual(lastRewardedAd, adBefore, "不应再创建新广告实例");
  assert.strictEqual(adBefore.shown, shownBefore, "broken 后不应再拉起视频");
});

test("show 失败 → load+show 重试成功 → 看完仍正常发放", async () => {
  rewardedDefaults = { failShows: 1 }; // 仅首次 show 拒绝
  const ads = new AdManager({ units: { rewardedVideo: "adunit-test" } });
  let got = null;
  ads.requestReward("hint", (r) => { got = r; });
  await tick();
  assert.strictEqual(lastRewardedAd.loadCount, 1, "应触发 load 重试");
  assert.strictEqual(lastRewardedAd.shown, 2, "重试后二次 show");
  assert.strictEqual(got, null, "重试成功不应走兜底");
  lastRewardedAd.simulateClose(true);
  assert.deepStrictEqual(got, { granted: true, via: "ad" });
  rewardedDefaults = null;
});

test("show/load 全部失败 → 免费兜底发放", async () => {
  const rec = makeRec();
  rewardedDefaults = { failShows: 9, failLoads: 9 };
  const ads = new AdManager({ analytics: rec.analytics, units: { rewardedVideo: "adunit-test" } });
  let got = null;
  ads.requestReward("hint", (r) => { got = r; });
  await tick();
  assert.deepStrictEqual(got, { granted: true, via: "fallback" });
  assert.ok(rec.evs.some((e) => e[0] === "ad_reward_fallback"));
  rewardedDefaults = null;
});

test("插屏频控：每 N 胜 + 最小间隔双重闸门", () => {
  installInterstitialApi();
  let clock = 1000;
  const ads = new AdManager({
    units: { interstitial: "adunit-i" },
    everyNWins: 2, intervalMs: 50, sessionCap: 9,
    now: () => clock,
  });
  const seq = [];
  ads.notifyWin(); clock += 10; seq.push(ads.maybeShowInterstitial()); // 1 胜 <2 → false
  ads.notifyWin(); clock += 10; seq.push(ads.maybeShowInterstitial()); // 2 胜且距上次(0)够久 → true
  ads.notifyWin(); clock += 10; seq.push(ads.maybeShowInterstitial()); // 距上次展示仅 1 胜 → false
  ads.notifyWin(); clock += 10; seq.push(ads.maybeShowInterstitial()); // 2 胜但间隔 20ms<50 → false
  clock += 100; seq.push(ads.maybeShowInterstitial());                 // 补足间隔 → true
  ads.notifyWin(); clock += 10; seq.push(ads.maybeShowInterstitial()); // 1 胜 → false
  assert.deepStrictEqual(seq, [false, true, false, false, true, false]);
  assert.strictEqual(fakeInterstitial.shown, 2);
});

test("插屏频控：会话上限硬性截止；未配置广告位永不弹", () => {
  let clock = 5000;
  const ads = new AdManager({
    units: { interstitial: "adunit-i" },
    everyNWins: 1, intervalMs: 1, sessionCap: 2,
    now: () => clock,
  });
  const before = fakeInterstitial;
  const seq = [];
  for (let i = 0; i < 4; i++) {
    ads.notifyWin(); clock += 100;
    seq.push(ads.maybeShowInterstitial());
  }
  assert.deepStrictEqual(seq, [true, true, false, false]);
  assert.notStrictEqual(fakeInterstitial, before, "本实例应创建自己的插屏广告");
  assert.strictEqual(fakeInterstitial.shown, 2, "会话上限 2 次后不再展示");
  // 未配置插屏广告位 → 永不弹（也不创建实例）
  const ads2 = new AdManager({ units: {} });
  ads2.notifyWin();
  assert.strictEqual(ads2.maybeShowInterstitial(), false);
});

test("Banner：贴底定位 / onResize 校正 / show-hide 状态；无 API 时静默降级", async () => {
  installBannerApi();
  const ads = new AdManager({ units: { banner: "adunit-b" } });
  ads.showBanner();
  await tick();
  assert.strictEqual(ads.bannerVisible, true);
  assert.strictEqual(lastBannerAd.shown, 1);
  assert.strictEqual(lastBannerAd.style.width, 390);
  lastBannerAd._rsCb({ width: 390, height: 100 });
  assert.strictEqual(lastBannerAd.style.top, 844 - 100, "按实际高度贴底");
  ads.hideBanner();
  assert.strictEqual(ads.bannerVisible, false);
  assert.strictEqual(lastBannerAd.hidden, 1);
  // 无 createBannerAd API → 静默 no-op
  delete wx.createBannerAd;
  const ads2 = new AdManager({ units: { banner: "adunit-b" } });
  ads2.showBanner();
  assert.strictEqual(ads2.bannerVisible, false);
});

// ================= UIManager 集成 =================

test("提示配额：前 3 次免费直达，第 4 次弹「看视频解锁」层", () => {
  enterLevel(0);
  assert.strictEqual(ui._hintFreeUsed, 0);
  assert.strictEqual(ui._hintUnlimited, false);
  assert.ok(gm.tryMove("car_a", -1), "开局挪阻挡车（进入 PLAYING 态）");
  assert.strictEqual(gm.state, GameState.PLAYING);
  for (let i = 1; i <= 3; i++) {
    ui._useHint();
    assert.strictEqual(ui.overlay, null, `第 ${i} 次提示应免费直达`);
    assert.ok(ui.hint && ui.hint.vehicleId === "car_red", "应高亮目标车");
    assert.strictEqual(ui._hintFreeUsed, i);
  }
  ui.hint = null;
  ui._useHint(); // 第 4 次 → 闸门
  assert.strictEqual(ui.overlay, "adHint");
  ui._render();
  assert.ok(findBtn(BX, PY_HINT + 142, BW, 46), "应有「观看视频」按钮");
  assert.ok(findBtn(BX, PY_HINT + 202, BW, 42), "应有「暂不需要」按钮");
});

test("看视频解锁本关不限次：广告触发 onHide 自动暂停 → 看完自动恢复并兑现提示", () => {
  // 接上一用例：overlay === "adHint"，按钮命中区已构建
  tap(BX + BW / 2, PY_HINT + 142 + 23); // 点「观看视频」
  assert.strictEqual(lastRewardedAd.shown, 1, "应拉起激励视频");
  // 广告播放 → 小游戏切后台 → onAppHide 自动暂停（覆盖 adHint 层）
  touchHandlers.hide();
  assert.strictEqual(gm.state, GameState.PAUSED);
  assert.strictEqual(ui.overlay, "pause");
  // 看完 → 奖励回调：先恢复对局，再兑现提示
  lastRewardedAd.simulateClose(true);
  assert.strictEqual(ui._hintUnlimited, true);
  assert.strictEqual(ui.overlay, null, "应收起暂停层回到对局");
  assert.strictEqual(gm.state, GameState.PLAYING, "广告结束应自动恢复");
  assert.ok(ui.hint && ui.hint.vehicleId === "car_red", "应立即兑现本次提示");
  // 不限次：继续点提示不再弹层
  ui._useHint();
  assert.strictEqual(ui.overlay, null);
  assert.ok(ui.hint);
  // 重开新一局：配额与解锁状态重置
  enterLevel(0);
  assert.strictEqual(ui._hintFreeUsed, 0);
  assert.strictEqual(ui._hintUnlimited, false);
});

test("中途跳过视频 → 不解锁不扣配额，回到对局；再次点提示重新弹层；「暂不需要」可关闭", () => {
  for (let i = 0; i < 3; i++) ui._useHint();
  ui._useHint();
  assert.strictEqual(ui.overlay, "adHint");
  ui._render();
  tap(BX + BW / 2, PY_HINT + 142 + 23); // 观看视频
  lastRewardedAd.simulateClose(false);  // 中途跳过
  assert.strictEqual(ui.overlay, null, "跳过后应回到对局");
  assert.strictEqual(ui._hintUnlimited, false);
  assert.strictEqual(ui._hintFreeUsed, 3, "跳过不应扣配额");
  assert.strictEqual(gm.state, GameState.READY, "未开局不触发暂停");
  ui._useHint(); // 再点 → 重新弹层
  assert.strictEqual(ui.overlay, "adHint");
  ui._render();
  tap(BX + BW / 2, PY_HINT + 202 + 21); // 暂不需要
  assert.strictEqual(ui.overlay, null);
});

test("金币：通关奖励 星数×10 入账；结算页看视频翻倍一次；退出结算触发插屏", () => {
  enterLevel(0);
  const coins0 = save.data.coins;
  const interAdBefore = fakeInterstitial; // 之前用例的插屏实例（uiAds 尚未创建自己的）
  assert.ok(gm.tryMove("car_a", -1));
  assert.ok(gm.tryMove("car_red", 5), "目标车出库 → 胜利");
  assert.ok(gm.pendingWin, "应产生胜利结算");
  assert.strictEqual(ui.winCoins, 30, "2 步 = par → 3 星 ×10");
  assert.strictEqual(save.data.coins, coins0 + 30);
  assert.strictEqual(ui.winCoinsDoubled, false);
  // 手动展开胜利弹层（真实路径由出库动画 onDone 设置）
  ui.overlay = "win";
  ui._render();
  assert.ok(findBtn(CX + 8, PY_WIN + 199, 132, 34), "应有「金币 ×2」按钮");
  tap(CX + 8 + 66, PY_WIN + 199 + 17);
  lastRewardedAd.simulateClose(true);
  assert.strictEqual(ui.winCoinsDoubled, true);
  assert.strictEqual(save.data.coins, coins0 + 60, "翻倍应再入账 30");
  ui._render();
  assert.ok(!findBtn(CX + 8, PY_WIN + 199, 132, 34), "已翻倍后按钮应消失");
  // 点「下一关」退出结算 → 自然断点触发插屏（频控满足）
  tap(BX + BW / 2, PY_WIN + 246 + 23);
  assert.notStrictEqual(fakeInterstitial, interAdBefore, "uiAds 应创建并拉起插屏");
  assert.strictEqual(fakeInterstitial.shown, 1, "应展示一次插屏");
  assert.strictEqual(gm.levelData.id, "level_002");
  assert.ok(save.data.unlockedLevel >= 1, "应解锁第 2 关");
});

test("广告能力缺失 → 全程降级：提示 6 次不弹层、结算页无翻倍按钮、金币照常入账", () => {
  delete wx.createRewardedVideoAd;
  delete wx.createInterstitialAd;
  enterLevel(2); // level_003
  assert.strictEqual(ui.ads.isRewardedAvailable(), false);
  for (let i = 1; i <= 6; i++) {
    ui._useHint();
    assert.strictEqual(ui.overlay, null, `无广告能力时第 ${i} 次提示应免费`);
    assert.ok(ui.hint || ui.hintPending, "提示应交付（或后台搜索中）");
  }
  assert.strictEqual(ui._hintFreeUsed, 6, "无闸门时配额只计数不拦截");
  const coins1 = save.data.coins;
  for (const mv of levels.getLevel(2).solution) {
    assert.ok(gm.tryMove(mv.vehicleId, mv.delta), "按参考解回放应全部成功");
  }
  assert.ok(gm.pendingWin);
  assert.ok(ui.winCoins > 0);
  assert.strictEqual(save.data.coins, coins1 + ui.winCoins, "金币奖励与广告无关");
  ui.overlay = "win";
  ui._render();
  assert.ok(!findBtn(CX + 8, PY_WIN + 199, 132, 34), "无广告能力不应渲染翻倍按钮");
  // 恢复广告 API（保持环境干净）
  installRewardedApi();
  installInterstitialApi();
});

run();
