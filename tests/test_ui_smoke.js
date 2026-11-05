"use strict";
/**
 * UI 端到端冒烟测试（Node 运行：node tests/test_ui_smoke.js）。
 * 用桩件（stub）模拟 wx / canvas / requestAnimationFrame，
 * 通过真实触摸事件流驱动 UIManager + GameManager 完整玩通第 1 关，
 * 验证：拖动→计步、无效拖动不计步、出库动画→胜利弹层→存档解锁→进入下一关。
 */

const assert = require("assert");

// ---------------- 全局桩件 ----------------
function makeCtxStub() {
  // 万能链式桩：任意属性读取返回可调用对象，调用后仍返回自身，
  // 支持 createLinearGradient(...).addColorStop(...) 等链式用法；属性可写。
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
};

const { UIManager } = require("../js/ui/UIManager.js");
const { GameManager, GameState } = require("../js/core/GameManager.js");
const { LevelManager } = require("../js/level/LevelManager.js");
const { SaveManager } = require("../js/save/SaveManager.js");
const { AnalyticsManager } = require("../js/platform/AnalyticsManager.js");
const { AudioManager } = require("../js/ui/AudioManager.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ---------------- 组装 ----------------
const analytics = new AnalyticsManager({ silent: true });
const save = new SaveManager();
const levels = new LevelManager();
const gm = new GameManager(analytics);
const audio = new AudioManager(save);
const canvas = wx.createCanvas();
const ui = new UIManager(canvas, { gameManager: gm, levelManager: levels, saveManager: save, audio, analytics });

const CELL = ui.cell, BX = ui.boardX, BY = ui.boardY;
function cellCenter(col, row) {
  return { x: BX + (col + 0.5) * CELL, y: BY + (row + 0.5) * CELL };
}
function dragPx(fromCol, fromRow, toX, toY) {
  const a = cellCenter(fromCol, fromRow);
  touchHandlers.start({ touches: [{ clientX: a.x, clientY: a.y }] });
  touchHandlers.move({ touches: [{ clientX: (a.x + toX) / 2, clientY: (a.y + toY) / 2 }] });
  touchHandlers.move({ touches: [{ clientX: toX, clientY: toY }] });
  touchHandlers.end({ changedTouches: [{ clientX: toX, clientY: toY }] });
}
function drag(fromCol, fromRow, toCol, toRow) {
  const b = cellCenter(toCol, toRow);
  dragPx(fromCol, fromRow, b.x, b.y);
}
function flushTweens() {
  // 快进所有动画（模拟时间流逝）
  for (const t of ui.tweens) { t.start -= t.dur + 10; }
  ui._updateTweens();
}
function tap(x, y) {
  touchHandlers.start({ touches: [{ clientX: x, clientY: y }] });
}

console.log("\n[UI 冒烟测试]");

test("关卡数量为 30 且可加载；首次进入章节弹过场卡片", () => {
  assert.strictEqual(levels.count, 30);
  ui.startLevel(0);
  assert.strictEqual(ui.scene, "game");
  assert.strictEqual(gm.state, GameState.READY);
  assert.strictEqual(gm.board.vehicles.length, 2); // level_001: 目标车 + 1 阻挡车
  // 首次进入「驾校」章节 → 弹出过场卡片（overlay 挡住对局输入，READY 状态不计时）
  assert.strictEqual(ui.overlay, "chapter");
  assert.ok(ui.chapterCard && ui.chapterCard.theme.key === "school");
  ui._render(); // 渲染卡片一帧
  assert.ok(ui.buttons.some((b) => b.w === ui.W && b.h === ui.H), "应有全屏点按跳过区");
  // 模拟玩家点按跳过
  ui.chapterCard = null;
  ui.overlay = null;
  ui._render(); // 重建按钮命中区（移除全屏跳过层）
});

test("无效拖动（拖动空格子 / 被挡方向）不计步", () => {
  // level_001: red 在 (1,2)-(2,2)，右侧 (3,2) 被 car_a 挡；向右拖 red 应弹回
  const before = gm.moves;
  drag(2, 2, 5, 2); // 尝试把 red 拖到最右
  flushTweens();
  assert.strictEqual(gm.moves, before, "被挡的拖动不应计步");
  assert.strictEqual(gm.board.getVehicle("car_red").x, 1, "车辆应回到原位");
  // 拖动空白格子：无效果
  drag(0, 0, 0, 3);
  assert.strictEqual(gm.moves, before);
});

test("拖动阻挡车让路 → 计一步", () => {
  // car_a V 在 (3,1)-(3,2)，向上拖 1 格让开出口行
  drag(3, 1, 3, 0);
  flushTweens();
  assert.strictEqual(gm.moves, 1);
  assert.strictEqual(gm.board.getVehicle("car_a").y, 0);
  assert.strictEqual(gm.state, GameState.PLAYING);
  // 让路后目标车出口通路打开 → 渲染情绪气泡（😄）不应抛异常
  ui._render();
});

test("目标车出库 → 胜利动画 → WIN + 结算弹层 + 存档", () => {
  // red 从 (1,2) 一路拖出右边界（拖到棋盘外，clamp 到出库上界）
  const start = cellCenter(2, 2);
  dragPx(2, 2, BX + ui.boardSize + CELL * 2, start.y);
  assert.strictEqual(gm.moves, 2);
  assert.strictEqual(gm.board.checkWin(), true);
  assert.strictEqual(gm.state, GameState.ANIMATING, "出库动画期间应为 ANIMATING");
  flushTweens(); // 动画完成 → WIN + 弹层
  assert.strictEqual(gm.state, GameState.WIN);
  assert.strictEqual(ui.overlay, "win");
  assert.ok(ui.winInfo);
  assert.strictEqual(ui.winInfo.stars, 3, "2 步 = par，应得三星");
  assert.strictEqual(save.getStars("level_001"), 3);
  assert.strictEqual(save.data.bestMoves["level_001"], 2);
  assert.strictEqual(save.isUnlocked(1), true, "应解锁第 2 关");
});

test("胜利弹层按钮可渲染且「下一关」进入 level_002", () => {
  ui._render(); // 重建按钮命中区
  assert.ok(ui.buttons.length >= 3, "应有 下一关/重玩/选关 按钮");
  ui.startLevel(1);
  assert.strictEqual(ui.overlay, null);
  assert.strictEqual(gm.levelData.id, "level_002");
  assert.strictEqual(gm.state, GameState.READY);
});

test("撤销按钮流程：走一步后撤销恢复", () => {
  ui.startLevel(1); // level_002
  const v0 = gm.board.getVehicle("car_a");
  const startY = v0.y;
  const range = gm.board.getMovableRange("car_a");
  assert.ok(range && range.lo !== range.hi, "car_a 应可移动");
  // 直接通过引擎走一步（等效拖动）
  gm.beginPlay();
  assert.ok(gm.tryMove("car_a", range.lo - startY).ok);
  assert.strictEqual(gm.moves, 1);
  assert.ok(gm.undo());
  assert.strictEqual(gm.moves, 0);
  assert.strictEqual(gm.board.getVehicle("car_a").y, startY);
});

test("提示按钮给出合法移动（含精确格数 delta）", () => {
  ui._useHint();
  assert.ok(ui.hint, "应显示提示");
  const v = gm.board.getVehicle(ui.hint.vehicleId);
  assert.ok(v);
  assert.strictEqual(gm.board.canMove(ui.hint.vehicleId, ui.hint.dir), true,
    "提示的移动必须合法");
  assert.ok(Number.isInteger(ui.hint.delta) && ui.hint.delta !== 0, "提示应携带精确格数");
  assert.strictEqual(gm.board.canMove(ui.hint.vehicleId, ui.hint.delta), true,
    "提示的精确移动必须合法");
});

test("轻点提示高亮车辆 = 自动精确执行提示移动（回归：拖到头偏离计划）", () => {
  ui._render(); // 重建按钮命中区（清掉胜利弹层的全屏点按区）
  ui._useHint();
  assert.ok(ui.hint && ui.hint.delta, "应有提示");
  const h = ui.hint;
  const v = gm.board.getVehicle(h.vehicleId);
  const before = { x: v.x, y: v.y };
  const movesBefore = gm.moves;
  // 模拟"轻点车辆"（touchstart + touchend 同一位置，无位移）
  const c = cellCenter(v.x, v.y);
  touchHandlers.start({ touches: [{ clientX: c.x, clientY: c.y }] });
  touchHandlers.end({ changedTouches: [{ clientX: c.x, clientY: c.y }] });
  flushTweens();
  const v2 = gm.board.getVehicle(h.vehicleId);
  const moved = h.axis === "x" ? v2.x - before.x : v2.y - before.y;
  assert.strictEqual(moved, h.delta, `车辆应精确移动 ${h.delta} 格（轻点自动就位）`);
  assert.strictEqual(ui.hint, null, "执行后提示应清除");
  assert.strictEqual(gm.moves, movesBefore + 1, "应计一步");
  // 撤销恢复，避免影响后续用例
  gm.undo();
});

test("提示期间拖到头自动停在目标虚线框（精确格数钳制）", () => {
  ui._render(); // 重建按钮命中区
  ui._useHint();
  assert.ok(ui.hint && ui.hint.delta, "应有提示");
  const h = ui.hint;
  const v = gm.board.getVehicle(h.vehicleId);
  const before = { x: v.x, y: v.y };
  const movesBefore = gm.moves;
  // 沿提示方向拖 10 格（远超提示格数）——应被钳制到精确 delta
  const a = cellCenter(v.x, v.y);
  const farX = h.axis === "x" ? a.x + h.dir * 10 * CELL : a.x;
  const farY = h.axis === "y" ? a.y + h.dir * 10 * CELL : a.y;
  dragPx(v.x, v.y, farX, farY);
  flushTweens();
  const v2 = gm.board.getVehicle(h.vehicleId);
  const moved = h.axis === "x" ? v2.x - before.x : v2.y - before.y;
  assert.strictEqual(moved, h.delta, `拖过头应被钳制到提示的 ${h.delta} 格`);
  assert.strictEqual(gm.moves, movesBefore + 1, "应计一步");
  gm.undo();
});

test("8×8 深度乱局：点提示转「计算中」，后台分帧搜索从当前局面交付（回归：整盘回退重开）", () => {
  // 用户缺陷：旧保底把全部历史倒回起点再接解法（"相当于重开了"）。
  // 新架构：同步快搜超时 → hintPending 转圈（界面不冻结）→ 每帧 pump →
  // 加权 A* 从当前局面求出续走计划。
  ui.startLevel(24); // level_025（8×8）
  ui.chapterCard = null; ui.overlay = null;
  gm.beginPlay();
  gm.moveLimit = 0; // 隔离步数上限：本用例只测深度乱局提示（40 步乱挪远超 par）
  let seed = 2029;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 40; i++) {
    const ms = gm.board.generateMoves().filter((m) => !m.isExit);
    if (!ms.length) break;
    const m = ms[rnd(ms.length)];
    gm.tryMove(m.id, m.delta);
  }
  flushTweens();
  assert.strictEqual(gm.board.checkWin(), false, "乱局应未通关");
  ui._render(); // 重建按钮命中区
  ui._useHint();
  // 同步快搜（A*350ms+Beam300ms）解不动 40 步乱局 → 转后台搜索
  assert.strictEqual(ui.hint, null, "深度乱局首次点击不应同步给出提示");
  assert.strictEqual(ui.hintPending, true, "应进入「计算中」状态");
  assert.strictEqual(gm.hintComputing, true, "后台搜索应已启动");
  ui._render(); // 「计算中」spinner + 按钮文案渲染不应抛异常
  // 模拟主循环每帧泵送，直到交付
  let frames = 0;
  while (!ui.hint && frames < 20000) { ui._pumpHintSearch(); frames++; }
  assert.ok(ui.hint, `后台搜索应交付提示（${frames} 帧内）`);
  assert.strictEqual(ui.hintPending, false, "交付后应退出「计算中」");
  assert.strictEqual(gm.board.canMove(ui.hint.vehicleId, ui.hint.delta), true, "交付的提示必须合法");
  // 计划应从当前局面续走，不得整盘回退到初始位置
  const { Board } = require("../js/core/engine.js");
  const initialKey = new Board(gm.levelData).stateKey();
  assert.ok(gm._hintPlan && !gm._hintPlan.keys.includes(initialKey),
    "提示计划不得途经初始局面（不是重开，是续走）");
});

test("暂停 → 暂停弹层 → 继续", () => {
  ui._render(); // 建立底部按钮
  assert.ok(gm.pause());
  assert.strictEqual(gm.state, GameState.PAUSED);
  ui.overlay = "pause";
  ui._render();
  assert.ok(ui.buttons.length >= 4, "暂停弹层应有按钮");
  // 暂停中拖动无效
  const before = gm.moves;
  drag(0, 0, 0, 1);
  assert.strictEqual(gm.moves, before);
  // 「继续游戏」等效操作
  assert.ok(gm.resume());
  ui.overlay = null;
  assert.strictEqual(gm.state, GameState.PLAYING);
});

test("切后台自动暂停，回前台埋点正常", () => {
  ui.onAppHide();
  assert.strictEqual(gm.state, GameState.PAUSED);
  assert.strictEqual(ui.overlay, "pause");
  ui.onAppShow();
  const events = analytics.buffer.map((e) => e.event);
  for (const name of ["game_start", "level_start", "vehicle_move", "undo", "hint_used", "level_win", "game_exit"]) {
    assert.ok(events.includes(name), `缺少埋点事件 ${name}`);
  }
});

test("章节卡片只首次展示；新章节再次弹出（存档持久化）", () => {
  // 驾校已看过 → 重进第 1 关不再弹
  ui.startLevel(0);
  assert.strictEqual(ui.overlay, null);
  assert.strictEqual(ui.chapterCard, null);
  // 首次进入「小区」章节（第 7 关）→ 弹卡片
  ui.startLevel(6);
  assert.strictEqual(ui.overlay, "chapter");
  assert.strictEqual(ui.chapterCard.theme.key, "community");
  assert.strictEqual(save.data.chaptersSeen.community, true);
  ui._render();
  // 渲染不应抛异常，且卡片期间底部按钮禁用（overlay 存在）
  assert.ok(ui.buttons.length > 0);
  ui.chapterCard = null;
  ui.overlay = null;
});

test("菜单/选关场景渲染不抛异常", () => {
  ui.showMenu();
  ui._render();
  ui.showSelect();
  ui._render();
  assert.ok(ui.buttons.length > 0, "选关界面应有可点关卡");
});

test("🎵 背景音乐开关：菜单点按切换并持久化（独立于 🔊 音效开关）", () => {
  ui.showMenu();
  ui._render();
  const x = ui.W - 102 + 22, y = ui.safeTop + 14 + 17; // 🎵 按钮中心
  assert.ok(ui.buttons.some((b) => b.x === ui.W - 102 && b.y === ui.safeTop + 14 && b.w === 44),
    "菜单应渲染 🎵 开关");
  const before = save.data.bgmEnabled;
  const sfxBefore = save.data.soundEnabled;
  tap(x, y);
  assert.strictEqual(save.data.bgmEnabled, !before, "点按应切换并持久化 BGM 开关");
  assert.strictEqual(save.data.soundEnabled, sfxBefore, "不应影响音效开关");
  ui._render();
  tap(x, y);
  assert.strictEqual(save.data.bgmEnabled, before, "再次点按应切回");
  // 对局场景也应有 🎵 开关
  ui.startLevel(0);
  ui.chapterCard = null;
  ui.overlay = null;
  ui._render();
  assert.ok(ui.buttons.some((b) => b.w === 44 && b.h === 34), "对局顶栏应渲染 🎵 开关");
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
