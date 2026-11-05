"use strict";
/**
 * 第一梯队玩法扩展回归测试（Node 运行：node tests/test_meta.js）。
 * 覆盖三个新特性：
 * ① 失败态 + 复活：步数上限（par 推导，教学关豁免）→ FAIL → 广告/金币复活；
 * ② 金币商店：spendCoins / 皮肤购买 / 装备持久化 / 旧存档兼容；
 * ③ 通关后最优解幽灵回放：solution 逐步动画、不计步、可跳过。
 * 桩件与 test_ui_smoke.js 同源（wx/canvas/rAF 全模拟，无真实渲染）。
 */

const assert = require("assert");

// ---------------- 全局桩件 ----------------
function makeCtxStub() {
  // 万能链式桩：任意属性读取返回可调用对象，调用后仍返回自身
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
  onShow: () => {},
  getStorageSync: () => null,
  setStorageSync: () => {},
  vibrateShort: () => {},
};

const { UIManager } = require("../js/ui/UIManager.js");
const { GameManager, GameState } = require("../js/core/GameManager.js");
const { StateMachine } = require("../js/core/GameState.js");
const { LevelManager } = require("../js/level/LevelManager.js");
const { SaveManager } = require("../js/save/SaveManager.js");
const { AnalyticsManager } = require("../js/platform/AnalyticsManager.js");
const { AudioManager } = require("../js/ui/AudioManager.js");
const skins = require("../js/ui/skins.js");
const LEVELS = require("../js/data/levels.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function memStorage() {
  const mem = {};
  return {
    mem,
    get(key) { return key in mem ? mem[key] : null; },
    set(key, value) { mem[key] = value; },
  };
}

// 合成关卡：par 6 → 上限 12；b 车可来回挪消耗步数且永不触发胜利
function synthetic() {
  return {
    id: "t_fail", title: "限步测试", rows: 6, cols: 6,
    exit: { side: "RIGHT", row: 0 },
    targetVehicleId: "r", parMoves: 6,
    vehicles: [
      { id: "r", x: 0, y: 0, length: 2, orientation: "H", isTarget: true },
      { id: "b", x: 5, y: 2, length: 2, orientation: "V" },
    ],
    solution: [{ vehicleId: "r", delta: 6 }],
    difficulty: "test",
  };
}

console.log("\n[第一梯队玩法扩展测试]");

// ---------------- ① 失败态 + 复活（规则层） ----------------

test("moveLimit 推导：par≤5 教学关不限步；par>5 ≈ 1.8~2×par；全量关卡符合", () => {
  const gm = new GameManager();
  assert.strictEqual(gm.computeMoveLimit({ parMoves: 2 }), 0);
  assert.strictEqual(gm.computeMoveLimit({ parMoves: 5 }), 0);
  assert.strictEqual(gm.computeMoveLimit({ parMoves: 6 }), 12);
  assert.strictEqual(gm.computeMoveLimit({ parMoves: 9 }), 17);
  assert.strictEqual(gm.computeMoveLimit({ parMoves: 13 }), 24);
  assert.strictEqual(gm.computeMoveLimit({ parMoves: 16 }), 29);
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(gm.computeMoveLimit(LEVELS[i]), 0, `第 ${i + 1} 关（教学期）应不限步`);
  }
  for (let i = 10; i < LEVELS.length; i++) {
    const lim = gm.computeMoveLimit(LEVELS[i]);
    assert.ok(lim > LEVELS[i].parMoves, `第 ${i + 1} 关上限应大于 par`);
    assert.ok(lim <= LEVELS[i].parMoves * 2.2, `第 ${i + 1} 关上限不应苛刻（≤2.2×par）`);
  }
});

test("状态机：FAIL 只能由 ANIMATING 进入；FAIL→PLAYING（复活）/READY/LOADING；FAIL→WIN 非法", () => {
  const sm = new StateMachine();
  sm.state = GameState.ANIMATING;
  assert.ok(sm.canTransition(GameState.FAIL), "ANIMATING→FAIL 合法（与 WIN 对称）");
  sm.state = GameState.PLAYING;
  assert.ok(!sm.canTransition(GameState.FAIL), "PLAYING 不可直接跳 FAIL");
  sm.state = GameState.FAIL;
  assert.ok(sm.canTransition(GameState.PLAYING), "FAIL→PLAYING（复活）");
  assert.ok(sm.canTransition(GameState.READY));
  assert.ok(sm.canTransition(GameState.LOADING));
  assert.ok(!sm.canTransition(GameState.WIN), "FAIL 不可直接通关");
});

test("步数耗尽 → pendingFail + ANIMATING → endAnimating → FAIL；FAIL 锁定全部对局操作", () => {
  const events = [];
  const gm = new GameManager({ track: (e, d) => events.push([e, d]) });
  gm.loadLevel(synthetic());
  assert.strictEqual(gm.moveLimit, 12);
  let failInfo = null;
  gm.on("onFail", (info) => { failInfo = info; });
  gm.beginPlay();
  for (let i = 0; i < 11; i++) {
    const r = gm.tryMove("b", i % 2 === 0 ? 1 : -1);
    assert.ok(r.ok && !r.win, `第 ${i + 1} 步应合法未胜`);
    assert.strictEqual(gm.state, GameState.PLAYING, "未到上限不进入失败流程");
  }
  const last = gm.tryMove("b", 1); // 第 12 步 = 上限
  assert.ok(last.ok && !last.win);
  assert.strictEqual(gm.moves, 12);
  assert.strictEqual(gm.pendingFail, true, "达上限应标记 pendingFail");
  assert.strictEqual(gm.state, GameState.ANIMATING, "等吸附动画结束再 FAIL");
  assert.ok(failInfo && failInfo.moves === 12 && failInfo.moveLimit === 12, "onFail 回调");
  assert.ok(events.some(([e]) => e === "level_fail"), "应有 level_fail 埋点");
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.FAIL);
  // FAIL 锁定：不能挪车 / 不能撤销 / 不能暂停
  assert.strictEqual(gm.tryMove("b", -1).ok, false);
  assert.strictEqual(gm.undo(), false);
  assert.strictEqual(gm.pause(), false);
  // 重开可用（FAIL→LOADING→READY）
  gm.restart();
  assert.strictEqual(gm.state, GameState.READY);
  assert.strictEqual(gm.moves, 0);
  assert.strictEqual(gm.moveLimit, 12, "重开恢复初始上限");
});

test("撤销退还步数：净步数才消耗上限（挪 11 + 撤 1 + 挪 2 才失败）", () => {
  const gm = new GameManager();
  gm.loadLevel(synthetic());
  gm.beginPlay();
  for (let i = 0; i < 11; i++) gm.tryMove("b", i % 2 === 0 ? 1 : -1);
  assert.strictEqual(gm.moves, 11);
  assert.ok(gm.undo(), "撤销应成功");
  assert.strictEqual(gm.moves, 10, "撤销退还步数");
  assert.strictEqual(gm.state, GameState.PLAYING);
  gm.tryMove("b", -1); // 11
  assert.strictEqual(gm.pendingFail, false);
  gm.tryMove("b", 1);  // 12 → 失败
  assert.strictEqual(gm.pendingFail, true);
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.FAIL);
});

test("胜利优先于失败：压线一步恰好通关 → WIN 而非 FAIL", () => {
  const gm = new GameManager();
  gm.loadLevel(synthetic());
  gm.beginPlay();
  for (let i = 0; i < 11; i++) gm.tryMove("b", i % 2 === 0 ? 1 : -1);
  const exitMove = gm.board.generateMoves().find((m) => m.isExit);
  assert.ok(exitMove && exitMove.id === "r", "目标车应有出库移动");
  const r = gm.tryMove(exitMove.id, exitMove.delta); // 第 12 步 = 上限，但通关
  assert.ok(r.ok && r.win);
  assert.strictEqual(gm.pendingFail, false, "胜利优先，不标记失败");
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.WIN);
});

test("复活：FAIL→PLAYING，上限 +N（默认 reviveMoves），棋盘与步数保留；非 FAIL 拒绝", () => {
  const events = [];
  const gm = new GameManager({ track: (e, d) => events.push([e, d]) });
  gm.loadLevel(synthetic());
  gm.beginPlay();
  assert.strictEqual(gm.reviveMoves(), 5, "par 6 → 复活 +5 步（下限 5）");
  assert.strictEqual(gm.revive(5, "ad"), false, "PLAYING 中不可复活");
  for (let i = 0; i < 12; i++) gm.tryMove("b", i % 2 === 0 ? 1 : -1);
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.FAIL);
  const boardKeyBefore = gm.board.stateKey();
  assert.strictEqual(gm.revive(0, "coins"), true, "缺省步数 = reviveMoves()");
  assert.strictEqual(gm.state, GameState.PLAYING);
  assert.strictEqual(gm.moveLimit, 17, "上限 12 + 5");
  assert.strictEqual(gm.moves, 12, "已用步数保留");
  assert.strictEqual(gm.reviveCount, 1);
  assert.strictEqual(gm.pendingFail, false);
  assert.strictEqual(gm.board.stateKey(), boardKeyBefore, "棋盘保持现状（不清空进度）");
  const rev = events.find(([e]) => e === "level_revive");
  assert.ok(rev && rev[1].reason === "coins" && rev[1].addedMoves === 5);
  // 复活后可继续挪车，再耗尽 → 二次失败
  for (let i = 0; i < 5; i++) gm.tryMove("b", i % 2 === 0 ? 1 : -1);
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.FAIL, "新上限耗尽应再次失败");
  assert.strictEqual(gm.revive(5, "ad"), true);
  assert.strictEqual(gm.reviveCount, 2);
  assert.strictEqual(gm.moveLimit, 22);
  // 重开清空复活计数与上限加成
  gm.restart();
  assert.strictEqual(gm.moveLimit, 12);
  assert.strictEqual(gm.reviveCount, 0);
});

test("reviveMoves 随 par 提升：par 16 → +8 步（够从当前局面续走）", () => {
  const gm = new GameManager();
  gm.loadLevel(Object.assign(synthetic(), { parMoves: 16 }));
  assert.strictEqual(gm.moveLimit, 29);
  assert.strictEqual(gm.reviveMoves(), 8);
});

// ---------------- ② 金币商店（存档层） ----------------

test("spendCoins：余额不足返回 false 不扣款；足额扣款并持久化", () => {
  const storage = memStorage();
  const s = new SaveManager(storage);
  s.addCoins(200);
  assert.strictEqual(s.spendCoins(150), true);
  assert.strictEqual(s.data.coins, 50);
  assert.strictEqual(s.spendCoins(100), false, "余额不足应拒绝");
  assert.strictEqual(s.data.coins, 50, "拒绝时不得扣款");
  assert.strictEqual(new SaveManager(storage).data.coins, 50, "应持久化");
});

test("旧存档兼容：缺皮肤字段补 classic；装备了未拥有的皮肤回落 classic", () => {
  const storage = memStorage();
  storage.mem["traffic_puzzle_save_v1"] = JSON.stringify({ version: 1, coins: 88, unlockedLevel: 3 });
  const s = new SaveManager(storage);
  assert.deepStrictEqual(s.data.ownedSkins, ["classic"]);
  assert.strictEqual(s.data.equippedSkin, "classic");
  assert.strictEqual(s.data.coins, 88, "旧字段不受影响");
  // 异常存档：equippedSkin 未拥有 + ownedSkins 缺 classic → 修正
  storage.mem["traffic_puzzle_save_v1"] = JSON.stringify({ version: 1, ownedSkins: ["candy"], equippedSkin: "rainbow" });
  const s2 = new SaveManager(storage);
  assert.strictEqual(s2.data.equippedSkin, "classic");
  assert.ok(s2.data.ownedSkins.includes("classic") && s2.data.ownedSkins.includes("candy"));
});

test("purchaseSkin：poor 不扣款 / ok 扣款+自动装备 / owned 不重复扣款；equipSkin 仅限已拥有", () => {
  const s = new SaveManager();
  s.addCoins(250);
  assert.strictEqual(s.purchaseSkin("rainbow", 600), "poor");
  assert.strictEqual(s.data.coins, 250);
  assert.strictEqual(s.purchaseSkin("candy", 200), "ok");
  assert.strictEqual(s.data.coins, 50);
  assert.ok(s.ownsSkin("candy"));
  assert.strictEqual(s.data.equippedSkin, "candy", "购入即装备");
  assert.strictEqual(s.purchaseSkin("candy", 200), "owned");
  assert.strictEqual(s.data.coins, 50, "已拥有不得重复扣款");
  assert.strictEqual(s.purchaseSkin("classic", 0), "owned", "classic 恒拥有");
  assert.strictEqual(s.equipSkin("neon"), false, "未拥有不可装备");
  assert.strictEqual(s.data.equippedSkin, "candy", "装备失败不得改动");
  assert.strictEqual(s.equipSkin("classic"), true);
  assert.strictEqual(s.data.equippedSkin, "classic");
});

test("skins 模块：6 套皮肤、id 唯一、classic 免费、每套 8 车身色 + 合法目标色；未知 id 回落", () => {
  const list = skins.SKINS;
  assert.strictEqual(list.length, 6);
  const ids = list.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, "id 应唯一");
  assert.strictEqual(list[0].id, "classic");
  assert.strictEqual(list[0].price, 0);
  for (const s of list) {
    assert.strictEqual(s.cars.length, 8, `${s.id} 应含 8 个车身色`);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(s.target), `${s.id} 目标色应为合法 hex`);
    for (const c of s.cars) assert.ok(/^#[0-9a-fA-F]{6}$/.test(c), `${s.id} 车身色应为合法 hex`);
    assert.ok(s.cars.indexOf(s.target) === -1, `${s.id} 目标色应与车身色板区分`);
    assert.ok(typeof s.price === "number" && s.price >= 0 && s.price <= 900, `${s.id} 定价应在经济曲线内`);
  }
  assert.strictEqual(skins.byId("nope").id, "classic");
  assert.strictEqual(skins.byId(undefined).id, "classic");
});

// ---------------- UI 集成（弹层 / 按钮 / 回放） ----------------

const analytics = new AnalyticsManager({ silent: true });
const save = new SaveManager();
const levels = new LevelManager();
const gm = new GameManager(analytics);
const audio = new AudioManager(save);
const canvas = wx.createCanvas();
const ui = new UIManager(canvas, { gameManager: gm, levelManager: levels, saveManager: save, audio, analytics });

function flushTweens() {
  for (const t of ui.tweens) { t.start -= t.dur + 10; }
  ui._updateTweens();
}
/** 渲染一帧并捕获所有按钮的 label + 命中区（临时接管 _button） */
function renderLabeled() {
  const labeled = [];
  const orig = ui._button;
  ui._button = function (ctx, x, y, w, h, label, action, opts) {
    labeled.push({ label, x, y, w, h, action });
    return orig.call(this, ctx, x, y, w, h, label, action, opts);
  };
  ui._render();
  ui._button = orig;
  return labeled;
}
/** 按 label 子串找到按钮并从中心真实点按（走 touchstart 命中链路） */
function tapButton(labeled, match) {
  const hits = labeled.filter((b) => b.label.indexOf(match) !== -1);
  assert.ok(hits.length, `应有按钮「${match}」，实际: ${labeled.map((b) => b.label).join("|")}`);
  const b = hits[hits.length - 1];
  touchHandlers.start({ touches: [{ clientX: b.x + b.w / 2, clientY: b.y + b.h / 2 }] });
  return b;
}

/** 在第 11 关（首个限步关）乱挪到步数耗尽 → FAIL + 失败弹层 */
function driveToFail() {
  ui.startLevel(10);
  ui.chapterCard = null;
  ui.overlay = null;
  assert.ok(gm.moveLimit > 0, "第 11 关应有步数上限");
  gm.beginPlay();
  let guard = 0;
  while (guard++ < 80 && (gm.state === GameState.PLAYING || gm.state === GameState.READY)) {
    const ms = gm.board.generateMoves().filter((m) => !m.isExit); // 排除出库 → 永不提前通关
    if (!ms.length) break;
    const m = ms[guard % ms.length];
    gm.tryMove(m.id, m.delta);
  }
  assert.strictEqual(gm.state, GameState.ANIMATING, "耗尽上限应进入待动画态");
  assert.ok(gm.pendingFail);
  ui._afterSnap(); // 等效吸附动画 onDone
  assert.strictEqual(gm.state, GameState.FAIL);
  assert.strictEqual(ui.overlay, "fail", "应弹出失败弹层");
}

test("失败弹层：无广告能力 → 展示免费复活；点按 → FAIL→PLAYING 上限+N（降级不卡死）", () => {
  driveToFail();
  const labeled = renderLabeled();
  assert.ok(labeled.some((b) => b.label.indexOf("免费复活") !== -1), "无广告时应提供免费复活");
  assert.ok(labeled.some((b) => b.label.indexOf("金币复活") !== -1), "应有金币复活入口");
  assert.ok(labeled.some((b) => b.label.indexOf("重开") !== -1), "应有重开入口");
  assert.ok(labeled.some((b) => b.label.indexOf("选关") !== -1), "应有选关入口");
  const limitBefore = gm.moveLimit;
  tapButton(labeled, "免费复活");
  assert.strictEqual(ui.overlay, null, "复活后应关闭弹层");
  assert.strictEqual(gm.state, GameState.PLAYING);
  assert.strictEqual(gm.moveLimit, limitBefore + gm.reviveMoves());
  assert.strictEqual(gm.reviveCount, 1);
  const events = analytics.buffer.map((e) => e.event);
  assert.ok(events.includes("level_fail"), "应有 level_fail 埋点");
  assert.ok(events.includes("level_revive"), "应有 level_revive 埋点");
});

test("金币复活：余额不足 → 无效反馈不复活；足额 → 扣 150 复活", () => {
  // 接上一用例（已复活一次，PLAYING）→ 再乱挪到二次失败
  let guard = 0;
  while (guard++ < 80 && gm.state === GameState.PLAYING) {
    const ms = gm.board.generateMoves().filter((m) => !m.isExit);
    if (!ms.length) break;
    const m = ms[guard % ms.length];
    gm.tryMove(m.id, m.delta);
  }
  ui._afterSnap();
  assert.strictEqual(ui.overlay, "fail");
  assert.strictEqual(gm.state, GameState.FAIL);
  assert.strictEqual(save.data.coins, 0, "本 harness 存档金币应为 0");
  let labeled = renderLabeled();
  tapButton(labeled, "金币复活");
  assert.strictEqual(ui.overlay, "fail", "余额不足不得复活");
  assert.strictEqual(gm.state, GameState.FAIL);
  save.addCoins(200);
  labeled = renderLabeled();
  tapButton(labeled, "金币复活");
  assert.strictEqual(save.data.coins, 50, "应扣 150");
  assert.strictEqual(ui.overlay, null);
  assert.strictEqual(gm.state, GameState.PLAYING);
  assert.strictEqual(gm.reviveCount, 2, "两次复活累计");
});

test("失败弹层「重开」：清弹层回到全新对局（步数/上限/复活计数重置）", () => {
  driveToFail();
  const labeled = renderLabeled();
  tapButton(labeled, "重开");
  assert.strictEqual(ui.overlay, null);
  assert.strictEqual(gm.state, GameState.READY);
  assert.strictEqual(gm.moves, 0);
  assert.strictEqual(gm.reviveCount, 0);
  assert.strictEqual(gm.moveLimit, 12);
});

test("步数 HUD：限步关渲染 X/上限 不抛异常；接近上限渲染警示样式", () => {
  ui.startLevel(10);
  ui.chapterCard = null; ui.overlay = null;
  gm.beginPlay();
  gm.moves = gm.moveLimit - 2; // 仅改计数用于渲染分支（接近上限 → 警示红）
  ui._render();
  gm.moves = 0;
  ui._render();
  gm.restart();
});

test("最优解回放：结算页入口 → 棋盘重置逐步播完 solution → 回结算页，不计步；轻点跳过", () => {
  ui.startLevel(0);
  ui.chapterCard = null; ui.overlay = null;
  // 手动打通第 1 关（solution：car_a -1 → car_red +5）
  gm.beginPlay();
  assert.ok(gm.tryMove("car_a", -1).ok);
  assert.ok(gm.tryMove("car_red", 5).win);
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.WIN);
  ui.overlay = "win";
  ui.starAnim = Date.now();
  assert.ok(ui.winInfo, "onWin 回调应填充 winInfo");
  let labeled = renderLabeled();
  assert.ok(labeled.some((b) => b.label.indexOf("最优解回放") !== -1), "结算页应有回放入口");
  tapButton(labeled, "最优解回放");
  // 回放开始：棋盘回到初始局面，弹层收起
  assert.ok(ui.replay, "应进入回放态");
  assert.strictEqual(ui.overlay, null);
  assert.strictEqual(gm.moves, 0);
  assert.strictEqual(gm.board.getVehicle("car_red").x, 1, "棋盘应重置到初始局面");
  // 快进驱动播完（solution 共 2 步）
  let guard = 0;
  while (ui.replay && guard++ < 30) {
    ui.replay.nextAt = 0;
    ui._pumpReplay();
    flushTweens();
  }
  assert.ok(guard < 30, "回放应在有限帧内播完");
  assert.strictEqual(ui.overlay, "win", "播完应回到结算弹层");
  assert.strictEqual(gm.board.checkWin(), true, "回放应按 solution 把目标车送出库");
  assert.strictEqual(gm.moves, 0, "回放不得计步");
  assert.strictEqual(gm.state, GameState.READY, "回放不改变对局状态机");
  // 再看一次并中途跳过
  ui._startReplay();
  assert.ok(ui.replay);
  ui.replay.nextAt = 0;
  ui._pumpReplay();
  flushTweens();
  assert.strictEqual(ui.replay.index, 1, "应播完第一步");
  assert.strictEqual(gm.board.getVehicle("car_a").y, 0, "第一步 car_a 上移一格");
  ui._render(); // 回放横幅渲染不抛异常
  touchHandlers.start({ touches: [{ clientX: 5, clientY: 5 }] }); // 轻点任意处
  assert.strictEqual(ui.replay, null, "轻点应跳过回放");
  assert.strictEqual(ui.overlay, "win", "跳过后回到结算弹层");
});

test("回放中底部按钮禁用、拖动被拦截（不会把回放变成对局）", () => {
  ui._startReplay();
  assert.ok(ui.replay);
  const labeled = renderLabeled();
  const undo = labeled.filter((b) => b.label === "撤销").pop();
  assert.ok(undo, "应渲染撤销按钮");
  const movesBefore = gm.moves;
  touchHandlers.start({ touches: [{ clientX: undo.x + undo.w / 2, clientY: undo.y + undo.h / 2 }] });
  assert.strictEqual(ui.replay, null, "回放中任意点按 = 跳过（优先于按钮）");
  assert.strictEqual(gm.moves, movesBefore);
  ui.overlay = null;
  ui.replay = null;
});

test("金币商店：菜单入口 → 购买（扣款+自动装备）→ 切换装备 → 余额不足拒绝 → 返回", () => {
  ui.showMenu();
  let labeled = renderLabeled();
  tapButton(labeled, "🛒 商店");
  assert.strictEqual(ui.overlay, "shop", "菜单应能打开商店");
  save.data.coins = 500;
  labeled = renderLabeled();
  assert.ok(labeled.some((b) => b.label === "使用中"), "classic 应显示使用中");
  assert.ok(labeled.some((b) => b.label === "🪙 200"), "candy 应显示价格");
  tapButton(labeled, "🪙 200"); // 购买 candy
  assert.ok(save.ownsSkin("candy"));
  assert.strictEqual(save.data.equippedSkin, "candy", "购入即装备");
  assert.strictEqual(save.data.coins, 300);
  const events = analytics.buffer.map((e) => e.event);
  assert.ok(events.includes("skin_purchased"), "应有购买埋点");
  // 切换回 classic（此时 classic 行显示「装备」）
  labeled = renderLabeled();
  tapButton(labeled, "装备");
  assert.strictEqual(save.data.equippedSkin, "classic");
  assert.ok(analytics.buffer.map((e) => e.event).includes("skin_equipped"));
  // 余额不足：买 600 的 rainbow
  save.data.coins = 10;
  labeled = renderLabeled();
  tapButton(labeled, "🪙 600");
  assert.strictEqual(save.ownsSkin("rainbow"), false);
  assert.strictEqual(save.data.coins, 10, "余额不足不得扣款");
  // 返回关闭
  labeled = renderLabeled();
  tapButton(labeled, "返 回");
  assert.strictEqual(ui.overlay, null);
});

test("皮肤色板接入渲染：装备 candy 后 _renderVehicles 按装备皮肤取色", () => {
  save.equipSkin("candy");
  ui.startLevel(0);
  ui.chapterCard = null; ui.overlay = null;
  // 监视 skins.byId 的入参：渲染车辆时应查询当前装备皮肤
  const orig = skins.byId;
  let asked = null;
  skins.byId = (id) => { asked = id; return orig(id); };
  try {
    ui._renderVehicles(ui.ctx, gm.levelData);
  } finally {
    skins.byId = orig;
  }
  assert.strictEqual(asked, "candy", "渲染应使用装备中的皮肤");
  save.data.coins = 0;
  save.equipSkin("classic");
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
