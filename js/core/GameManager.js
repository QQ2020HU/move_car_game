"use strict";
/**
 * GameManager：控制游戏状态与生命周期（P0）。
 * 持有 Board（规则引擎）、状态机、步数、计时、撤销栈、提示计数，
 * 对外提供 tryMove / undo / restart / pause / resume 等操作，
 * 并通过回调向 UI 层广播事件。规则不写在 UI 里（文档 §3.1 原则）。
 */

const {
  Board, astarSolve, beamSolve, astarSolveIter,
  greedyStep, greedyRollout, polishPath,
} = require("./engine.js");
const { GameState, StateMachine } = require("./GameState.js");

/** 后台提示搜索的墙钟上限（毫秒）：深度乱局从当前局面续算的最长等待，超时落保底回退 */
const HINT_SEARCH_WALL_MS = 8000;

class GameManager {
  constructor(analytics) {
    this.analytics = analytics || null;
    this.sm = new StateMachine();
    this.board = null;
    this.levelData = null;
    this.moves = 0;
    this.moveLimit = 0;      // 本关步数上限（0 = 无上限；教学关 par≤5 不限步）
    this.pendingFail = false; // 已达步数上限，待吸附动画结束后进入 FAIL
    this.reviveCount = 0;    // 本关复活次数
    this.hintsUsed = 0;
    this.undoStack = [];
    this.elapsedMs = 0;
    this.pendingWin = null;
    this._lastTick = 0;
    this._hintPlan = null;    // 计划式提示：{moves, keys, index}
    this._hintSearch = null;  // 后台分帧搜索：{gen, deadline}（深度乱局时从当前局面续算）
    this._lastHintMove = null; // 上一次提示的移动（贪心兜底防 A↔B 反悔）
    this._moveHistory = [];   // 玩家历史移动 [{id, delta}]（提示"原路返回"保底用）
    this.callbacks = {
      onMove: null,      // (vehicleId, delta, moves)
      onWin: null,       // ({moves, timeMs, stars, parMoves, hintsUsed})
      onFail: null,      // ({levelId, moves, moveLimit})
      onRevive: null,    // ({addedMoves, revives})
      onUndo: null,      // (moves)
      onRestart: null,
      onStateChange: null, // (state, prev)
    };
  }

  on(eventName, fn) {
    this.callbacks[eventName] = fn;
  }

  loadLevel(levelData) {
    this.levelData = levelData;
    this.board = new Board(levelData);
    this.moves = 0;
    this.moveLimit = this.computeMoveLimit(levelData);
    this.pendingFail = false;
    this.reviveCount = 0;
    this.hintsUsed = 0;
    this.undoStack = [];
    this.elapsedMs = 0;
    this.pendingWin = null;
    this._hintPlan = null;
    this._hintSearch = null;
    this._lastHintMove = null;
    this._moveHistory = [];
    this._lastTick = Date.now();
    this.sm.state = GameState.LOADING; // 重置（loadLevel 允许从任意状态进入）
    this.sm.set(GameState.READY);
  }

  /** READY → PLAYING：玩家开始操作 */
  beginPlay() {
    if (this.sm.state === GameState.READY) {
      this.sm.set(GameState.PLAYING);
      this._lastTick = Date.now();
    }
  }

  tick() {
    const now = Date.now();
    if (this.sm.state === GameState.PLAYING || this.sm.state === GameState.ANIMATING) {
      this.elapsedMs += now - this._lastTick;
    }
    this._lastTick = now;
  }

  get state() {
    return this.sm.state;
  }

  /**
   * 提交一次移动（UI 拖动吸附后调用）。
   * 返回 {ok, win, delta}。动画由 UI 层负责，期间用 beginAnimating/endAnimating 锁定输入。
   */
  tryMove(vehicleId, delta) {
    if (!this.board) return { ok: false };
    if (this.sm.state !== GameState.PLAYING && this.sm.state !== GameState.READY) {
      return { ok: false };
    }
    this.beginPlay();
    if (!this.board.canMove(vehicleId, delta)) {
      if (this.analytics) {
        this.analytics.track("vehicle_move", {
          levelId: this.levelData.id, vehicleId, delta, success: false,
        });
      }
      return { ok: false };
    }
    // 移动前保存快照（文档 §5.4）
    this.undoStack.push({ vehicles: this.board.snapshot(), moves: this.moves });
    this.board.moveVehicle(vehicleId, delta);
    this._moveHistory.push({ id: vehicleId, delta });
    this._hintSearch = null; // 局面已变，作废进行中的后台提示搜索
    this.moves++;
    if (this.analytics) {
      this.analytics.track("vehicle_move", {
        levelId: this.levelData.id, vehicleId, delta, success: true,
      });
    }
    if (this.callbacks.onMove) this.callbacks.onMove(vehicleId, delta, this.moves);

    const win = this.board.checkWin();
    if (win) {
      const stars = this.computeStars(this.moves, this.levelData.parMoves);
      const result = {
        moves: this.moves,
        timeMs: this.elapsedMs,
        stars,
        parMoves: this.levelData.parMoves,
        hintsUsed: this.hintsUsed,
        levelId: this.levelData.id,
      };
      // 文档 §3.3：WIN 只能由 ANIMATING 进入（出库动画结束后）
      this.sm.set(GameState.ANIMATING);
      this.pendingWin = result;
      if (this.analytics) this.analytics.track("level_win", result);
      if (this.callbacks.onWin) this.callbacks.onWin(result);
    } else if (this.moveLimit > 0 && this.moves >= this.moveLimit) {
      // 步数用尽：与 WIN 对称，吸附动画结束后 ANIMATING → FAIL
      this.pendingFail = true;
      this.sm.set(GameState.ANIMATING);
      const info = { levelId: this.levelData.id, moves: this.moves, moveLimit: this.moveLimit };
      if (this.analytics) {
        this.analytics.track("level_fail", Object.assign({ revives: this.reviveCount }, info));
      }
      if (this.callbacks.onFail) this.callbacks.onFail(info);
    }
    return { ok: true, win, delta };
  }

  beginAnimating() {
    if (this.sm.state === GameState.PLAYING) this.sm.set(GameState.ANIMATING);
  }

  /** 动画结束：目标车已出库 → WIN；步数用尽 → FAIL；否则回到 PLAYING（文档 §3.3） */
  endAnimating() {
    if (this.sm.state === GameState.ANIMATING) {
      if (this.board && this.board.checkWin()) {
        this.pendingFail = false;
        this.sm.set(GameState.WIN);
      } else if (this.pendingFail) {
        this.sm.set(GameState.FAIL);
      } else {
        this.sm.set(GameState.PLAYING);
      }
    }
  }

  /**
   * 步数上限：由 par 推导，宽松到不惩罚谨慎玩家——
   * limit = par + max(6, ceil(par×0.8))，约为 par 的 1.8~2 倍。
   * 撤销会退还步数（快照含 moves），只有"净移动"消耗上限；
   * 首章教学关（par ≤ 5）不设上限，新手期不会见到失败画面。
   * 返回 0 表示不限步。
   */
  computeMoveLimit(levelData) {
    const par = (levelData && levelData.parMoves) || 0;
    if (par <= 5) return 0;
    return par + Math.max(6, Math.ceil(par * 0.8));
  }

  /** 单次复活赠送的步数：至少 5 步，高 par 关卡给 par 的一半（足够从当前局面续走） */
  reviveMoves() {
    const par = (this.levelData && this.levelData.parMoves) || 0;
    return Math.max(5, Math.ceil(par / 2));
  }

  /**
   * 复活：仅 FAIL 状态可用 → PLAYING，步数上限增加 extraMoves（默认 reviveMoves()），
   * 棋盘与已用步数保留。reason 用于埋点区分来源（"ad" / "coins" / "free"）。
   */
  revive(extraMoves, reason) {
    if (this.sm.state !== GameState.FAIL) return false;
    const add = Math.max(1, extraMoves || this.reviveMoves());
    this.moveLimit += add;
    this.pendingFail = false;
    this.reviveCount++;
    this.sm.set(GameState.PLAYING);
    this._lastTick = Date.now();
    if (this.analytics) {
      this.analytics.track("level_revive", {
        levelId: this.levelData.id, revives: this.reviveCount, addedMoves: add, reason: reason || "free",
      });
    }
    if (this.callbacks.onRevive) this.callbacks.onRevive({ addedMoves: add, revives: this.reviveCount });
    return true;
  }

  computeStars(moves, parMoves) {
    if (moves <= parMoves) return 3;
    if (moves <= parMoves + 3) return 2;
    return 1;
  }

  undo() {
    if (this.sm.state !== GameState.PLAYING && this.sm.state !== GameState.READY) return false;
    if (!this.undoStack.length) return false;
    const snap = this.undoStack.pop();
    this.board.restore(snap.vehicles);
    this.moves = snap.moves;
    this._moveHistory.pop();
    this._hintSearch = null; // 局面已变，作废进行中的后台提示搜索
    if (this.analytics) {
      this.analytics.track("undo", { levelId: this.levelData.id, moves: this.moves });
    }
    if (this.callbacks.onUndo) this.callbacks.onUndo(this.moves);
    return true;
  }

  restart() {
    if (!this.levelData) return;
    if (this.moves > 0 && this.sm.state !== GameState.WIN && this.analytics) {
      this.analytics.track("level_restart", {
        levelId: this.levelData.id, moves: this.moves,
      });
    }
    this.loadLevel(this.levelData);
    if (this.callbacks.onRestart) this.callbacks.onRestart();
  }

  pause() {
    this.tick();
    if (this.sm.state === GameState.READY) {
      this.sm.set(GameState.PAUSED);
      return true;
    }
    if (this.sm.state === GameState.PLAYING || this.sm.state === GameState.ANIMATING) {
      this.sm.state = GameState.PLAYING; // ANIMATING 时先归位再暂停
      this.sm.set(GameState.PAUSED);
      return true;
    }
    return false;
  }

  resume() {
    if (this.sm.state === GameState.PAUSED) {
      this.sm.set(GameState.PLAYING);
      this._lastTick = Date.now();
      return true;
    }
    return false;
  }

  /**
   * 提示（文档 §5.5）：**计划式提示**，任何局面绝不卡死、绝不死循环——
   * 1) 已有提示计划且当前局面在计划路径上 → 直接给计划的下一步（0ms，
   *    连续点提示 = 沿同一条完整解法前进，必然通关；旧实现每次独立算
   *    "第一步"，两次提示互相矛盾会 A↔B 来回打转）；
   * 2) 同步快搜（≤1s 左右）：预计算 solution 后缀 → 限时 A*（最优）
   *    → 限时 Beam Search（次优但快），命中即缓存为计划；
   * 3) 深度乱局（同步快搜超时）→ **后台分帧搜索**：启动生成器搜索并立即
   *    返回 null（hintComputing=true），由 UI 每帧调 pumpHint(≈12ms) 续算，
   *    界面不冻结；用**加权 A***（f=g+2h，完整不空转）从当前局面直接求解
   *    （不再要求玩家把棋局还原回起点）；
   * 4) 保底路径（数学上必然有效，仅后台搜索也耗尽/超时时才走到）：
   *    历史移动倒序撤销回初始局面再接预计算 solution → 贪心卷展 → 单步贪心。
   * 所有完整路径入计划前都经 polishPath 精简 + 重放校验。
   * 返回 {vehicleId, delta}；null = 已通关 / 后台搜索计算中（UI 显示"计算中"
   * 并轮询 pumpHint）/ 无任何合法移动。
   */
  getHint() {
    if (!this.board || this.board.checkWin()) { this._hintPlan = null; this._hintSearch = null; return null; }
    if (this._hintSearch) return null; // 后台搜索进行中，等 pumpHint 交付
    // 1) 沿已缓存的提示计划走（玩家撤销/偏离会自动失配并重算）
    let move = this._nextFromPlan();
    if (!move) {
      // 2) 同步快搜：预计算 solution 后缀 → 限时 A* → 限时 Beam
      const small = (this.board.rows || 6) <= 6;
      let path = this._solutionSuffix();
      if (!path) path = astarSolve(this.board, 120000, small ? 800 : 350);
      if (!path) path = beamSolve(this.board, 300, small ? 500 : 300);
      if (path && path.length) {
        this._setHintPlan(path);
        move = this._nextFromPlan();
      }
      // 3) 深度乱局：转入后台分帧搜索（不阻塞主线程），本次先返回 null
      if (!move) {
        this._startHintSearch(small);
        return null;
      }
    }
    return move ? this._deliverMove(move) : null;
  }

  /** 后台提示搜索是否进行中（UI 据此显示"计算中"并每帧 pumpHint） */
  get hintComputing() { return !!this._hintSearch; }

  _startHintSearch(small) {
    this._hintSearch = {
      gen: this._hintSearchGen(small),
      // 墙钟上限：从当前局面分帧搜索的最长等待。超过即落保底回退——
      // 极深度乱局（如随机 40+ 步的 8×8）A* 也可能要十几秒，spinner 不能永远转。
      deadline: Date.now() + HINT_SEARCH_WALL_MS,
    };
  }

  /**
   * 后台搜索序列（生成器，逐帧推进）：**加权 A***（f=g+2h，次优但完整——
   * 不像 Beam 会在束内无解时长时间空转）直接从**当前局面**求解，玩家无需
   * 先把棋局还原回起点。多出的绕行步数由 polishPath 精简。
   * A* 超节点上限仍无解（理论罕见）→ 保底：原路返回初始局面 + 预计算解法
   * → 贪心卷展。整段搜索还受 pumpHint 的墙钟上限约束（超时同样落保底）。
   */
  *_hintSearchGen(small) {
    const board = this.board;
    // weight=2 的加权 A*；节点上限给足（墙钟上限先触发）
    let path = yield* astarSolveIter(board, small ? 80000 : 200000, 2);
    if (path && path.length) return path;
    // 保底：原路返回初始局面 + 预计算解法（必然有效）→ 贪心卷展
    path = this._rewindPlan();
    if (path && path.length) return path;
    const roll = greedyRollout(board, 250);
    return roll && roll.length ? roll : null;
  }

  /**
   * 推进后台提示搜索（UI 每帧调用）。ms = 本帧最多花在该搜索上的毫秒数。
   * 返回：undefined = 仍在计算；{vehicleId, delta} = 计算完成并交付提示；
   * null = 无搜索在进行 / 计算完成但无任何可用提示（死局，理论上不可达）。
   */
  pumpHint(ms) {
    const s = this._hintSearch;
    if (!s) return null;
    const t0 = Date.now();
    for (;;) {
      if (Date.now() > s.deadline) {
        // 墙钟超限：放弃搜索，落保底回退（必然有效，绝不空转）
        this._hintSearch = null;
        return this._deliverPath(this._rewindPlan() || greedyRollout(this.board, 250));
      }
      const r = s.gen.next();
      if (r.done) {
        this._hintSearch = null;
        return this._deliverPath(r.value);
      }
      if (Date.now() - t0 >= ms) return undefined; // 本帧配额用完，下帧继续
    }
  }

  /** 后台搜索完成：路径入计划并交付第一步（失败则逐级兜底） */
  _deliverPath(path) {
    if (path && path.length) {
      this._setHintPlan(path);
      const m = this._nextFromPlan();
      if (m) return this._deliverMove(m);
    }
    // 极端兜底（正常不可达）：路径重放校验失败 → 贪心卷展 → 单步贪心
    const roll = greedyRollout(this.board, 250);
    if (roll && roll.length) {
      this._setHintPlan(roll);
      const m = this._nextFromPlan();
      if (m) return this._deliverMove(m);
    }
    const g = greedyStep(this.board, this._lastHintMove);
    return g ? this._deliverMove({ vehicleId: g.id, delta: g.delta }) : null;
  }

  /** 交付一步提示：记录防反悔、计数、埋点 */
  _deliverMove(move) {
    this._lastHintMove = { id: move.vehicleId, delta: move.delta };
    this.hintsUsed++;
    if (this.analytics) {
      this.analytics.track("hint_used", {
        levelId: this.levelData.id, hints: this.hintsUsed,
      });
    }
    return move;
  }

  /** 缓存完整解法为"提示计划"：先精简冗余步骤，再记录每步之前的局面签名 keys */
  _setHintPlan(path) {
    path = polishPath(this.board, path);
    const moves = path.map((m) => ({ id: m.id != null ? m.id : m.vehicleId, delta: m.delta }));
    const keys = [];
    const sim = this.board.clone();
    for (const m of moves) {
      keys.push(sim.stateKey());
      if (!sim.canMove(m.id, m.delta)) { this._hintPlan = null; return; }
      sim.moveVehicle(m.id, m.delta);
    }
    this._hintPlan = { moves, keys, index: 0 };
  }

  /**
   * 当前局面若匹配计划中的某个节点，返回该节点的下一步移动。
   * 正常跟提示走时命中 keys[index]；玩家撤销时回退命中更早的 keys[i]（自动回卷）。
   * 完全偏离 → 丢弃计划返回 null（触发重算）。
   */
  _nextFromPlan() {
    const plan = this._hintPlan;
    if (!plan) return null;
    const key = this.board.stateKey();
    if (plan.keys[plan.index] === key && plan.index < plan.moves.length) {
      const m = plan.moves[plan.index++];
      return { vehicleId: m.id, delta: m.delta };
    }
    const i = plan.keys.indexOf(key);
    if (i >= 0 && i < plan.moves.length) {
      plan.index = i + 1;
      const m = plan.moves[i];
      return { vehicleId: m.id, delta: m.delta };
    }
    this._hintPlan = null; // 偏离计划
    return null;
  }

  /**
   * 保底提示路径：把玩家历史移动倒序撤销（每步都是刚走过的合法移动的
   * 逆移动，必然可走）回到关卡初始局面，再接预计算 solution 通关。
   * 仅在后台分帧搜索（Beam/A*）也耗尽或超墙钟上限时才会走到——
   * **数学上必然有效**，保证提示永远有完整计划可跟、绝不死循环。
   * 入计划前经 polishPath 精简（玩家来回挪过的冗余步骤会被压缩掉）。
   * 返回 [{id, delta}]；无历史且局面非初始时由 _setHintPlan 重放校验兜底。
   */
  _rewindPlan() {
    const solution = (this.levelData && this.levelData.solution) || [];
    if (!this._moveHistory.length && !solution.length) return null;
    const path = [];
    for (let i = this._moveHistory.length - 1; i >= 0; i--) {
      const m = this._moveHistory[i];
      path.push({ id: m.id, delta: -m.delta });
    }
    for (const s of solution) path.push({ id: s.vehicleId, delta: s.delta });
    return path;
  }

  /** 当前局面在预计算 solution 路径上时，返回剩余后缀 [{id, delta}]，否则 null */
  _solutionSuffix() {
    const solution = this.levelData && this.levelData.solution;
    if (!solution || !solution.length) return null;
    const sim = new Board(this.levelData);
    const currentKey = this.board.stateKey();
    if (sim.stateKey() === currentKey) {
      return solution.map((m) => ({ id: m.vehicleId, delta: m.delta }));
    }
    for (let i = 0; i < solution.length; i++) {
      const m = solution[i];
      if (!sim.canMove(m.vehicleId, m.delta)) return null;
      sim.moveVehicle(m.vehicleId, m.delta);
      if (sim.stateKey() === currentKey) {
        if (i + 1 >= solution.length) return null;
        return solution.slice(i + 1).map((s) => ({ id: s.vehicleId, delta: s.delta }));
      }
    }
    return null;
  }
}

module.exports = { GameManager, GameState };
