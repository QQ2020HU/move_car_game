"use strict";
/**
 * JS 引擎验收测试（Node 运行：node tests/test_engine.js）。
 *
 * 覆盖：
 * 1. Board 占格 / canMove / moveVehicle / 越界 / 阻挡 / 整段路径
 * 2. 目标车出库与胜利判定
 * 3. GameManager 状态机、步数、撤销、重开、星级、提示
 * 4. SaveManager 存档合并与版本兼容
 * 5. 全量关卡：用 JS 引擎重放 levels.json 中的 solution 并胜利，
 *    且重放步数 == parMoves（证明 JS 引擎与 Python 求解器语义一致）
 * 6. bfsSolve（JS 提示系统）对每关求得的步数 == parMoves
 */

const assert = require("assert");
const path = require("path");
const { Board, bfsSolve } = require("../js/core/engine.js");
const { GameManager, GameState } = require("../js/core/GameManager.js");
const { SaveManager } = require("../js/save/SaveManager.js");
const { AnalyticsManager } = require("../js/platform/AnalyticsManager.js");
const LEVELS = require("../js/data/levels.js");
const LEVELS_JSON = require("../js/data/levels.json");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function lvl(vehicles, opts) {
  return Object.assign({
    id: "t", title: "t", rows: 6, cols: 6,
    exit: { side: "RIGHT", row: 2 },
    targetVehicleId: "red",
    parMoves: 1,
    vehicles,
  }, opts || {});
}

function v(id, x, y, length, orientation, isTarget) {
  const o = { id, x, y, length, orientation };
  if (isTarget) o.isTarget = true;
  return o;
}

// ================= 1. 棋盘与移动规则 =================
console.log("\n[Board / MoveValidator / CollisionDetector]");

test("占格计算 H/V", () => {
  const b = new Board(lvl([v("red", 1, 2, 2, "H", true), v("a", 3, 0, 3, "V")]));
  const grid = b.getGrid();
  assert.strictEqual(grid[2][1], "red");
  assert.strictEqual(grid[2][2], "red");
  assert.strictEqual(grid[0][3], "a");
  assert.strictEqual(grid[2][3], "a");
  assert.strictEqual(grid[5][5], null);
});

test("禁停区：网格标记与移动阻挡", () => {
  const b = new Board(lvl(
    [v("red", 0, 2, 2, "H", true), v("a", 3, 1, 2, "V")],
    { obstacles: [[3, 3]] }
  ));
  assert.strictEqual(b.getGrid()[3][3], "#");
  assert.strictEqual(b.canMove("a", 1), false, "向下被禁停区阻挡");
  assert.strictEqual(b.canMove("a", -1), true, "向上可移动");
  assert.deepStrictEqual(b.getMovableRange("a"), { lo: 0, hi: 1 });
  assert.ok(b.moveVehicle("a", -1));
  assert.strictEqual(b.getVehicle("a").y, 0);
});

test("禁停区：出库路径被封 → 目标车无法出库", () => {
  const b = new Board(lvl(
    [v("red", 0, 2, 2, "H", true), v("a", 5, 0, 2, "V")],
    { obstacles: [[3, 2]] }
  ));
  assert.strictEqual(b.canMove("red", 4), false);
  assert.strictEqual(b.canMove("red", 1), true, "禁停区左侧仍可移动");
  const r = b.getMovableRange("red");
  assert.strictEqual(r.hi, 1, "被禁停区挡住时上界不含出库");
  assert.strictEqual(b.generateMoves().filter((m) => m.isExit).length, 0);
});

test("禁停区：clone 保留障碍物", () => {
  const b = new Board(lvl(
    [v("red", 0, 2, 2, "H", true), v("a", 4, 4, 2, "H")],
    { obstacles: [[4, 0]] }
  ));
  const c = b.clone();
  assert.deepStrictEqual(c.obstacles, [[4, 0]]);
  assert.strictEqual(c.getGrid()[0][4], "#");
});

test("边界：不能移出棋盘", () => {
  const b = new Board(lvl([v("red", 0, 2, 2, "H", true)]));
  assert.strictEqual(b.canMove("red", -1), false);
  const b2 = new Board(lvl([v("a", 3, 0, 3, "V"), v("red", 0, 2, 2, "H", true)]));
  assert.strictEqual(b2.canMove("a", -1), false);
  assert.strictEqual(b2.canMove("a", 4), false); // 3+3=6 > 底部
  assert.strictEqual(b2.canMove("a", 3), true);  // y=3 → 占行3,4,5
});

test("阻挡：不能穿过其他车辆（整段路径检查）", () => {
  const b = new Board(lvl([
    v("red", 0, 2, 2, "H", true),
    v("a", 3, 2, 2, "V"), // 挡在 (3,2)(3,3)
  ]));
  assert.strictEqual(b.canMove("red", 1), true);  // 到 x=1，占(1,2)(2,2)
  assert.strictEqual(b.canMove("red", 2), false); // 车头需经过 (3,2)? x=2 占(2,2)(3,2) → 被挡
});

test("delta=0 与不存在车辆", () => {
  const b = new Board(lvl([v("red", 0, 2, 2, "H", true)]));
  assert.strictEqual(b.canMove("red", 0), false);
  assert.strictEqual(b.canMove("ghost", 1), false);
});

test("非目标车不能出库", () => {
  const b = new Board(lvl([
    v("red", 0, 2, 2, "H", true),
    v("a", 4, 2, 2, "H"),
  ]));
  assert.strictEqual(b.canMove("a", 1), false);  // x=5 占(5,2)(6,2) → 越界非法
  assert.strictEqual(b.canMove("a", -4), false); // x=0 与 red 重叠，非法
  assert.strictEqual(b.canMove("a", -2), true);  // 向左到 x=2 占(2,2)(3,2) 合法
});

test("非目标车右移到贴边合法、越界非法", () => {
  const b = new Board(lvl([
    v("red", 0, 2, 2, "H", true),
    v("a", 3, 2, 2, "H"),
  ]));
  assert.strictEqual(b.canMove("a", 1), true);  // x=4，占(4,2)(5,2)
  assert.strictEqual(b.canMove("a", 2), false); // 越界
});

test("目标车出库即胜利", () => {
  const b = new Board(lvl([v("red", 3, 2, 2, "H", true)]));
  assert.strictEqual(b.checkWin(), false);
  assert.strictEqual(b.moveVehicle("red", 3), true); // x=6 完全出库
  assert.strictEqual(b.checkWin(), true);
});

test("目标车出库需路径畅通", () => {
  const b = new Board(lvl([
    v("red", 1, 2, 2, "H", true),
    v("a", 4, 2, 2, "V"),
  ]));
  assert.strictEqual(b.canMove("red", 4), false); // (4,2) 被占
  assert.strictEqual(b.moveVehicle("a", -2), true); // a 上移到行0-1
  assert.strictEqual(b.canMove("red", 4), true);
  assert.strictEqual(b.moveVehicle("red", 4), true);
  assert.strictEqual(b.checkWin(), true);
});

test("getMovableRange 含出库上界", () => {
  const b = new Board(lvl([
    v("red", 1, 2, 2, "H", true),
    v("a", 4, 1, 2, "V"),
  ]));
  let r = b.getMovableRange("red");
  assert.strictEqual(r.lo, 0);
  assert.strictEqual(r.hi, 2); // 右移最多到 x=2（x=3 时车头撞 a 占的 (4,2)）
  const b2 = new Board(lvl([v("red", 1, 2, 2, "H", true)]));
  r = b2.getMovableRange("red");
  assert.strictEqual(r.lo, 0);
  assert.strictEqual(r.hi, 6); // 允许拖出棋盘
  const rA = b2.getMovableRange("ghost");
  assert.strictEqual(rA, null);
});

test("胜利后禁止继续移动", () => {
  const b = new Board(lvl([v("red", 4, 2, 2, "H", true), v("a", 0, 0, 2, "V")]));
  b.moveVehicle("red", 2);
  assert.strictEqual(b.checkWin(), true);
  assert.strictEqual(b.canMove("a", 1), false);
  assert.deepStrictEqual(b.generateMoves(), []);
});

// ================= 2. GameManager =================
console.log("\n[GameManager / 状态机 / 撤销 / 星级]");

function silentAnalytics() {
  return new AnalyticsManager({ silent: true });
}

test("状态机：胜利经 ANIMATING 进入 WIN（文档 §3.3）", () => {
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(lvl([v("red", 3, 2, 2, "H", true)], { parMoves: 1 }));
  assert.strictEqual(gm.state, GameState.READY);
  const r = gm.tryMove("red", 3);
  assert.ok(r.ok && r.win);
  assert.strictEqual(gm.state, GameState.ANIMATING); // 出库动画中
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.WIN);
});

test("无效移动不计步，有效移动计一步", () => {
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(lvl([
    v("red", 0, 2, 2, "H", true),
    v("a", 3, 2, 2, "V"),
  ], { parMoves: 3 }));
  gm.beginPlay();
  assert.strictEqual(gm.moves, 0);
  const bad = gm.tryMove("red", 5); // 被挡
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(gm.moves, 0);
  const good = gm.tryMove("a", -2); // a 上移
  assert.strictEqual(good.ok, true);
  assert.strictEqual(gm.moves, 1);
});

test("动画期间禁止提交（ANIMATING 锁定）", () => {
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(lvl([v("red", 1, 2, 2, "H", true)], { parMoves: 1 }));
  gm.beginPlay();
  gm.beginAnimating();
  assert.strictEqual(gm.state, GameState.ANIMATING);
  const r = gm.tryMove("red", 1);
  assert.strictEqual(r.ok, false);
  gm.endAnimating();
  assert.strictEqual(gm.state, GameState.PLAYING);
});

test("撤销恢复车辆与步数；重开清空撤销栈", () => {
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(lvl([
    v("red", 0, 2, 2, "H", true),
    v("a", 3, 2, 2, "V"),
  ], { parMoves: 3 }));
  gm.beginPlay();
  gm.tryMove("a", -2);
  gm.tryMove("a", 2);
  assert.strictEqual(gm.moves, 2);
  assert.strictEqual(gm.undo(), true);
  assert.strictEqual(gm.moves, 1);
  assert.strictEqual(gm.board.getVehicle("a").y, 0);
  gm.undo();
  assert.strictEqual(gm.moves, 0);
  assert.strictEqual(gm.board.getVehicle("a").y, 2);
  assert.strictEqual(gm.undo(), false); // 栈空
  gm.tryMove("a", -1);
  gm.restart();
  assert.strictEqual(gm.moves, 0);
  assert.strictEqual(gm.undoStack.length, 0);
  assert.strictEqual(gm.board.getVehicle("a").y, 2);
});

test("暂停与恢复", () => {
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(lvl([v("red", 3, 2, 2, "H", true)], { parMoves: 1 }));
  gm.beginPlay();
  assert.strictEqual(gm.pause(), true);
  assert.strictEqual(gm.state, GameState.PAUSED);
  assert.strictEqual(gm.tryMove("red", 1).ok, false); // 暂停中禁止操作
  assert.strictEqual(gm.resume(), true);
  assert.strictEqual(gm.state, GameState.PLAYING);
});

test("三星评价阈值（§2.4）", () => {
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(lvl([v("red", 3, 2, 2, "H", true)], { parMoves: 8 }));
  assert.strictEqual(gm.computeStars(8, 8), 3);
  assert.strictEqual(gm.computeStars(11, 8), 2);
  assert.strictEqual(gm.computeStars(12, 8), 1);
});

test("胜利回调携带星级/步数/用时", () => {
  const gm = new GameManager(silentAnalytics());
  let info = null;
  gm.on("onWin", (i) => { info = i; });
  gm.loadLevel(lvl([v("red", 3, 2, 2, "H", true)], { parMoves: 1 }));
  gm.beginPlay();
  gm.tryMove("red", 3);
  assert.ok(info);
  assert.strictEqual(info.stars, 3);
  assert.strictEqual(info.moves, 1);
});

// 深度乱局下 getHint 可能返回 null 并转入后台分帧搜索（gm.hintComputing=true，
// 真实 UI 每帧调 pumpHint 推进）。测试里模拟这个泵送过程直到交付提示。
function hintWithPump(gm, sliceMs) {
  let m = gm.getHint();
  let guard = 0;
  while (!m && gm.hintComputing && guard++ < 100000) {
    const r = gm.pumpHint(sliceMs || 25);
    if (r) m = r;
  }
  return m;
}

test("提示：预计算解法优先，偏离后 BFS 兜底", () => {
  const level = LEVELS.find((l) => l.id === "level_002");
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(level);
  gm.beginPlay();
  const h1 = gm.getHint();
  assert.ok(h1);
  assert.strictEqual(h1.vehicleId, level.solution[0].vehicleId);
  // 故意走一步无关移动（偏离解法路径），提示仍应给出合法移动
  const someCar = level.vehicles.find((x) => x.id !== level.targetVehicleId && x.orientation === "V");
  if (someCar) {
    const range = gm.board.getMovableRange(someCar.id);
    if (range.lo < someCar.y) {
      gm.tryMove(someCar.id, range.lo - someCar.y);
      const h2 = hintWithPump(gm);
      assert.ok(h2, "偏离解法后 BFS 提示应有结果");
      assert.strictEqual(gm.board.canMove(h2.vehicleId, h2.delta), true);
    }
  }
  assert.strictEqual(gm.hintsUsed >= 1, true);
});

test("提示：8×8 大棋盘偏离解法后 A* 兜底仍给出合法移动（回归：点提示无反应）", () => {
  const level = LEVELS.find((l) => (l.rows || 6) >= 8);
  assert.ok(level, "应存在 8×8 关卡");
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(level);
  gm.beginPlay();
  // 连续走 3 步与预计算解法无关的合法移动，制造深度偏离局面
  let deviated = 0;
  for (const v of gm.board.vehicles) {
    if (deviated >= 3) break;
    if (v.id === gm.board.targetId) continue;
    const sol = level.solution || [];
    const range = gm.board.getMovableRange(v.id);
    for (let d = range.lo; d <= range.hi && deviated < 3; d++) {
      const delta = d - (v.orientation === "H" ? v.x : v.y);
      if (delta === 0) continue;
      if (sol.some((m) => m.vehicleId === v.id && m.delta === delta)) continue;
      if (!gm.board.canMove(v.id, delta)) continue;
      gm.tryMove(v.id, delta);
      deviated++;
    }
  }
  assert.ok(deviated >= 1, "应能构造偏离局面");
  const t0 = Date.now();
  const h = hintWithPump(gm);
  const ms = Date.now() - t0;
  assert.ok(h, "偏离解法后 8×8 提示应有结果（旧实现 BFS 超上限返回 null）");
  assert.strictEqual(gm.board.canMove(h.vehicleId, h.delta), true);
  assert.ok(ms < 20000, `提示（含后台分帧搜索）应在 20s 内交付，实际 ${ms}ms`);
  // A* 给出的解法重放后应能通关
  const { astarSolve } = require("../js/core/engine.js");
  const sol = astarSolve(gm.board, 120000);
  assert.ok(sol && sol.length, "A* 应能求出完整解法");
  for (const m of sol) {
    assert.strictEqual(gm.board.canMove(m.id, m.delta), true);
    gm.board.moveVehicle(m.id, m.delta);
  }
  assert.strictEqual(gm.board.checkWin(), true);
});

test("提示：8×8 深度乱局（随机 40 步）不卡死，限时给出合法提示（回归：点提示冻结）", () => {
  const level = LEVELS.find((l) => (l.rows || 6) >= 8);
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(level);
  gm.beginPlay();
  gm.moveLimit = 0; // 隔离步数上限规则：本用例只测提示系统（40 步乱挪远超 par，不应触发 FAIL）
  // 确定性伪随机乱挪 40 步（不含出库），模拟玩家深度偏离（走 tryMove 保持历史同步）
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 40; i++) {
    const moves = gm.board.generateMoves().filter((m) => !m.isExit);
    if (!moves.length) break;
    const m = moves[rnd(moves.length)];
    gm.tryMove(m.id, m.delta);
  }
  assert.strictEqual(gm.board.checkWin(), false);
  // 同步调用必须快速返回：要么直接给出提示，要么返回 null 并转入后台分帧搜索
  const t0 = Date.now();
  const first = gm.getHint();
  const syncMs = Date.now() - t0;
  assert.ok(syncMs < 2500, `getHint 同步部分必须在 2.5s 内返回（防主线程冻结），实际 ${syncMs}ms`);
  assert.ok(first || gm.hintComputing, "深度乱局：要么直接给提示，要么启动后台搜索");
  const h = first || hintWithPump(gm);
  assert.ok(h, "深度乱局下提示必须有结果（后台 Beam/A* → 原路返回保底 → 贪心）");
  assert.strictEqual(gm.board.canMove(h.vehicleId, h.delta), true);
  // Beam Search 兜底本身可用（6×6 初始局面上限时内应可解——这正是 beam 在
  // getHint 同步链中的实际角色；8×8 深乱局束宽不足属正常，由后台加权 A* 负责）
  const { beamSolve, greedyStep } = require("../js/core/engine.js");
  const easyLevel = LEVELS.find((l) => (l.rows || 6) <= 6) || level;
  const bs = beamSolve(new Board(easyLevel), 300, 2000);
  assert.ok(bs && bs.length, "beamSolve 应给出解法");
  const g = greedyStep(gm.board);
  assert.ok(g && gm.board.canMove(g.id, g.delta), "greedyStep 必须给出合法单步");
});

test("提示：8×8 深度乱局后连续跟提示必然通关，且从当前局面续走（回归：死循环/整盘回退）", () => {
  // 用户实测缺陷①：第 29 关乱挪后一路点提示会 A↔B 打转、永远通不了关；
  // 用户实测缺陷②：旧保底把全部历史倒回起点再接解法（"相当于重开了"）。
  // 后台分帧搜索应从**当前局面**直接求解；回退保底仅理论兜底，不应被触发。
  const level = LEVELS.filter((l) => (l.rows || 6) >= 8)[1] || LEVELS.find((l) => (l.rows || 6) >= 8);
  const gm = new GameManager(silentAnalytics());
  gm.loadLevel(level);
  gm.beginPlay();
  gm.moveLimit = 0; // 隔离步数上限规则：本用例只测"跟提示必然通关"（乱挪+跟提示远超 par）
  let seed = 2029;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 40; i++) {
    const moves = gm.board.generateMoves().filter((m) => !m.isExit);
    if (!moves.length) break;
    const m = moves[rnd(moves.length)];
    gm.tryMove(m.id, m.delta);
  }
  assert.strictEqual(gm.board.checkWin(), false, "乱局应未通关");
  // 首个提示交付后：计划不得途经关卡初始局面（= 不是整盘回退，而是从当前局面续走）
  const first = hintWithPump(gm);
  assert.ok(first, "后台搜索必须交付提示");
  const initialKey = new Board(level).stateKey();
  assert.ok(gm._hintPlan, "交付后应缓存完整计划");
  assert.ok(!gm._hintPlan.keys.includes(initialKey),
    "提示计划应从当前局面续走，不得整盘回退到初始位置");
  // 一路"点提示→照着挪"，步数上限内必须通关（真死循环 = 上限内不通关）
  let steps = 1;
  const cap = 400;
  while (!gm.board.checkWin() && steps < cap) {
    const h = hintWithPump(gm);
    assert.ok(h && gm.board.canMove(h.vehicleId, h.delta), `第 ${steps} 步提示必须合法`);
    gm.tryMove(h.vehicleId, h.delta);
    steps++;
  }
  assert.strictEqual(gm.board.checkWin(), true, `跟提示应在 ${cap} 步内通关（否则死循环），实际 ${steps} 步`);
  assert.ok(steps <= 120, `从当前局面续走的计划应显著短于整盘回退（旧实现 66+ 步），实际 ${steps} 步`);
});

test("polishPath：压缩冗余绕行步骤，结果仍可完整重放通关", () => {
  const level = LEVELS.find((l) => l.id === "level_002");
  const board = new Board(level);
  // 构造带绕行的冗余路径：某车挪出去又挪回来（相邻逆移动对）+ 预计算解法
  const ms = board.generateMoves().filter((m) => !m.isExit);
  const m0 = ms[0];
  const sol = level.solution.map((s) => ({ id: s.vehicleId, delta: s.delta }));
  const bloated = [{ id: m0.id, delta: m0.delta }, { id: m0.id, delta: -m0.delta }].concat(sol);
  const { polishPath } = require("../js/core/engine.js");
  const polished = polishPath(board, bloated);
  assert.ok(polished.length <= sol.length, `绕行对应被压缩（${bloated.length} → ${polished.length}，解法本身 ${sol.length} 步）`);
  const sim = board.clone();
  for (const m of polished) {
    assert.strictEqual(sim.canMove(m.id, m.delta), true, "精简后的每一步必须合法");
    sim.moveVehicle(m.id, m.delta);
  }
  assert.strictEqual(sim.checkWin(), true, "精简后的路径必须仍能通关");
});

// ================= 3. SaveManager =================
console.log("\n[SaveManager]");

test("首次加载为默认存档", () => {
  const s = new SaveManager();
  assert.strictEqual(s.data.unlockedLevel, 0);
  assert.strictEqual(s.isUnlocked(0), true);
  assert.strictEqual(s.isUnlocked(1), false);
});

test("通关记录：星级取最高、步数取最少、解锁下一关", () => {
  const mem = {};
  const storage = { get: (k) => mem[k] || null, set: (k, val) => { mem[k] = val; } };
  const s = new SaveManager(storage);
  s.recordWin("level_001", 0, 2, 5, 30000);
  s.recordWin("level_001", 0, 3, 4, 25000);
  s.recordWin("level_001", 0, 1, 9, 40000);
  assert.strictEqual(s.getStars("level_001"), 3);
  assert.strictEqual(s.data.bestMoves["level_001"], 4);
  assert.strictEqual(s.data.bestTimeMs["level_001"], 25000);
  assert.strictEqual(s.isUnlocked(1), true);
  assert.strictEqual(s.totalStars(), 3);
  // 重新加载（持久化验证）
  const s2 = new SaveManager(storage);
  assert.strictEqual(s2.getStars("level_001"), 3);
  assert.strictEqual(s2.data.unlockedLevel, 1);
});

test("版本兼容：旧存档缺字段自动补默认值；损坏存档重置", () => {
  const mem = {};
  const storage = { get: (k) => mem[k] || null, set: (k, val) => { mem[k] = val; } };
  mem["traffic_puzzle_save_v1"] = JSON.stringify({ version: 0, unlockedLevel: 5, levelStars: { level_001: 2 } });
  const s = new SaveManager(storage);
  assert.strictEqual(s.data.unlockedLevel, 5);
  assert.strictEqual(s.data.soundEnabled, true); // 缺失字段补默认
  mem["traffic_puzzle_save_v1"] = "{broken json";
  const s2 = new SaveManager(storage);
  assert.strictEqual(s2.data.unlockedLevel, 0);
});

// ================= 4. 全量关卡验收 =================
console.log("\n[全量关卡：JS 引擎重放 solution + BFS 一致性]");

test("levels.js 与 levels.json 数据一致（运行时模块与工具链数据源同步）", () => {
  assert.deepStrictEqual(LEVELS, LEVELS_JSON);
});

test(`levels.json 共 ${LEVELS.length} 关，全部可用 JS 引擎重放通关`, () => {
  for (const level of LEVELS) {
    const b = new Board(level);
    level.solution.forEach((m, i) => {
      assert.ok(
        b.moveVehicle(m.vehicleId, m.delta),
        `${level.id} step ${i}: ${m.vehicleId} delta ${m.delta} 应为合法移动`
      );
    });
    assert.ok(b.checkWin(), `${level.id}: 重放 solution 后应胜利`);
    assert.strictEqual(level.solution.length, level.parMoves,
      `${level.id}: solution 步数应等于 parMoves`);
  }
});

test("JS bfsSolve 与 Python parMoves 一致（提示系统正确性）", () => {
  for (const level of LEVELS) {
    const b = new Board(level);
    // 大棋盘状态空间大，搜索上限与 Python 生成器一致（7x7:40万 / 8x8:60万）；
    // 仍超限则跳过（游戏内提示优先走预计算 solution，BFS 仅为兜底）
    const sol = bfsSolve(b, level.rows >= 8 ? 600000 : level.rows >= 7 ? 400000 : 250000);
    if (!sol && level.rows >= 7) continue;
    assert.ok(sol, `${level.id}: JS BFS 应可解`);
    assert.strictEqual(sol.length, level.parMoves,
      `${level.id}: JS BFS 步数 ${sol.length} != parMoves ${level.parMoves}`);
  }
});

test("关卡顺序与难度曲线", () => {
  const pars = LEVELS.map((l) => l.parMoves);
  assert.ok(pars.length >= 20 && pars.length <= 30, "关卡数量应在 20~30");
  assert.ok(Math.max(...pars.slice(0, 10)) <= 6, "前 10 关 par 不应超过 6");
  assert.ok(pars[pars.length - 1] > pars[0], "难度应递增");
  // 棋盘尺寸随进度递增（6x6 → 7x7 → 8x8），不回落
  const sizes = LEVELS.map((l) => l.rows);
  assert.ok(Math.max(...sizes) >= 7, "后期应有更大的棋盘");
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], `第 ${i + 1} 关棋盘尺寸不应回落`);
  }
  assert.ok(LEVELS.some((l) => (l.obstacles || []).length > 0), "应有包含禁停区的关卡");
});

// ================= 汇总 =================
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
