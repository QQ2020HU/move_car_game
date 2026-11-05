"use strict";
/**
 * 核心规则引擎（纯逻辑，无渲染依赖）。
 *
 * 对应开发文档模块：BoardManager / MoveValidator / CollisionDetector /
 * WinCondition / UndoManager。规则与 tools/level_solver.py 保持一致：
 * - 6x6 棋盘，坐标原点左上角
 * - 车辆沿自身轴向移动，不可重叠、不可越界（目标车右侧出库除外）
 * - 一次移动 = 一辆车一次拖动（任意格数）
 * - 目标车越过右边界（x + length > cols）即胜利
 *
 * 本模块同时运行于微信小游戏与 Node（用于单元测试）。
 */

/** 禁停区（障碍物）在网格中的标记 */
const OBSTACLE = "#";

/** 返回车辆占据的格子 [[cx, cy], ...]（可能包含界外格子） */
function vehicleCells(x, y, length, orientation) {
  const cells = [];
  for (let i = 0; i < length; i++) {
    if (orientation === "H") cells.push([x + i, y]);
    else cells.push([x, y + i]);
  }
  return cells;
}

class Board {
  constructor(levelData) {
    this.rows = levelData.rows;
    this.cols = levelData.cols;
    this.exit = { side: levelData.exit.side, row: levelData.exit.row };
    this.targetId = levelData.targetVehicleId;
    // 禁停区（障碍物）：[[x,y],...]，静态不可通行，网格中以 OBSTACLE 标记
    this.obstacles = (levelData.obstacles || []).map((c) => [c[0], c[1]]);
    this.vehicles = levelData.vehicles.map((v) => Object.assign({}, v));
    this.initialVehicles = levelData.vehicles.map((v) => Object.assign({}, v));
    this.won = false;
  }

  getVehicle(id) {
    for (const v of this.vehicles) if (v.id === id) return v;
    return null;
  }

  /** 占用网格 grid[row][col] = vehicleId | "#"（禁停区） | null（界外格子忽略） */
  getGrid() {
    const grid = [];
    for (let r = 0; r < this.rows; r++) grid.push(new Array(this.cols).fill(null));
    for (const [ox, oy] of this.obstacles) {
      if (ox >= 0 && ox < this.cols && oy >= 0 && oy < this.rows) grid[oy][ox] = OBSTACLE;
    }
    for (const v of this.vehicles) {
      for (const [cx, cy] of vehicleCells(v.x, v.y, v.length, v.orientation)) {
        if (cx >= 0 && cx < this.cols && cy >= 0 && cy < this.rows) grid[cy][cx] = v.id;
      }
    }
    return grid;
  }

  isInsideBoard(x, y) {
    return x >= 0 && x < this.cols && y >= 0 && y < this.rows;
  }

  _isExitVehicle(v) {
    return v.id === this.targetId && v.orientation === "H" && v.y === this.exit.row;
  }

  /**
   * 判断移动是否合法（整段路径检查，防止穿车）。
   * delta：沿车辆轴向的位移格数（H 为 x 方向，V 为 y 方向），正负均可。
   */
  canMove(id, delta) {
    const v = this.getVehicle(id);
    if (!v || delta === 0 || this.won) return false;
    const grid = this.getGrid();

    if (v.orientation === "H") {
      const nx = v.x + delta;
      if (delta > 0) {
        // 扫过格子：车头前方到新车尾
        for (let c = v.x + v.length; c < nx + v.length; c++) {
          if (c >= this.cols) {
            if (!this._isExitVehicle(v)) return false; // 非法出库
            continue;
          }
          if (grid[v.y][c]) return false;
        }
      } else {
        if (nx < 0) return false;
        for (let c = nx; c < v.x; c++) {
          if (grid[v.y][c]) return false;
        }
      }
    } else {
      const ny = v.y + delta;
      if (ny < 0 || ny + v.length > this.rows) return false;
      if (delta > 0) {
        for (let r = v.y + v.length; r < ny + v.length; r++) {
          if (grid[r][v.x]) return false;
        }
      } else {
        for (let r = ny; r < v.y; r++) {
          if (grid[r][v.x]) return false;
        }
      }
    }
    return true;
  }

  /** 提交一次合法移动；返回是否成功。成功后自动判定胜利。 */
  moveVehicle(id, delta) {
    if (!this.canMove(id, delta)) return false;
    const v = this.getVehicle(id);
    if (v.orientation === "H") v.x += delta;
    else v.y += delta;
    if (this._isExitVehicle(v) && v.x + v.length > this.cols) this.won = true;
    return true;
  }

  checkWin() {
    return this.won;
  }

  /**
   * 车辆可移动范围（供拖动 clamp）：返回头坐标 [lo, hi]。
   * 目标车允许出库时 hi 可越过棋盘（= cols，整车驶出）。
   */
  getMovableRange(id) {
    const v = this.getVehicle(id);
    if (!v || this.won) return null;
    const grid = this.getGrid();
    let lo, hi;
    if (v.orientation === "H") {
      lo = v.x;
      while (lo - 1 >= 0 && !grid[v.y][lo - 1]) lo--;
      hi = v.x;
      while (hi + v.length < this.cols && !grid[v.y][hi + v.length]) hi++;
      if (this._isExitVehicle(v)) {
        let clear = true;
        for (let c = v.x + v.length; c < this.cols; c++) {
          if (grid[v.y][c]) { clear = false; break; }
        }
        if (clear) hi = this.cols; // 允许整车拖出
      }
    } else {
      lo = v.y;
      while (lo - 1 >= 0 && !grid[lo - 1][v.x]) lo--;
      hi = v.y;
      while (hi + v.length < this.rows && !grid[hi + v.length][v.x]) hi++;
    }
    return { lo, hi };
  }

  /** 枚举全部合法移动（供提示系统 BFS）：[{id, delta, isExit}] */
  generateMoves() {
    const moves = [];
    if (this.won) return moves;
    const grid = this.getGrid();
    for (const v of this.vehicles) {
      if (v.orientation === "H") {
        let lo = v.x;
        while (lo - 1 >= 0 && !grid[v.y][lo - 1]) lo--;
        for (let d = lo - v.x; d < 0; d++) moves.push({ id: v.id, delta: d, isExit: false });
        let hi = v.x + v.length;
        while (hi < this.cols && !grid[v.y][hi]) hi++;
        for (let d = 1; d <= hi - (v.x + v.length); d++) {
          moves.push({ id: v.id, delta: d, isExit: false });
        }
        if (this._isExitVehicle(v)) {
          let clear = true;
          for (let c = v.x + v.length; c < this.cols; c++) {
            if (grid[v.y][c]) { clear = false; break; }
          }
          if (clear) moves.push({ id: v.id, delta: this.cols - v.x, isExit: true });
        }
      } else {
        let lo = v.y;
        while (lo - 1 >= 0 && !grid[lo - 1][v.x]) lo--;
        for (let d = lo - v.y; d < 0; d++) moves.push({ id: v.id, delta: d, isExit: false });
        let hi = v.y + v.length;
        while (hi < this.rows && !grid[hi][v.x]) hi++;
        for (let d = 1; d <= hi - (v.y + v.length); d++) {
          moves.push({ id: v.id, delta: d, isExit: false });
        }
      }
    }
    return moves;
  }

  /** 状态签名（用于去重 / 解法路径比对） */
  stateKey() {
    return this.vehicles.map((v) => v.x + "," + v.y).join("|");
  }

  clone() {
    const b = Object.create(Board.prototype);
    b.rows = this.rows;
    b.cols = this.cols;
    b.exit = { side: this.exit.side, row: this.exit.row };
    b.targetId = this.targetId;
    b.obstacles = this.obstacles;
    b.vehicles = this.vehicles.map((v) => Object.assign({}, v));
    b.initialVehicles = this.initialVehicles;
    b.won = this.won;
    return b;
  }

  restore(vehiclesSnapshot) {
    this.vehicles = vehiclesSnapshot.map((v) => Object.assign({}, v));
    this.won = false;
    const t = this.getVehicle(this.targetId);
    if (t && this._isExitVehicle(t) && t.x + t.length > this.cols) this.won = true;
  }

  snapshot() {
    return this.vehicles.map((v) => Object.assign({}, v));
  }
}

/**
 * BFS 求当前状态到胜利的最短解法（与 Python 求解器同语义）。
 * 返回 [{id, delta}] 或 null（无解 / 超上限）。
 */
function bfsSolve(board, stateLimit) {
  stateLimit = stateLimit || 60000;
  const start = board.clone();
  const queue = [{ board: start, sol: [] }];
  const seen = new Set([start.stateKey()]);
  while (queue.length) {
    if (seen.size > stateLimit) return null;
    const node = queue.shift();
    for (const m of node.board.generateMoves()) {
      const sol = node.sol.concat([{ id: m.id, delta: m.delta }]);
      if (m.isExit) return sol;
      const nb = node.board.clone();
      nb.moveVehicle(m.id, m.delta);
      const key = nb.stateKey();
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ board: nb, sol });
      }
    }
  }
  return null;
}

/** 二叉最小堆（按 f 升序，f 相同优先 g 大者——更接近目标先扩展） */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(a[i], a[p])) { const t = a[i]; a[i] = a[p]; a[p] = t; i = p; }
      else break;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && this._less(a[l], a[m])) m = l;
        if (r < a.length && this._less(a[r], a[m])) m = r;
        if (m === i) break;
        const t = a[i]; a[i] = a[m]; a[m] = t;
        i = m;
      }
    }
    return top;
  }
  _less(x, y) { return x.f !== y.f ? x.f < y.f : x.g > y.g; }
}

/**
 * 提示启发函数（可采纳）：出口行上挡在目标车与出口之间的**不同车辆数**
 * （每辆至少挪 1 次）+ 目标车自身至少 1 次出库移动。
 */
function hintHeuristic(board) {
  const t = board.getVehicle(board.targetId);
  if (!t || t.x + t.length > board.cols) return 0;
  const grid = board.getGrid();
  const blockers = new Set();
  for (let c = t.x + t.length; c < board.cols; c++) {
    const id = grid[t.y][c];
    if (id && id !== OBSTACLE) blockers.add(id);
  }
  return blockers.size + 1;
}

/**
 * A* 求解（可续算生成器版）：语义同 astarSolve，但不带调用方驱动的时间预算——
 * 每扩展 256 个节点 yield 一次，供调用方**分帧续算**（提示后台搜索：
 * 主线程每帧只推进十几毫秒，深度乱局也不冻结界面）。
 * weight：启发权重（f = g + weight×h）。weight=1 为最优解；weight>1 是
 * 加权 A*（次优但扩展数大幅减少——深度乱局实测 2.5s → 0.16s），
 * 提示系统不需要严格最优，多出的步数由 polishPath 精简。
 * wallMs：可选墙钟上限（跨分帧累计），超限返回 null。
 * 产出（return 值）[{id, delta}] 或 null（无解 / 超节点上限 / 超墙钟）。
 */
function* astarSolveIter(board, nodeLimit, weight, wallMs) {
  nodeLimit = nodeLimit || 120000;
  weight = weight || 1;
  const t0 = wallMs ? Date.now() : 0;
  const start = board.clone();
  const startKey = start.stateKey();
  const gScore = new Map();
  gScore.set(startKey, 0);
  const cameFrom = new Map(); // key -> { key, move }
  const open = new MinHeap();
  open.push({ key: startKey, board: start, g: 0, f: weight * hintHeuristic(start) });
  let expanded = 0;
  while (open.size) {
    if (expanded++ > nodeLimit) return null;
    if ((expanded & 255) === 0) { // 分帧切片点（兼做墙钟检查）
      yield;
      if (t0 && Date.now() - t0 > wallMs) return null;
    }
    const node = open.pop();
    const bestG = gScore.get(node.key);
    if (bestG !== undefined && node.g > bestG) continue; // 过期节点
    for (const m of node.board.generateMoves()) {
      const move = { id: m.id, delta: m.delta };
      if (m.isExit) {
        const path = [move];
        let k = node.key;
        while (cameFrom.has(k)) {
          const e = cameFrom.get(k);
          path.unshift(e.move);
          k = e.key;
        }
        return path;
      }
      const g2 = node.g + 1;
      const nb = node.board.clone();
      nb.moveVehicle(m.id, m.delta);
      const key = nb.stateKey();
      const prev = gScore.get(key);
      if (prev === undefined || g2 < prev) {
        gScore.set(key, g2);
        cameFrom.set(key, { key: node.key, move });
        open.push({ key, board: nb, g: g2, f: g2 + weight * hintHeuristic(nb) });
      }
    }
  }
  return null;
}

/**
 * A* 求解（同步限时版）：驱动 astarSolveIter，超时提前放弃返回 null——
 * 同步搜索会阻塞主线程，预算用于保证界面不"卡死"（深度乱局的完整搜索
 * 请走 astarSolveIter 分帧续算）。
 * 返回 [{id, delta}] 或 null（无解 / 超上限 / 超时）。
 */
function astarSolve(board, nodeLimit, timeBudgetMs) {
  const it = astarSolveIter(board, nodeLimit);
  const t0 = timeBudgetMs ? Date.now() : 0;
  let r;
  while (!(r = it.next()).done) {
    if (t0 && Date.now() - t0 > timeBudgetMs) { it.return(); return null; }
  }
  return r.value;
}

/**
 * Beam Search（可续算生成器版）：按 f=g+h 每层只保留最优 beamWidth 个状态。
 * 每层结束（及层内每生成 2048 个后继）yield 一次，供分帧续算。
 * 全局 seen 只记录**留在束内**的状态：被剪掉的状态后续层仍可重新生成——
 * 旧实现在生成时就封锁，剪枝丢弃的状态永远无法回访，束内后继全部撞墙时
 * 前沿枯竭直接返回 null（实测 8×8 深度乱局会出现这种"塌缩"）。
 * 产出 [{id, delta}]（不保证最短）或 null（束内无解）。
 */
function* beamSolveIter(board, beamWidth) {
  beamWidth = beamWidth || 300;
  const start = board.clone();
  let frontier = [{ board: start, key: start.stateKey(), g: 0, h: hintHeuristic(start), parent: null, move: null }];
  const seen = new Set([frontier[0].key]);
  let gen = 0;
  while (frontier.length) {
    const next = [];
    const layerSeen = new Set(); // 同层去重（跨层不封锁，见上）
    for (const node of frontier) {
      for (const m of node.board.generateMoves()) {
        if (m.isExit) {
          const path = [{ id: m.id, delta: m.delta }];
          for (let p = node; p && p.move; p = p.parent) path.unshift(p.move);
          return path;
        }
        if (++gen % 2048 === 0) yield; // 层内切片点（宽束一层可达数万个后继）
        const nb = node.board.clone();
        nb.moveVehicle(m.id, m.delta);
        const key = nb.stateKey();
        if (seen.has(key) || layerSeen.has(key)) continue;
        layerSeen.add(key);
        next.push({ board: nb, key, g: node.g + 1, h: hintHeuristic(nb), parent: node, move: { id: m.id, delta: m.delta } });
      }
    }
    if (!next.length) return null;
    next.sort((a, b) => (a.g + a.h) - (b.g + b.h) || a.h - b.h);
    frontier = next.slice(0, beamWidth);
    for (const n of frontier) seen.add(n.key);
    yield; // 层末切片点
  }
  return null;
}

/**
 * Beam Search（同步限时版）：驱动 beamSolveIter，超时返回 null。
 * 返回 [{id, delta}]（不保证最短）或 null（超时/束内无解）。
 */
function beamSolve(board, beamWidth, timeBudgetMs) {
  beamWidth = beamWidth || 300;
  timeBudgetMs = timeBudgetMs || 500;
  const it = beamSolveIter(board, beamWidth);
  const t0 = Date.now();
  let r;
  while (!(r = it.next()).done) {
    if (Date.now() - t0 > timeBudgetMs) { it.return(); return null; }
  }
  return r.value;
}

/**
 * 路径精简（纯验证式缩短，毫秒级）：Beam/贪心/保底回退给出的路径常有冗余
 * （同一辆车反复挪动、绕路）。两步压缩，每次改动都整体重放验证，
 * **返回的路径必然与原路径同样有效**（验证失败即保留原样）：
 * 1) 合并相邻的同车移动（+2 与 +1 → +3）；
 * 2) 反复尝试删除单步，删掉后剩余步骤仍可从当前局面合法重放并通关则保留删除。
 */
function polishPath(board, path) {
  if (!path || path.length < 2) return path;
  const verify = (p) => {
    const sim = board.clone();
    for (const m of p) {
      if (!sim.canMove(m.id, m.delta)) return false;
      sim.moveVehicle(m.id, m.delta);
    }
    return sim.checkWin();
  };
  let best = path.slice();
  // 1) 合并相邻同车移动（+2 与 +1 → +3；+1 与 -1 → 整对删除）
  for (let i = 0; i + 1 < best.length;) {
    if (best[i].id === best[i + 1].id) {
      const d = best[i].delta + best[i + 1].delta;
      const cand = best.slice();
      if (d === 0) cand.splice(i, 2);
      else cand.splice(i, 2, { id: best[i].id, delta: d });
      if (verify(cand)) { best = cand; continue; } // 合并后原位重查（可能连锁）
    }
    i++;
  }
  // 2) 单步删除（从后往前；每轮有删减就再来一轮，直到无可删）
  let changed = true;
  while (changed && best.length > 1) {
    changed = false;
    for (let i = best.length - 1; i >= 0; i--) {
      const cand = best.slice();
      cand.splice(i, 1);
      if (verify(cand)) { best = cand; changed = true; }
    }
  }
  return best;
}

/**
 * 单步贪心（兜底构件，永不长时间阻塞）：枚举当前所有合法移动，
 * 返回使启发值 h 下降最多的一步（同分时优先推进目标车）。
 * banMoves：可选，单个 {id, delta} 或数组——被禁移动仅在别无选择时才允许
 * （用于防"立刻反悔上一步"和贪心卷展时的破环回溯）。
 * 返回 {id, delta} 或 null（无任何合法移动）。
 */
function greedyStep(board, banMoves) {
  const bans = !banMoves ? [] : (Array.isArray(banMoves) ? banMoves : [banMoves]);
  const isBanned = (m) => bans.some((b) => b && b.id === m.id && b.delta === m.delta);
  let best = null;
  let bestBanned = null;
  for (const m of board.generateMoves()) {
    if (m.isExit) return { id: m.id, delta: m.delta };
    const nb = board.clone();
    nb.moveVehicle(m.id, m.delta);
    const nt = nb.getVehicle(board.targetId);
    const score = hintHeuristic(nb) * 1000 - (nt ? nt.x : 0);
    const cand = { score, id: m.id, delta: m.delta };
    if (isBanned(m)) {
      if (!bestBanned || score < bestBanned.score) bestBanned = cand;
    } else if (!best || score < best.score) {
      best = cand;
    }
  }
  const pick = best || bestBanned; // 全部被禁时才允许被禁移动
  return pick ? { id: pick.id, delta: pick.delta } : null;
}

/**
 * 贪心卷展求解（限时搜索全部超时后的最终兜底）：
 * 贪心优先 DFS + **路径内**局面去重（成环才回溯换次优分支，不跨分支封锁），
 * 成本毫秒级；在可解局面上几乎总能滚出一条（较长但）完整的通关路径——
 * 有了完整路径，提示系统就能缓存为"计划"，连续跟提示必然通关、绝不打转。
 * 返回 [{id, delta}] 或 null（guard 耗尽仍未通关）。
 */
function greedyRollout(board, maxSteps) {
  maxSteps = maxSteps || 250;
  const sim = board.clone();
  const path = [];
  const snaps = [];          // snaps[d] = 走第 d 步之前的快照（回溯用）
  const bans = [];           // bans[d] = 第 d 层已尝试且导致循环/枯竭的移动
  const onPath = new Set([sim.stateKey()]); // 仅当前路径上的局面（防成环）
  let guard = 0;
  const guardLimit = maxSteps * 8 + 200;
  const backtrack = () => {
    // 回退一层：封禁刚走过的那步，换该层次优分支
    if (!path.length) return false;
    const depth = path.length - 1;
    const leavingKey = sim.stateKey();
    const last = path.pop();
    sim.restore(snaps[depth]);
    onPath.delete(leavingKey);
    if (!bans[depth]) bans[depth] = [];
    bans[depth].push(last);
    for (let d = depth + 1; d < bans.length; d++) bans[d] = null; // 清除更深层的过期禁令
    return true;
  };
  while (guard++ < guardLimit) {
    if (sim.checkWin()) return path;
    if (path.length >= maxSteps) { if (!backtrack()) return null; continue; }
    const depth = path.length;
    if (!bans[depth]) bans[depth] = [];
    const banList = bans[depth].slice();
    if (path.length) {
      const p = path[path.length - 1];
      banList.push({ id: p.id, delta: -p.delta }); // 禁止立刻反悔
    }
    const m = greedyStep(sim, banList);
    // greedyStep 在"全部被禁"时会返回 bestBanned（已试败的移动）——
    // 视为该层枯竭，直接回溯，避免反复推入已知失败分支空耗 guard
    const exhausted = !m || !sim.canMove(m.id, m.delta) ||
      banList.some((b) => b.id === m.id && b.delta === m.delta);
    if (exhausted) { if (!backtrack()) return null; continue; }
    snaps[depth] = sim.snapshot();
    sim.moveVehicle(m.id, m.delta);
    path.push(m);
    const key = sim.stateKey();
    if (onPath.has(key) && !sim.checkWin()) {
      // 成环：弹出该步并封禁（key 属于路径上更早的节点，仍留在 onPath 中，
      // 不能删除——否则更早节点失去保护，分支间可无限振荡空耗 guard）
      path.pop();
      sim.restore(snaps[depth]);
      bans[depth].push(m);
      for (let d = depth + 1; d < bans.length; d++) bans[d] = null;
      continue;
    }
    onPath.add(key);
  }
  return sim.checkWin() ? path : null;
}

module.exports = {
  Board, vehicleCells, bfsSolve,
  astarSolve, astarSolveIter, beamSolve, beamSolveIter, polishPath,
  greedyStep, greedyRollout, hintHeuristic, OBSTACLE,
};
