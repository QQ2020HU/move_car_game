"use strict";
/**
 * UIManager：菜单、按钮、弹窗和 HUD（P0，文档 §3.2 / §7）。
 *
 * 场景：menu（主菜单）/ select（选关）/ game（对局，含 win / pause 弹层）。
 * 首版美术：纯色车辆 + 网格 + 简单阴影（文档 §7 玩法验证优先）。
 * 车辆统一俯视角，横向车与纵向车视觉可辨；目标车为红色并带箭头标识。
 *
 * 拖动流程（文档 §5.3）：
 * touchstart 命中车辆 → touchmove 沿允许轴向位移并 clamp 到可达范围 →
 * touchend 吸附最近合法格 → GameManager.tryMove 提交 → 动画 → 步数/胜利更新。
 */

const { GameState } = require("../core/GameState.js");
const VehicleRenderer = require("./VehicleRenderer.js");
const themes = require("./themes.js");
const skins = require("./skins.js");

// ---------------- 主题 ----------------
const THEME = {
  bg: "#1d2531",
  panel: "#27334a",
  panelLight: "#324162",
  boardBg: "#232e40",
  cellA: "#2c3a52",
  cellB: "#293650",
  gridLine: "rgba(255,255,255,0.05)",
  text: "#f2f5fa",
  textSub: "#93a1b5",
  accent: "#4a90d9",
  danger: "#e05252",
  gold: "#f7c948",
  exit: "#59c36b",
  target: "#e04b4b",
  cars: ["#4a90d9", "#f5a623", "#7ed321", "#b072d4", "#42c6b0", "#ef87a8", "#8d99ae", "#d98e4a"],
  buttonBg: "#3a4a63",
  buttonText: "#ffffff",
};

const SCENE = { MENU: "menu", SELECT: "select", GAME: "game" };

// 每关免费提示次数；用尽后若激励视频可用，需看视频解锁"本关提示不限次"。
// 广告不可用（未开通流量主/审核期/加载失败）时配额不生效，提示始终免费。
const HINT_FREE_PER_LEVEL = 3;

// 金币复活定价（金币经济的第一个消费出口；通关奖励 星数×10，可翻倍）
const REVIVE_COIN_COST = 150;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

class UIManager {
  constructor(canvas, deps) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.gm = deps.gameManager;
    this.levels = deps.levelManager;
    this.save = deps.saveManager;
    this.audio = deps.audio;
    this.analytics = deps.analytics;

    this.scene = SCENE.MENU;
    this.overlay = null; // "win" | "fail" | "pause" | "adHint" | "chapter" | "shop" | null
    this.winInfo = null;
    this.replay = null;    // 最优解幽灵回放 {steps, index, total, nextAt} | null
    this.buttons = [];   // 每帧重建：{x,y,w,h,action}
    this.tweens = [];    // {id, axis, from, to, start, dur, onDone}
    this.drag = null;
    this.hint = null;    // {vehicleId, delta, dir, axis, until}
    this.hintPending = false; // 深度乱局：后台分帧搜索中（每帧 pump，显示"计算中"）
    this.ads = deps.ads || null; // AdManager（null = 广告逻辑全部静默降级）
    this._hintFreeUsed = 0;      // 本关已消耗的免费提示次数
    this._hintUnlimited = false; // 看视频后本关提示不限次
    this.winCoins = 0;           // 本次通关的金币基础奖励（星数×10）
    this.winCoinsDoubled = false;// 是否已看视频翻倍金币
    this.starAnim = 0;
    this.currentLevelIndex = 0;
    this.particles = []; // 通关彩带粒子
    this.isNewRecord = false;
    this.flashes = [];   // 双闪提示 [{id, until}]（无效拖动/碰撞时）
    this.gateOpenedAt = 0; // 出口栏杆开启时间戳
    this.gridCols = 6;   // 当前关卡棋盘尺寸（随 startLevel 更新）
    this.gridRows = 6;
    this.theme = null;   // 当前章节主题（js/ui/themes.js，随 startLevel 更新）
    this.barY = 0;       // 底部操作栏 Y（主题装饰布局用）
    this.mood = { state: null, since: 0 }; // 目标车情绪气泡（😤堵死 / 😄通路打开）
    this.chapterCard = null; // 章节过场卡片 {theme, idx, start}
    this._lastFrame = Date.now();

    this._resize();
    this._bindEvents();

    // GameManager 事件
    this.gm.on("onWin", (info) => {
      const prevBest = this.save.data.bestMoves[info.levelId];
      this.isNewRecord = !prevBest || info.moves < prevBest;
      this.winInfo = info;
      this.save.recordWin(info.levelId, this.currentLevelIndex, info.stars, info.moves, info.timeMs);
      // 金币奖励：星数×10（结算页可看激励视频翻倍）
      this.winCoins = info.stars * 10;
      this.winCoinsDoubled = false;
      if (this.winCoins > 0) this.save.addCoins(this.winCoins);
      if (this.ads) this.ads.notifyWin();
      this._spawnConfetti();
      this.audio.play("win");
      if (typeof wx !== "undefined" && wx.vibrateShort) {
        try { wx.vibrateShort({ type: "medium" }); } catch (e) { /* ignore */ }
      }
    });

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    if (this.ads) this.ads.showBanner(); // 首屏为菜单场景，可展示 Banner
    // 尝试拉起背景音乐（Android 可直接出声；iOS 静默等待首次触摸兜底，见 _onTouchStart）
    this.audio.startBgm();
  }

  // ---------------- 尺寸与适配 ----------------
  _resize() {
    const info = typeof wx !== "undefined" && wx.getWindowInfo
      ? wx.getWindowInfo()
      : (typeof wx !== "undefined" ? wx.getSystemInfoSync() : { windowWidth: 390, windowHeight: 844, pixelRatio: 2 });
    this.W = info.windowWidth;
    this.H = info.windowHeight;
    this.safeTop = (info.safeArea && info.safeArea.top) || (typeof info.statusBarHeight === "number" ? info.statusBarHeight : 20);
    const pr = info.pixelRatio || 1;
    this.canvas.width = Math.round(this.W * pr);
    this.canvas.height = Math.round(this.H * pr);
    this.ctx.setTransform(pr, 0, 0, pr, 0, 0);
    this._computeBoardLayout();
  }

  _computeBoardLayout() {
    const topBarH = this.safeTop + 96;
    const bottomBarH = 96;
    const availW = this.W - 28;
    const availH = this.H - topBarH - bottomBarH - 12;
    const cols = this.gridCols || 6;
    const rows = this.gridRows || 6;
    // 棋盘随关卡尺寸变化（6x6 / 7x7 / 8x8），保持方形格子
    const cell = Math.max(24, Math.min(availW / cols, availH / rows));
    this.cell = cell;
    this.boardW = cell * cols;
    this.boardH = cell * rows;
    this.boardSize = this.boardW; // 兼容旧引用（宽度）
    this.boardX = (this.W - this.boardW) / 2;
    this.boardY = topBarH + Math.max(0, (availH - this.boardH) / 2);
  }

  // ---------------- 输入 ----------------
  _bindEvents() {
    if (typeof wx === "undefined") return;
    wx.onTouchStart((e) => this._onTouchStart(e.touches[0]));
    wx.onTouchMove((e) => this._onTouchMove(e.touches[0]));
    wx.onTouchEnd((e) => {
      const t = (e.changedTouches && e.changedTouches[0]) || null;
      this._onTouchEnd(t);
    });
    wx.onTouchCancel(() => this._onTouchEnd(null));
    wx.onWindowResize && wx.onWindowResize(() => this._resize());
    wx.onHide(() => this.onAppHide());
    wx.onShow(() => this.onAppShow());
  }

  onAppHide() {
    this.audio.stopEngine();
    this.audio.stopBgm(); // 切后台停止背景音乐调度（省电 + 避免后台出声）
    if (this.scene === SCENE.GAME && this.gm.state === GameState.PLAYING) {
      this.gm.pause();
      this.overlay = "pause";
    }
    this.analytics.gameExit();
  }

  onAppShow() {
    this.audio.startBgm(); // 回前台恢复背景音乐（开关关闭时为 no-op）
    this.analytics.gameStart(this.gm.levelData ? this.gm.levelData.id : null);
  }

  _hitButton(x, y) {
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  _onTouchStart(touch) {
    if (!touch) return;
    // iOS：WebAudio 须在用户手势后才能出声——每次触摸兜底拉起 BGM（幂等）
    this.audio.startBgm();
    // 最优解回放中：轻点任意处跳过，回到结算弹层
    if (this.replay) { this._endReplay(false); return; }
    const x = touch.clientX, y = touch.clientY;
    const btn = this._hitButton(x, y);
    if (btn) {
      this.audio.play("button");
      btn.action();
      return;
    }
    if (this.scene !== SCENE.GAME || this.overlay) return;
    if (this.tweens.length) return; // 动画期间禁止提交下一次移动（文档 §3.3）
    if (this.gm.state === GameState.PAUSED) return;

    // 命中车辆 → 开始拖动
    const board = this.gm.board;
    const col = Math.floor((x - this.boardX) / this.cell);
    const row = Math.floor((y - this.boardY) / this.cell);
    if (!board || col < 0 || col >= board.cols || row < 0 || row >= board.rows) return;
    const grid = board.getGrid();
    const id = grid[row][col];
    if (id === "#") { // 点到禁停区：闷响反馈
      this.audio.play("invalid");
      return;
    }
    if (!id) return; // 空格
    const v = board.getVehicle(id);
    if (!v) return;
    const range = board.getMovableRange(id);
    if (!range || range.lo === range.hi) {
      // 完全无法移动：鸣笛 + 双闪提示
      this._honkAndFlash(id);
      return;
    }
    let lo = range.lo, hi = range.hi;
    // 提示锁定：提示生效期间沿提示方向拖这辆车，最多拖到目标虚线框——
    // "拖到头"也精确落在提示位置（计划式提示要求精确格数，拖过头会偏离计划）
    if (this.hint && this.hint.vehicleId === id && this._now() <= this.hint.until) {
      const pos = v.orientation === "H" ? v.x : v.y;
      if (this.hint.delta > 0) hi = Math.min(hi, pos + this.hint.delta);
      else lo = Math.max(lo, pos + this.hint.delta);
    }
    this.drag = {
      id,
      axis: v.orientation === "H" ? "x" : "y",
      startPos: v.orientation === "H" ? v.x : v.y,
      touchStart: v.orientation === "H" ? x : y,
      lo,
      hi,
      offsetPx: 0,
      lastT: this._now(),
      lastPx: v.orientation === "H" ? x : y,
    };
    this.audio.play("drag");
    // 引擎声：按车型启动（卡车/巴士/轿车/SUV/跑车音色不同）
    const kind = VehicleRenderer.vehicleKind(v, id === this.gm.board.targetId);
    this.audio.startEngine(kind);
  }

  _onTouchMove(touch) {
    if (!this.drag || !touch) return;
    const cur = this.drag.axis === "x" ? touch.clientX : touch.clientY;
    const raw = cur - this.drag.touchStart;
    const minPx = (this.drag.lo - this.drag.startPos) * this.cell;
    const maxPx = (this.drag.hi - this.drag.startPos) * this.cell;
    this.drag.offsetPx = Math.max(minPx, Math.min(maxPx, raw));
    // 引擎声随拖动速度变化
    const now = this._now();
    const dt = Math.max(1, now - this.drag.lastT);
    const speed = Math.abs(cur - this.drag.lastPx) / dt; // px/ms
    this.drag.lastT = now;
    this.drag.lastPx = cur;
    this.audio.updateEngine(Math.min(1, speed / 1.1));
  }

  _onTouchEnd(touch) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.audio.stopEngine();
    const delta = Math.round(drag.offsetPx / this.cell);
    if (delta === 0) {
      // 轻点提示高亮的车辆（几乎无位移）→ 自动精确执行提示移动
      if (Math.abs(drag.offsetPx) <= 2 && this.hint &&
          this.hint.vehicleId === drag.id && this._now() <= this.hint.until) {
        this._applyHintMove();
        return;
      }
      // 无效移动：弹回，不计步（文档 §2.2 规则 7）→ 鸣笛 + 双闪
      if (Math.abs(drag.offsetPx) > 2) {
        this._honkAndFlash(drag.id);
        this._flashBlocker(drag);
        this.tweens.push({ id: drag.id, axis: drag.axis, from: drag.offsetPx, to: 0, start: this._now(), dur: 120 });
      }
      return;
    }
    const result = this.gm.tryMove(drag.id, delta);
    if (!result.ok) {
      this._honkAndFlash(drag.id);
      this._flashBlocker(drag);
      this.tweens.push({ id: drag.id, axis: drag.axis, from: drag.offsetPx, to: 0, start: this._now(), dur: 120 });
      return;
    }
    this.audio.play("move");
    this.hint = null;
    // 吸附动画：视觉从旧位置（含拖动余量）滑到新格子位置
    const fromPx = drag.offsetPx - delta * this.cell;
    if (result.win) {
      // 出库动画：栏杆抬起 → 滑出棋盘后弹出结算
      this.gateOpenedAt = this._now();
      this.gm.beginAnimating();
      const v = this.gm.board.getVehicle(drag.id);
      const exitPx = (this.gm.board.cols - v.x) * this.cell; // 滑到完全出界
      this.tweens.push({
        id: drag.id, axis: drag.axis, from: fromPx, to: exitPx,
        start: this._now(), dur: 320,
        onDone: () => {
          this.overlay = "win";
          this.starAnim = this._now();
          this.gm.endAnimating(); // ANIMATING → WIN（文档 §3.3）
        },
      });
    } else {
      this.gm.beginAnimating();
      this.tweens.push({
        id: drag.id, axis: drag.axis, from: fromPx, to: 0,
        start: this._now(), dur: 130,
        onDone: () => this._afterSnap(),
      });
    }
  }

  /**
   * 普通移动吸附动画结束：交还状态（ANIMATING → PLAYING）；
   * 若这一步耗尽了步数上限（GameManager 已置 pendingFail）→ 弹出失败弹层。
   */
  _afterSnap() {
    this.gm.endAnimating();
    if (this.gm.state === GameState.FAIL) this._showFail();
  }

  /** 失败呈现：弹层 + 下行音效 + 重震动 */
  _showFail() {
    this.overlay = "fail";
    this.audio.play("fail");
    if (typeof wx !== "undefined" && wx.vibrateShort) {
      try { wx.vibrateShort({ type: "heavy" }); } catch (e) { /* ignore */ }
    }
  }

  /** 重开本关（底部按钮 / 失败弹层共用）：清全部对局内瞬态 */
  _doRestart() {
    this.replay = null;
    this.gm.restart();
    this.hint = null;
    this.hintPending = false;
    this.tweens = [];
    this.overlay = null;
    this.flashes = [];
    this.gateOpenedAt = 0;
    this._hintFreeUsed = 0;
    this._hintUnlimited = false;
  }

  _now() {
    return Date.now();
  }

  /**
   * 碰撞/无效操作反馈：按车型鸣笛 + 车辆双闪 0.9s + 轻震动。
   * 双闪由 _renderVehicles 中的闪烁琥珀色转向灯呈现。
   */
  _honkAndFlash(id) {
    const v = this.gm.board.getVehicle(id);
    if (!v) return;
    const kind = VehicleRenderer.vehicleKind(v, id === this.gm.board.targetId);
    this.audio.play("horn", kind);
    this._pushFlash(id);
    if (typeof wx !== "undefined" && wx.vibrateShort) {
      try { wx.vibrateShort({ type: "light" }); } catch (e) { /* ignore */ }
    }
  }

  _pushFlash(id) {
    this.flashes = this.flashes.filter((f) => f.id !== id);
    this.flashes.push({ id, until: this._now() + 900 });
  }

  /** 拖动被挡时，把阻挡方（相邻车辆）也一起双闪 */
  _flashBlocker(drag) {
    const board = this.gm.board;
    const v = board.getVehicle(drag.id);
    if (!v || drag.offsetPx === 0) return;
    const dir = drag.offsetPx > 0 ? 1 : -1;
    // 仅当拖动确实顶到可达范围的边界时才认为是"碰撞"
    const boundPx = (dir > 0 ? drag.hi - drag.startPos : drag.lo - drag.startPos) * this.cell;
    if (Math.abs(drag.offsetPx - boundPx) > 0.5) return;
    const grid = board.getGrid();
    let cellId = null;
    if (drag.axis === "x") {
      const c = dir > 0 ? drag.hi + v.length : drag.lo - 1;
      if (c >= 0 && c < board.cols) cellId = grid[v.y][c];
    } else {
      const r = dir > 0 ? drag.hi + v.length : drag.lo - 1;
      if (r >= 0 && r < board.rows) cellId = grid[r][v.x];
    }
    if (cellId && cellId !== "#" && board.getVehicle(cellId)) this._pushFlash(cellId);
  }

  // ---------------- 场景切换 ----------------
  showMenu() {
    this.scene = SCENE.MENU;
    this.overlay = null;
    this.drag = null;
    this.tweens = [];
    this.particles = [];
    this.replay = null;
    this.audio.stopEngine();
    if (this.ads) this.ads.showBanner();
  }

  showSelect() {
    this.scene = SCENE.SELECT;
    this.overlay = null;
    this.particles = [];
    this.replay = null;
    this.audio.stopEngine();
    if (this.ads) this.ads.showBanner();
  }

  startLevel(index) {
    const level = this.levels.getLevel(index);
    if (!level) return;
    this.currentLevelIndex = index;
    this.scene = SCENE.GAME;
    this.overlay = null;
    this.drag = null;
    this.tweens = [];
    this.hint = null;
    this.hintPending = false;
    this.winInfo = null;
    this.replay = null;
    this._hintFreeUsed = 0;      // 新一局：免费提示配额重置
    this._hintUnlimited = false;
    this.winCoins = 0;
    this.winCoinsDoubled = false;
    if (this.ads) this.ads.hideBanner(); // 对局中不展示 Banner
    this.particles = [];
    this.flashes = [];
    this.gateOpenedAt = 0;
    this.isNewRecord = false;
    // 棋盘尺寸随关卡变化（后期关卡停车场更大），重新布局
    this.gridCols = level.cols || 6;
    this.gridRows = level.rows || 6;
    this.theme = themes.chapterOf(index);
    this.mood = { state: null, since: 0 };
    // 章节过场卡片：每个章节首次进入时展示（存档持久化）；
    // 展示期间作为 overlay 挡住对局输入（此时状态为 READY，计时未开始，不吃时间）
    this.chapterCard = null;
    if (this.save.markChapterSeen(this.theme.key)) {
      this.chapterCard = { theme: this.theme, idx: Math.floor(index / 6) + 1, start: this._now() };
      this.overlay = "chapter";
    }
    this._computeBoardLayout();
    this.audio.stopEngine();
    this.gm.loadLevel(level);
    this.analytics.setLevel(level.id);
    this.analytics.track("level_start", { levelId: level.id, from: "select" });
  }

  // ---------------- 主循环 ----------------
  _loop() {
    this.gm.tick();
    this._pumpHintSearch();
    this._pumpReplay();
    this._updateTweens();
    this._render();
    requestAnimationFrame(this._loop);
  }

  _updateTweens() {
    const now = this._now();
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const t = this.tweens[i];
      if (now - t.start >= t.dur) {
        this.tweens.splice(i, 1);
        if (t.onDone) t.onDone();
      }
    }
  }

  _tweenOffset(id) {
    for (const t of this.tweens) {
      if (t.id !== id) continue;
      const p = Math.min(1, (this._now() - t.start) / t.dur);
      const ease = 1 - Math.pow(1 - p, 3);
      return { axis: t.axis, px: t.from + (t.to - t.from) * ease };
    }
    return null;
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.scene === SCENE.MENU) {
      themes.drawMenuScene(ctx, this.W, this.H, this._now());
    } else {
      const th = this.scene === SCENE.GAME && this.theme ? this.theme : null;
      if (th && th.drawBackground) {
        // 全屏主题场景（天空/墙面/远景/道具，带轻量动画）
        ctx.save();
        th.drawBackground(ctx, {
          W: this.W, H: this.H, safeTop: this.safeTop,
          bx: this.boardX, by: this.boardY, bw: this.boardW, bh: this.boardH,
          cell: this.cell, li: this.currentLevelIndex,
        }, this._now());
        ctx.restore();
        // HUD 可读性遮罩：顶部/底部淡黑渐变（明亮主题必需，暗色主题无感）
        const topScrim = ctx.createLinearGradient(0, 0, 0, this.safeTop + 100);
        topScrim.addColorStop(0, "rgba(9,13,19,0.55)");
        topScrim.addColorStop(1, "rgba(9,13,19,0)");
        ctx.fillStyle = topScrim;
        ctx.fillRect(0, 0, this.W, this.safeTop + 100);
        const botScrim = ctx.createLinearGradient(0, this.H - 140, 0, this.H);
        botScrim.addColorStop(0, "rgba(9,13,19,0)");
        botScrim.addColorStop(1, "rgba(9,13,19,0.5)");
        ctx.fillStyle = botScrim;
        ctx.fillRect(0, this.H - 140, this.W, 140);
      } else if (th) {
        const g = ctx.createLinearGradient(0, 0, 0, this.H);
        g.addColorStop(0, th.pageBg[0]);
        g.addColorStop(1, th.pageBg[1]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, this.W, this.H);
      } else {
        ctx.fillStyle = THEME.bg;
        ctx.fillRect(0, 0, this.W, this.H);
      }
    }
    this.buttons = [];

    if (this.scene === SCENE.MENU) this._renderMenu(ctx);
    else if (this.scene === SCENE.SELECT) this._renderSelect(ctx);
    else this._renderGame(ctx);
  }

  // ---------------- 通用控件 ----------------
  _button(ctx, x, y, w, h, label, action, opts) {
    opts = opts || {};
    const r = opts.radius != null ? opts.radius : Math.min(h / 2, 18);
    const bg = opts.bg || THEME.buttonBg;
    // 卡通 3D：底部暗边厚度
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    roundRect(ctx, x, y + 3, w, h, r);
    ctx.fill();
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    // 顶部高光
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    roundRect(ctx, x + 3, y + 2, w - 6, h * 0.42, Math.max(4, r * 0.7));
    ctx.fill();
    ctx.restore();
    if (opts.border) {
      ctx.strokeStyle = opts.border;
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, w, h, r);
      ctx.stroke();
    }
    ctx.fillStyle = opts.color || THEME.buttonText;
    ctx.font = `700 ${opts.fontSize || 17}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    this.buttons.push({ x, y, w, h, action });
  }

  _text(ctx, str, x, y, opts) {
    opts = opts || {};
    ctx.fillStyle = opts.color || THEME.text;
    ctx.font = `${opts.weight || 500} ${opts.size || 16}px sans-serif`;
    ctx.textAlign = opts.align || "left";
    ctx.textBaseline = opts.baseline || "alphabetic";
    ctx.fillText(str, x, y);
  }

  // ---------------- 主菜单 ----------------
  _renderMenu(ctx) {
    const cx = this.W / 2;
    const now = this._now();
    const bob = Math.sin(now / 600) * 3;

    // 标题气泡底板（衬托浅色天空下的标题）
    const tw = Math.min(300, this.W - 40);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    roundRect(ctx, cx - tw / 2, this.H * 0.31 + bob * 0.3, tw, 120, 26);
    ctx.fill();

    // 主标题 + 副标题
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.font = `900 ${Math.min(46, this.W * 0.115)}px sans-serif`;
    ctx.strokeText("堵车大作战", cx, this.H * 0.36 + bob * 0.3);
    ctx.fillStyle = "#e8402a";
    ctx.fillText("堵车大作战", cx, this.H * 0.36 + bob * 0.3);

    ctx.font = "800 17px sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText("（又称：统统闪开）", cx, this.H * 0.36 + 38 + bob * 0.3);
    ctx.fillStyle = "#2f6fb5";
    ctx.fillText("（又称：统统闪开）", cx, this.H * 0.36 + 38 + bob * 0.3);

    const btnW = Math.min(260, this.W - 80);
    const bx = cx - btnW / 2;
    const totalStars = this.save.totalStars();
    ctx.font = "700 15px sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.strokeText(`★ ${totalStars} / ${this.levels.count * 3}`, cx, this.H * 0.52);
    ctx.fillStyle = "#e08a00";
    ctx.fillText(`★ ${totalStars} / ${this.levels.count * 3}`, cx, this.H * 0.52);

    // 金币余额（通关奖励积累，后续可接皮肤/道具）
    const coins = this.save.data.coins || 0;
    if (coins > 0) {
      ctx.font = "700 13px sans-serif";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.strokeText(`🪙 ${coins}`, cx, this.H * 0.548);
      ctx.fillStyle = "#b07a00";
      ctx.fillText(`🪙 ${coins}`, cx, this.H * 0.548);
    }

    this._button(ctx, bx, this.H * 0.575, btnW, 54, "▶ 开始游戏", () => {
      const idx = Math.min(this.save.data.unlockedLevel, this.levels.count - 1);
      this.startLevel(idx);
      this.analytics.gameStart(this.levels.getLevel(idx).id);
    }, { bg: "#f5a623", color: "#3a2600", fontSize: 20 });

    this._button(ctx, bx, this.H * 0.575 + 70, (btnW - 10) / 2, 52, "选择关卡", () => this.showSelect(), { bg: "#4a90d9", fontSize: 16 });
    this._button(ctx, bx + (btnW + 10) / 2, this.H * 0.575 + 70, (btnW - 10) / 2, 52, "🛒 商店", () => { this.overlay = "shop"; }, { bg: "#7ed321", color: "#22330c", fontSize: 16 });
    this._soundToggle(ctx, this.W - 54, this.safeTop + 14);
    this._bgmToggle(ctx, this.W - 102, this.safeTop + 14);

    ctx.font = "600 12px sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    // Banner 展示时底部文案上移避让（bannerVisible 由 AdManager 维护）
    const tipY = this.H - ((this.ads && this.ads.bannerVisible) ? 170 : 104);
    ctx.strokeText("拖动车辆 · 红色目标车从右侧出口驶出", cx, tipY);
    ctx.fillStyle = "#3a4a5a";
    ctx.fillText("拖动车辆 · 红色目标车从右侧出口驶出", cx, tipY);

    // 商店弹层（菜单场景）
    if (this.overlay === "shop") this._renderShopOverlay(ctx);
  }

  // ---------------- 选关 ----------------
  _renderSelect(ctx) {
    this._text(ctx, "选择关卡", this.W / 2, this.safeTop + 44, { size: 24, weight: 700, align: "center" });
    this._button(ctx, 14, this.safeTop + 18, 64, 36, "← 返回", () => this.showMenu(), { fontSize: 14 });

    // 章节图例：驾校 → 小区 → 商场 → 医院 → 机场
    const lw = (this.W - 40) / themes.CHAPTERS.length;
    for (let i = 0; i < themes.CHAPTERS.length; i++) {
      const ch = themes.CHAPTERS[i];
      const lx = 20 + i * lw;
      ctx.fillStyle = ch.accent;
      ctx.globalAlpha = 0.9;
      roundRect(ctx, lx, this.safeTop + 62, lw - 6, 20, 10);
      ctx.fill();
      ctx.globalAlpha = 1;
      this._text(ctx, `${ch.icon}${ch.name}`, lx + (lw - 6) / 2, this.safeTop + 76, { size: 10, weight: 700, align: "center", color: "#141a24" });
    }

    const cols = 6; // 每行 6 关 = 一个章节
    const pad = 8;
    const gridW = this.W - 40;
    const size = (gridW - pad * (cols - 1)) / cols;
    const x0 = 20;
    const y0 = this.safeTop + 96;
    for (let i = 0; i < this.levels.count; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const x = x0 + c * (size + pad), y = y0 + r * (size + pad * 1.5);
      const unlocked = this.save.isUnlocked(i);
      const stars = this.save.getStars(this.levels.getLevel(i).id);
      const ch = themes.chapterOf(i);
      ctx.fillStyle = unlocked ? ch.tile : THEME.panel;
      roundRect(ctx, x, y, size, size, 10);
      ctx.fill();
      if (unlocked) {
        ctx.strokeStyle = ch.accent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x + 1, y + 1, size - 2, size - 2, 9);
        ctx.stroke();
        ctx.globalAlpha = 1;
        this._text(ctx, String(i + 1), x + size / 2, y + size / 2 - 4, { size: 19, weight: 700, align: "center", color: THEME.text });
        if (stars > 0) {
          this._text(ctx, "★".repeat(stars) + "☆".repeat(3 - stars), x + size / 2, y + size - 12, { size: 9, align: "center", color: THEME.gold });
        }
        this.buttons.push({
          x, y, w: size, h: size,
          action: () => { this.startLevel(i); this.analytics.gameStart(this.levels.getLevel(i).id); },
        });
      } else {
        this._text(ctx, "🔒", x + size / 2, y + size / 2 + 6, { size: 16, align: "center" });
      }
    }
  }

  // ---------------- 对局 ----------------
  _renderGame(ctx) {
    const level = this.gm.levelData;
    if (!level) return;

    // 顶栏：返回 / 关卡 / 步数
    const topY = this.safeTop + 14;
    this._button(ctx, 14, topY, 56, 34, "←", () => {
      if (this.gm.state === GameState.PLAYING) { this.gm.pause(); }
      this.showSelect();
    }, { fontSize: 16, radius: 10 });
    this._text(ctx, `第 ${this.currentLevelIndex + 1} 关 · ${level.title}`, this.W / 2, topY + 16, { size: 17, weight: 700, align: "center" });
    const timeStr = this._formatTime(this.gm.elapsedMs);
    // 步数 HUD：有步数上限时显示 X/上限（剩余 ≤3 步转警示红并加粗），教学关无上限回落 parMoves
    const limit = this.gm.moveLimit;
    const movesLabel = limit > 0 ? `${this.gm.moves}/${limit}` : `${this.gm.moves} / ${level.parMoves}`;
    const lowMoves = limit > 0 && (limit - this.gm.moves) <= 3;
    this._text(ctx, `步数 ${movesLabel}     ⏱ ${timeStr}`, this.W / 2, topY + 40, {
      size: 13, weight: lowMoves ? 700 : 500,
      color: lowMoves ? "#ff6b5e" : THEME.textSub, align: "center",
    });

    // 章节主题徽章（驾校/小区/商场/医院/机场）
    const th = this.theme;
    if (th) {
      const label = `${th.icon} ${th.name}`;
      ctx.font = "700 11px sans-serif";
      const cw = ctx.measureText(label).width + 20;
      ctx.fillStyle = th.accent;
      ctx.globalAlpha = 0.9;
      roundRect(ctx, this.W / 2 - cw / 2, topY + 52, cw, 18, 9);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#141a24";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, this.W / 2, topY + 62);
    }

    // 底部操作区 Y（先算好：主题装饰要避开按钮区）
    const barY = this.boardY + this.boardH + Math.max(16, (this.H - this.boardY - this.boardH - 84) / 2);
    this.barY = barY;

    this._renderBoard(ctx, level);
    this._renderVehicles(ctx, level);
    this._renderMoodBubble(ctx, level);
    this._renderHint(ctx);
    this._renderHintPending(ctx);
    this._renderTutorial(ctx);
    this._soundToggle(ctx, this.W - 54, topY);
    this._bgmToggle(ctx, this.W - 102, topY);

    // 底部操作区：撤销 / 重开 / 提示 / 暂停（弹层打开或回放中禁用）
    const bw = Math.min(76, (this.W - 40) / 4 - 8);
    const gap = (this.W - 20 * 2 - bw * 4) / 3;
    const defs = [
      ["撤销", () => { if (this.gm.undo()) this.audio.play("undo"); }],
      ["重开", () => this._doRestart()],
      [this.hintPending ? "计算…" : "提示", () => this._useHint()],
      ["暂停", () => { if (this.gm.pause()) this.overlay = "pause"; }],
    ];
    for (let i = 0; i < defs.length; i++) {
      const x = 20 + i * (bw + gap);
      const disabled = !!this.overlay || !!this.replay;
      this._button(ctx, x, barY, bw, 48, defs[i][0], disabled ? () => {} : defs[i][1], {
        fontSize: 15, radius: 12,
        color: disabled ? THEME.textSub : THEME.buttonText,
      });
    }

    if (this.overlay === "win") this._renderWinOverlay(ctx);
    else if (this.overlay === "fail") this._renderFailOverlay(ctx);
    else if (this.overlay === "pause") this._renderPauseOverlay(ctx);
    else if (this.overlay === "adHint") this._renderAdHintOverlay(ctx);
    else if (this.overlay === "chapter" && this.chapterCard) this._renderChapterCard(ctx);
    if (this.replay) this._renderReplayBanner(ctx);
  }

  // ---------------- 目标车情绪气泡（趣味反馈） ----------------
  // 😤 完全堵死（无任何合法移动）；😄 出口通路已打开（可直接出库）。
  _renderMoodBubble(ctx, level) {
    if (this.overlay) return;               // 弹层/章节卡片期间不显示
    if (this.gm.state !== GameState.PLAYING && this.gm.state !== GameState.READY) return;
    const board = this.gm.board;
    if (!board) return;
    const t = board.getVehicle(level.targetVehicleId);
    if (!t) return;

    // 判定情绪：能直接出库 → happy；一格都动不了 → angry；否则不显示
    let mood = null;
    const exitDelta = (level.cols || board.cols) - t.x; // 直接出库所需位移
    if (board.canMove(t.id, exitDelta)) mood = "happy";
    else {
      const range = board.getMovableRange(t.id);
      if (range && range.lo === range.hi) mood = "angry";
    }
    const now = this._now();
    if (mood !== this.mood.state) this.mood = { state: mood, since: now };
    if (!mood) return;

    // 淡入 + 浮动
    const age = now - this.mood.since;
    if (age < 180) return;                   // 状态切换后短暂延迟再冒泡
    const appear = Math.min(1, (age - 180) / 220);
    const { boardX: bx, boardY: by, cell } = this;
    // 气泡贴在目标车车头（右侧）上方
    const carPx = bx + t.x * cell + (this._tweenOffset(t.id) ? this._tweenOffset(t.id).px : 0);
    const cx = carPx + t.length * cell * 0.82;
    const floatY = Math.sin(now / 380) * 2.5;
    const cy = by + t.y * cell - cell * 0.18 + floatY - (1 - appear) * 8;
    const r = Math.max(11, cell * 0.26) * (0.6 + 0.4 * appear);
    ctx.save();
    ctx.globalAlpha = appear;
    themes.drawFaceBubble(ctx, cx, cy, r, mood, now);
    ctx.restore();
  }

  // ---------------- 章节过场卡片 ----------------
  _renderChapterCard(ctx) {
    const card = this.chapterCard;
    const th = card.theme;
    const now = this._now();
    const age = now - card.start;
    const DUR = 2600;
    if (age > DUR) { this.chapterCard = null; this.overlay = null; return; }

    // 进出场缓动
    const inP = Math.min(1, age / 320);
    const outP = age > DUR - 380 ? (age - (DUR - 380)) / 380 : 0;
    const easeIn = 1 - Math.pow(1 - inP, 3);
    const alpha = Math.min(easeIn, 1 - outP);
    const scale = 0.86 + 0.14 * easeIn - outP * 0.1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    // 半透明遮罩
    ctx.fillStyle = "rgba(10,14,20,0.55)";
    ctx.fillRect(0, 0, this.W, this.H);
    // 吸收点击：任意处点按跳过
    this.buttons.push({ x: 0, y: 0, w: this.W, h: this.H, action: () => { this.chapterCard = null; this.overlay = null; } });

    const pw = Math.min(300, this.W - 56), ph = 200;
    const px = (this.W - pw) / 2, py = (this.H - ph) / 2 - 30;
    const ccx = px + pw / 2;
    ctx.translate(ccx, py + ph / 2);
    ctx.scale(scale, scale);
    ctx.translate(-ccx, -(py + ph / 2));

    // 卡片底（主题色渐变）
    const g = ctx.createLinearGradient(px, py, px, py + ph);
    g.addColorStop(0, th.pageBg[0]);
    g.addColorStop(1, th.pageBg[1]);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    roundRect(ctx, px + 2, py + 6, pw, ph, 24); ctx.fill();
    ctx.fillStyle = g;
    roundRect(ctx, px, py, pw, ph, 24); ctx.fill();
    ctx.strokeStyle = th.accent;
    ctx.lineWidth = 3;
    roundRect(ctx, px + 1.5, py + 1.5, pw - 3, ph - 3, 23); ctx.stroke();

    // 大图标
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "54px sans-serif";
    ctx.fillText(th.icon, ccx, py + 58);
    // 明亮主题卡片底色浅 → 文字改用深色保证可读
    const light = !!th.light;
    const mainC = light ? "#2c3547" : "#f2f5fa";
    const subC = light ? "rgba(44,53,71,0.72)" : "rgba(242,245,250,0.72)";
    const hintC = light ? "rgba(44,53,71,0.5)" : "rgba(242,245,250,0.5)";
    // 章节序号
    ctx.fillStyle = (light && th.accentDark) || th.accent;
    ctx.font = "800 14px sans-serif";
    ctx.fillText(`第 ${card.idx} 章 · 关卡 ${th.range}`, ccx, py + 100);
    // 主题名
    ctx.fillStyle = mainC;
    ctx.font = "900 30px sans-serif";
    ctx.fillText(`${th.name}停车场`, ccx, py + 132);
    // 标语
    ctx.fillStyle = subC;
    ctx.font = "500 14px sans-serif";
    ctx.fillText(th.tagline, ccx, py + 162);
    // 点按继续
    ctx.fillStyle = hintC;
    ctx.font = "500 12px sans-serif";
    ctx.fillText(age > 700 ? "点按继续" : "", ccx, py + 184);
    ctx.restore();
  }

  _formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  _renderBoard(ctx, level) {
    const { boardX: bx, boardY: by, boardW: bw, boardH: bh, cell } = this;
    const cols = level.cols || 6, rows = level.rows || 6;
    const now = this._now();
    const th = this.theme || {};
    const ground = th.ground || ["#343b45", "#252b33"];

    // 路缘石 + 主题地面
    ctx.fillStyle = th.curb || "#171b21";
    roundRect(ctx, bx - 11, by - 11, bw + 22, bh + 22, 16);
    ctx.fill();
    ctx.fillStyle = th.rim || "rgba(247,201,72,0.16)";
    roundRect(ctx, bx - 9, by - 9, bw + 18, bh + 18, 14);
    ctx.fill();
    const asphalt = ctx.createLinearGradient(0, by, 0, by + bh);
    asphalt.addColorStop(0, ground[0]);
    asphalt.addColorStop(1, ground[1]);
    ctx.fillStyle = asphalt;
    roundRect(ctx, bx - 5, by - 5, bw + 10, bh + 10, 11);
    ctx.fill();

    // 车位：底色 + 车位线
    const tint = th.cellTint || ["rgba(255,255,255,0.030)", "rgba(255,255,255,0.012)"];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = bx + c * cell, y = by + r * cell;
        ctx.fillStyle = (r + c) % 2 === 0 ? tint[0] : tint[1];
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        ctx.strokeStyle = th.line || "rgba(255,255,255,0.13)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
      }
    }

    // 主题棋盘细节（如机场滑行道黄色虚线内框）
    if (th.boardDeco) {
      ctx.save();
      th.boardDeco(ctx, bx, by, bw, bh, cell);
      ctx.restore();
    }

    // 禁停区：黄黑斜纹警示块 + 红圈禁行标志
    const obstacles = (this.gm.board && this.gm.board.obstacles) || [];
    for (const ob of obstacles) {
      const x = bx + ob[0] * cell, y = by + ob[1] * cell;
      ctx.save();
      roundRect(ctx, x + 3, y + 3, cell - 6, cell - 6, 6);
      ctx.clip();
      ctx.fillStyle = "#3a3f47";
      ctx.fillRect(x, y, cell, cell);
      ctx.strokeStyle = "rgba(247,201,72,0.5)";
      ctx.lineWidth = 5;
      for (let i = -cell; i < cell * 2; i += 13) {
        ctx.beginPath();
        ctx.moveTo(x + i, y + cell);
        ctx.lineTo(x + i + cell, y);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1.5;
      roundRect(ctx, x + 3, y + 3, cell - 6, cell - 6, 6);
      ctx.stroke();
      const ccx = x + cell / 2, ccy = y + cell / 2, rr = cell * 0.21;
      ctx.fillStyle = "rgba(18,22,28,0.88)";
      ctx.beginPath(); ctx.arc(ccx, ccy, rr + 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#e05252";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ccx, ccy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ccx - rr * 0.68, ccy + rr * 0.68);
      ctx.lineTo(ccx + rr * 0.68, ccy - rr * 0.68);
      ctx.stroke();
    }

    // 出口通道：绿色渐晕 + 流动箭头（动画）
    const ey = by + level.exit.row * cell;
    const lane = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    lane.addColorStop(0, "rgba(89,195,107,0)");
    lane.addColorStop(1, "rgba(89,195,107,0.22)");
    ctx.fillStyle = lane;
    ctx.fillRect(bx, ey + 1, bw, cell - 2);
    const flow = (now / 600) % 1;
    ctx.lineWidth = 2.5;
    for (let i = 0; i < 3; i++) {
      const t = (flow + i / 3) % 1;
      const ax = bx + bw * (0.5 + t * 0.5);
      const alpha = 0.12 + 0.4 * (1 - Math.abs(t - 0.5) * 2);
      ctx.strokeStyle = `rgba(89,195,107,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(ax - 7, ey + cell * 0.3);
      ctx.lineTo(ax + 1, ey + cell / 2);
      ctx.lineTo(ax - 7, ey + cell * 0.7);
      ctx.stroke();
    }
    // 出口绿色边缘 + 外侧大箭头
    ctx.fillStyle = THEME.exit;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(bx + bw - 4, ey + cell * 0.18, 8, cell * 0.64);
    ctx.beginPath();
    ctx.moveTo(bx + bw + 8, ey + cell * 0.1);
    ctx.lineTo(bx + bw + 24, ey + cell / 2);
    ctx.lineTo(bx + bw + 8, ey + cell * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // 出口栏杆：立柱 + 红白条纹杆；目标车出库时抬杆
    const gateX = bx + bw + 6;
    ctx.fillStyle = "#8d99ae";
    ctx.fillRect(gateX - 2, ey + cell * 0.06, 5, cell * 0.2);   // 上立柱
    ctx.fillRect(gateX - 2, ey + cell * 0.74, 5, cell * 0.2);   // 下立柱
    const openP = this.gateOpenedAt ? Math.min(1, (now - this.gateOpenedAt) / 350) : 0;
    const eased = 1 - Math.pow(1 - openP, 3);
    ctx.save();
    ctx.translate(gateX, ey + cell * 0.16);
    ctx.rotate(eased * 1.15); // 顺时针抬起（杆在支点左侧，端部上扬）
    const armLen = cell * 0.9;
    for (let s = 0; s < 5; s++) {
      ctx.fillStyle = s % 2 === 0 ? "#e05252" : "#f2f5fa";
      ctx.fillRect(-armLen + s * (armLen / 5), -2, armLen / 5, 4);
    }
    ctx.restore();
  }

  _renderVehicles(ctx, level) {
    const { boardX: bx, boardY: by, cell } = this;
    // 当前装备的涂装皮肤（金币商店购买）：替换车身色板与目标车色；
    // VehicleRenderer 精灵缓存 key 含颜色，换肤自动重渲染、无需清缓存。
    const skin = skins.byId(this.save.data.equippedSkin);
    const palette = skin.cars;
    let colorIdx = 0;

    ctx.save();
    // 裁剪到棋盘+出口区域，出库车辆滑出时自然消失
    ctx.beginPath();
    ctx.rect(bx - 8, by - 8, this.boardW + 90, this.boardH + 16);
    ctx.clip();

    for (const v of this.gm.board.vehicles) {
      const isTarget = v.id === level.targetVehicleId;
      const color = isTarget ? skin.target : palette[colorIdx++ % palette.length];
      let px = bx + v.x * cell;
      let py = by + v.y * cell;

      // 拖动偏移 / 吸附动画偏移
      if (this.drag && this.drag.id === v.id) {
        if (this.drag.axis === "x") px += this.drag.offsetPx;
        else py += this.drag.offsetPx;
      } else {
        const tw = this._tweenOffset(v.id);
        if (tw) {
          if (tw.axis === "x") px += tw.px;
          else py += tw.px;
        }
      }

      const w = v.orientation === "H" ? v.length * cell : cell;
      const h = v.orientation === "H" ? cell : v.length * cell;
      const isActive = (this.drag && this.drag.id === v.id) ||
        (this.hint && this.hint.vehicleId === v.id);

      // 阴影（拖动时抬高）
      const lift = this.drag && this.drag.id === v.id ? 3 : 0;
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      roundRect(ctx, px + 3, py + 4 + lift, w, h, 9);
      ctx.fill();

      // 精灵图（程序化预渲染）；Node 等无离屏 canvas 环境降级为矢量色块
      const kind = VehicleRenderer.vehicleKind(v, isTarget);
      const sprite = VehicleRenderer.getSprite(kind, color, v.orientation, v.length, cell);
      if (sprite) {
        ctx.drawImage(sprite, px, py - lift, w, h);
      } else {
        this._drawVectorCar(ctx, v, color, px, py - lift, w, h);
      }

      // 目标车标识：白色描边 + 箭头
      if (isTarget) {
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        roundRect(ctx, px + 2, py + 2 - lift, w - 4, h - 4, 9);
        ctx.stroke();
        const acx = px + w / 2, acy = py + h / 2 - lift;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(acx + 13, acy);
        ctx.lineTo(acx - 3, acy - 8);
        ctx.lineTo(acx - 3, acy + 8);
        ctx.closePath();
        ctx.fill();
      }
      if (isActive && !isTarget) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1.5;
        roundRect(ctx, px + 2, py + 2 - lift, w - 4, h - 4, 9);
        ctx.stroke();
      }

      // 双闪（碰撞 / 无效拖动反馈）：四角琥珀灯闪烁 + 橙色描边
      if (this._flashActive(v.id) && Math.floor(this._now() / 140) % 2 === 0) {
        const ly = py - lift;
        const lr = Math.max(2.5, cell * 0.08);
        ctx.fillStyle = "#ffb020";
        const corners = [[px + 4, ly + 4], [px + w - 4, ly + 4], [px + 4, ly + h - 4], [px + w - 4, ly + h - 4]];
        for (const [lx, lyy] of corners) {
          ctx.beginPath();
          ctx.arc(lx, lyy, lr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = "rgba(255,176,32,0.55)";
        ctx.lineWidth = 2;
        roundRect(ctx, px + 1, ly + 1, w - 2, h - 2, 9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 双闪是否处于激活期（顺带清理过期项） */
  _flashActive(id) {
    const now = this._now();
    this.flashes = this.flashes.filter((f) => f.until > now);
    return this.flashes.some((f) => f.id === id);
  }

  /** 矢量色块降级绘制（Node 测试 / 不支持离屏 canvas 时） */
  _drawVectorCar(ctx, v, color, px, py, w, h) {
    const pad = 4;
    const x = px + pad, y = py + pad;
    const bw = w - pad * 2, bh = h - pad * 2;
    ctx.fillStyle = color;
    roundRect(ctx, x, y, bw, bh, 9);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    if (v.orientation === "H") roundRect(ctx, x + bw * 0.28, y + bh * 0.18, bw * 0.44, bh * 0.64, 5);
    else roundRect(ctx, x + bw * 0.18, y + bh * 0.28, bw * 0.64, bh * 0.44, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(20,30,45,0.5)";
    if (v.orientation === "H") {
      ctx.fillRect(x + 4, y + bh * 0.22, 5, bh * 0.56);
      ctx.fillRect(x + bw - 9, y + bh * 0.22, 5, bh * 0.56);
    } else {
      ctx.fillRect(x + bw * 0.22, y + 4, bw * 0.56, 5);
      ctx.fillRect(x + bw * 0.22, y + bh - 9, bw * 0.56, 5);
    }
  }

  _useHint() {
    if (this.hintPending) return; // 后台搜索中：等 _pumpHintSearch 交付，避免重复触发
    if (this._hintGateActive()) { this.overlay = "adHint"; return; } // 免费配额用尽 → 看视频解锁弹层
    const move = this.gm.getHint();
    if (!move) {
      // 深度乱局：GameManager 已启动后台分帧搜索（从当前局面续算，不冻结界面），
      // 显示"计算中"转圈，每帧推进 ~12ms，出结果自动高亮提示
      if (this.gm.hintComputing) this.hintPending = true;
      return;
    }
    this._showHint(move);
  }

  /**
   * 提示配额闸门：仅当「激励视频真实可用」且本关免费次数用尽且未解锁时生效。
   * 广告不可用（未开通流量主/审核期/失败降级/Node 测试）→ 永远返回 false，提示全程免费。
   */
  _hintGateActive() {
    return !!(this.ads && this.ads.isRewardedAvailable() &&
      !this._hintUnlimited && this._hintFreeUsed >= HINT_FREE_PER_LEVEL);
  }

  /** 每帧推进后台提示搜索；完成即高亮提示，被取消（玩家挪车）即收起转圈 */
  _pumpHintSearch() {
    if (!this.hintPending) return;
    if (this.scene !== SCENE.GAME) { this.hintPending = false; return; } // 已离开对局：收起（重进关卡会重置搜索）
    const move = this.gm.pumpHint(12);
    if (move) {
      this.hintPending = false;
      this._showHint(move);
    } else if (!this.gm.hintComputing) {
      this.hintPending = false; // 搜索被取消（tryMove/undo/重开）或无结果
    }
  }

  _showHint(move) {
    this.audio.play("hint");
    this._hintFreeUsed++; // 交付一次计一次（未解锁 unlimited 时用于配额闸门）
    // delta = 精确格数：渲染目标虚线框 + 支持"轻点车辆自动就位"
    this.hint = {
      vehicleId: move.vehicleId,
      delta: move.delta,
      dir: Math.sign(move.delta),
      axis: this._vehicleAxis(move.vehicleId),
      until: this._now() + 6000,
    };
  }

  /**
   * 轻点提示高亮的车辆 = 自动精确执行提示移动（免手拖估距离）。
   * 与拖动提交走完全相同的 tryMove + 动画 + 胜利流程。
   */
  _applyHintMove() {
    const h = this.hint;
    this.hint = null;
    if (!this.gm.board.canMove(h.vehicleId, h.delta)) { this.audio.play("invalid"); return; }
    const result = this.gm.tryMove(h.vehicleId, h.delta);
    if (!result.ok) { this.audio.play("invalid"); return; }
    this.audio.play("move");
    const fromPx = -h.delta * this.cell; // 视觉：从旧格子滑到新格子
    if (result.win) {
      this.gateOpenedAt = this._now();
      this.gm.beginAnimating();
      const v = this.gm.board.getVehicle(h.vehicleId);
      const exitPx = (this.gm.board.cols - v.x) * this.cell;
      this.tweens.push({
        id: h.vehicleId, axis: h.axis, from: fromPx, to: exitPx,
        start: this._now(), dur: 320,
        onDone: () => {
          this.overlay = "win";
          this.starAnim = this._now();
          this.gm.endAnimating();
        },
      });
    } else {
      this.gm.beginAnimating();
      this.tweens.push({
        id: h.vehicleId, axis: h.axis, from: fromPx, to: 0,
        start: this._now(), dur: 160,
        onDone: () => this._afterSnap(),
      });
    }
  }

  _vehicleAxis(id) {
    const v = this.gm.board.getVehicle(id);
    return v && v.orientation === "H" ? "x" : "y";
  }

  /** 后台搜索进行中：棋盘中央"正在规划最佳路线…"转圈提示（不阻塞操作） */
  _renderHintPending(ctx) {
    if (!this.hintPending) return;
    const cx = this.boardX + this.boardW / 2;
    const cy = this.boardY + this.boardH / 2;
    ctx.save();
    ctx.fillStyle = "rgba(10,14,20,0.55)";
    roundRect(ctx, cx - 96, cy - 21, 192, 42, 21);
    ctx.fill();
    // 旋转圆弧（spinner）
    const a0 = (this._now() / 280) % (Math.PI * 2);
    ctx.strokeStyle = "rgba(247,201,72,0.95)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx - 70, cy, 9, a0, a0 + Math.PI * 1.4);
    ctx.stroke();
    ctx.fillStyle = "#f7c948";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("正在规划最佳路线…", cx - 52, cy + 1);
    ctx.restore();
  }

  _renderHint(ctx) {
    if (!this.hint) return;
    if (this._now() > this.hint.until) { this.hint = null; return; }
    const v = this.gm.board.getVehicle(this.hint.vehicleId);
    if (!v) { this.hint = null; return; }
    const { boardX: bx, boardY: by, cell } = this;
    const pulse = 0.5 + 0.5 * Math.sin(this._now() / 150);
    const w = v.orientation === "H" ? v.length * cell : cell;
    const h = v.orientation === "H" ? cell : v.length * cell;
    const x = bx + v.x * cell, y = by + v.y * cell;

    ctx.strokeStyle = `rgba(247,201,72,${0.5 + pulse * 0.5})`;
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 9);
    ctx.stroke();

    // 目标位置虚线框：把这辆车拖到虚线框（精确格数），或轻点车辆自动就位
    const gx = x + (this.hint.axis === "x" ? this.hint.delta * cell : 0);
    const gy = y + (this.hint.axis === "y" ? this.hint.delta * cell : 0);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -((this._now() / 40) % 11); // 流动虚线
    ctx.strokeStyle = `rgba(247,201,72,${0.55 + pulse * 0.45})`;
    ctx.fillStyle = `rgba(247,201,72,${0.08 + pulse * 0.10})`;
    ctx.lineWidth = 2.5;
    roundRect(ctx, gx + 2, gy + 2, w - 4, h - 4, 9);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 方向箭头
    const cx = x + w / 2, cy = y + h / 2;
    ctx.fillStyle = `rgba(247,201,72,${0.6 + pulse * 0.4})`;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.hint.axis === "x" ? (this.hint.dir > 0 ? 0 : Math.PI) : (this.hint.dir > 0 ? Math.PI / 2 : -Math.PI / 2));
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(4, -10);
    ctx.lineTo(4, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 操作指引（棋盘与底部按钮之间的空隙，随提示临时显示）
    if (this.barY != null) {
      ctx.save();
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = `rgba(247,201,72,${0.7 + pulse * 0.3})`;
      ctx.fillText("拖到虚线框，或轻点这辆车自动就位", this.W / 2, this.barY - 8);
      ctx.restore();
    }
  }

  // ---------------- 顶栏声音开关 ----------------
  _soundToggle(ctx, x, y) {
    const on = this.audio.enabled;
    this._button(ctx, x, y, 40, 34, on ? "🔊" : "🔇", () => {
      this.audio.setEnabled(!on);
      if (!on) this.audio.play("button");
    }, { fontSize: 15, radius: 10 });
  }

  /** 🎵 背景音乐开关（独立于音效 🔊，持久化到存档，由玩家决定开/关） */
  _bgmToggle(ctx, x, y) {
    const on = this.audio.bgmEnabled;
    this._button(ctx, x, y, 44, 34, on ? "🎵开" : "🎵关", () => {
      this.audio.setBgmEnabled(!on);
      this.analytics.track("bgm_toggle", { on: !on });
      if (!on) this.audio.play("button");
    }, { fontSize: 12, radius: 10 });
  }

  // ---------------- 通关彩带粒子 ----------------
  _spawnConfetti() {
    this.particles = [];
    const colors = THEME.cars.concat([THEME.gold, "#ffffff", THEME.target]);
    for (let i = 0; i < 90; i++) {
      this.particles.push({
        x: this.W / 2 + (Math.random() - 0.5) * this.W * 0.5,
        y: this.H * 0.28 + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 260,
        vy: -160 - Math.random() * 260,
        size: 4 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 10,
        color: colors[i % colors.length],
      });
    }
  }

  _updateParticles(dt) {
    for (const p of this.particles) {
      p.vy += 620 * dt; // 重力
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.particles = this.particles.filter((p) => p.y < this.H + 20);
  }

  _renderParticles(ctx) {
    const now = this._now();
    const dt = Math.min(0.05, (now - this._lastFrame) / 1000);
    this._lastFrame = now;
    this._updateParticles(dt);
    for (const p of this.particles) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
  }

  // ---------------- 第 1 关新手引导 ----------------
  _renderTutorial(ctx) {
    if (this.currentLevelIndex !== 0 || this.gm.moves > 0) return;
    if (this.overlay || this.drag || this.tweens.length || this.replay) return;
    const v = this.gm.board.getVehicle(this.gm.board.targetId);
    if (!v) return;
    const { boardX: bx, boardY: by, cell } = this;
    const t = this._now() / 700;
    const s = (Math.sin(t) + 1) / 2; // 0~1 往复
    const carCx = bx + (v.x + v.length / 2) * cell;
    const carCy = by + (v.y + 0.5) * cell;
    const handX = carCx + s * cell * 2.2;

    // 引导文字
    const label = "拖动红色跑车，驶向右侧出口 →";
    ctx.font = "600 14px sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(10,14,20,0.72)";
    roundRect(ctx, this.W / 2 - tw / 2 - 12, by - 34, tw + 24, 26, 13);
    ctx.fill();
    this._text(ctx, label, this.W / 2, by - 16, { size: 14, weight: 600, align: "center" });

    // 往复滑动的引导手势 + 轨迹虚线
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(carCx + 10, carCy);
    ctx.lineTo(carCx + cell * 2.4, carCy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("👆", handX, carCy + 20);
  }

  // ---------------- 弹层 ----------------
  _overlayPanel(ctx, panelH) {
    // 全屏遮罩吸收点击，阻止穿透到底部按钮
    this.buttons.push({ x: 0, y: 0, w: this.W, h: this.H, action: () => {} });
    ctx.fillStyle = "rgba(10,14,20,0.66)";
    ctx.fillRect(0, 0, this.W, this.H);
    const pw = Math.min(320, this.W - 48), ph = panelH || 330;
    const px = (this.W - pw) / 2, py = (this.H - ph) / 2 - 20;
    // 卡通面板：投影 + 主题色描边
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    roundRect(ctx, px + 2, py + 6, pw, ph, 22);
    ctx.fill();
    ctx.fillStyle = THEME.panel;
    roundRect(ctx, px, py, pw, ph, 22);
    ctx.fill();
    ctx.strokeStyle = (this.theme && this.theme.accent) || THEME.accent;
    ctx.lineWidth = 3;
    roundRect(ctx, px + 1.5, py + 1.5, pw - 3, ph - 3, 21);
    ctx.stroke();
    return { px, py, pw, ph };
  }

  _renderWinOverlay(ctx) {
    const info = this.winInfo;
    if (!info) { this.overlay = null; return; }
    this._renderParticles(ctx); // 彩带（在面板之下）
    const { px, py, pw } = this._overlayPanel(ctx, 434);
    const cx = px + pw / 2;
    // 卡通描边标题
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 32px sans-serif";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(20,26,36,0.9)";
    ctx.strokeText("通关！", cx, py + 52);
    ctx.fillStyle = THEME.gold;
    ctx.fillText("通关！", cx, py + 52);

    // 徽章：Perfect（步数=par）/ 新纪录
    const badges = [];
    if (info.moves <= info.parMoves) badges.push(["Perfect!", THEME.gold]);
    if (this.isNewRecord) badges.push(["新纪录", "#59c36b"]);
    badges.forEach(([label, color], i) => {
      const bx2 = cx + (i - (badges.length - 1) / 2) * 92 - 40;
      ctx.fillStyle = color;
      roundRect(ctx, bx2, py + 66, 80, 22, 11);
      ctx.fill();
      this._text(ctx, label, bx2 + 40, py + 81, { size: 12, weight: 700, align: "center", color: "#1d2531" });
    });

    // 星级动画：依次弹出
    const elapsed = this._now() - this.starAnim;
    for (let i = 0; i < 3; i++) {
      const shown = elapsed > 250 * (i + 1);
      const earned = i < info.stars;
      const scale = shown && earned && elapsed < 250 * (i + 1) + 200 ? 1.3 : 1;
      this._text(ctx, earned && shown ? "★" : "☆", cx + (i - 1) * 46, py + 128, {
        size: 36 * scale, align: "center",
        color: earned && shown ? THEME.gold : "#5a6a85",
      });
    }

    this._text(ctx, `步数 ${info.moves}（参考 ${info.parMoves}）`, cx, py + 166, { size: 15, color: THEME.textSub, align: "center" });
    this._text(ctx, `用时 ${this._formatTime(info.timeMs)}${info.hintsUsed ? ` · 提示 ${info.hintsUsed} 次` : ""}`, cx, py + 190, { size: 15, color: THEME.textSub, align: "center" });

    // 金币奖励行：星数×10；激励视频可用且未翻倍时展示「📺 金币 ×2」
    const canDouble = !!(this.ads && this.ads.isRewardedAvailable() && !this.winCoinsDoubled && this.winCoins > 0);
    if (this.winCoins > 0) {
      const coinLabel = `🪙 +${this.winCoins}${this.winCoinsDoubled ? "（已翻倍）" : ""}`;
      this._text(ctx, coinLabel, canDouble ? cx - 52 : cx, py + 216, { size: 15, weight: 700, color: "#e0a800", align: "center" });
    }
    if (canDouble) {
      this._button(ctx, cx + 8, py + 199, 132, 34, "📺 金币 ×2", () => {
        this.ads.requestReward("double", (r) => {
          if (r.granted) {
            this.save.addCoins(this.winCoins);
            this.winCoinsDoubled = true;
            this.audio.play("win");
            this.analytics.track("coins_doubled", { levelId: info.levelId, coins: this.winCoins });
          }
        });
      }, { bg: THEME.gold, color: "#3a2600", fontSize: 14, radius: 17 });
    }

    const bw = pw - 56, bx = px + 28;
    const hasNext = this.currentLevelIndex + 1 < this.levels.count;
    // 插屏只挂在"通关结算退出"这一自然断点，且由 AdManager 频控（每 N 胜 + 间隔 + 会话上限）
    const exitWin = () => { if (this.ads) this.ads.maybeShowInterstitial(); };
    if (hasNext) {
      this._button(ctx, bx, py + 246, bw, 46, "下一关 →", () => { exitWin(); this.startLevel(this.currentLevelIndex + 1); }, { bg: THEME.accent, fontSize: 17 });
    }
    // 最优解幽灵回放：把 solver 验证过的 solution 动画演示一遍（教学 + "原来还能这样"）
    this._button(ctx, bx, py + 302, bw, 40, "👻 看最优解回放", () => this._startReplay(), { bg: "#6c5ce7", fontSize: 15 });
    this._button(ctx, bx, py + 352, (bw - 10) / 2, 42, "重玩", () => { exitWin(); this.startLevel(this.currentLevelIndex); }, { fontSize: 15 });
    this._button(ctx, bx + (bw + 10) / 2, py + 352, (bw - 10) / 2, 42, "选关", () => { exitWin(); this.showSelect(); }, { fontSize: 15 });
  }

  /**
   * 失败弹层：步数用尽（GameManager FAIL 状态）。
   * 两条复活路径 + 两条退出路径：
   * - 看激励视频复活（广告不可用时 AdManager 自动降级免费发放，玩家永不卡死）；
   * - 金币复活（REVIVE_COIN_COST，金币的第一个消费出口；不足时点击给无效反馈）；
   * - 重开本关 / 退出到选关。
   * 复活后 moveLimit 增加、棋盘与步数保留（GameManager.revive）。
   */
  _renderFailOverlay(ctx) {
    const { px, py, pw } = this._overlayPanel(ctx, 348);
    const cx = px + pw / 2;
    // 卡通描边标题（危险色，与金色"通关！"对称）
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 28px sans-serif";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(20,26,36,0.9)";
    ctx.strokeText("😵 步数用完了", cx, py + 50);
    ctx.fillStyle = THEME.danger;
    ctx.fillText("😵 步数用完了", cx, py + 50);

    const add = this.gm.reviveMoves();
    this._text(ctx, `已走 ${this.gm.moves} 步 · 本关上限 ${this.gm.moveLimit} 步`, cx, py + 90, { size: 14, color: THEME.textSub, align: "center" });
    this._text(ctx, `复活立即 +${add} 步，棋盘保持现状`, cx, py + 112, { size: 13, color: THEME.textSub, align: "center" });

    const bw = pw - 56, bx = px + 28;
    const adAvailable = !!(this.ads && this.ads.isRewardedAvailable());
    const doRevive = (reason) => {
      if (this.gm.revive(add, reason)) this.overlay = null;
    };
    this._button(ctx, bx, py + 134, bw, 46, adAvailable ? `📺 看视频复活 +${add} 步` : `✨ 免费复活 +${add} 步`, () => {
      if (this.ads) {
        // FAIL 态不触发自动暂停（onAppHide 只在 PLAYING 时暂停），广告回来直接兑现
        this.ads.requestReward("revive", (r) => { if (r.granted) doRevive(adAvailable ? "ad" : "free"); });
      } else {
        doRevive("free");
      }
    }, { bg: THEME.accent, fontSize: 16 });

    const coins = this.save.data.coins || 0;
    const afford = coins >= REVIVE_COIN_COST;
    this._button(ctx, bx, py + 192, bw, 44, `🪙 ${REVIVE_COIN_COST} 金币复活 +${add} 步`, () => {
      if (!this.save.spendCoins(REVIVE_COIN_COST)) { this.audio.play("invalid"); return; }
      doRevive("coins");
    }, { bg: afford ? THEME.gold : THEME.buttonBg, color: afford ? "#3a2600" : THEME.textSub, fontSize: 14 });

    this._button(ctx, bx, py + 248, (bw - 10) / 2, 42, "🔄 重开", () => this._doRestart(), { fontSize: 14 });
    this._button(ctx, bx + (bw + 10) / 2, py + 248, (bw - 10) / 2, 42, "选关", () => { this.overlay = null; this.showSelect(); }, { fontSize: 14 });
    this._text(ctx, `我的金币 🪙 ${coins}${this.gm.reviveCount ? ` · 本关已复活 ${this.gm.reviveCount} 次` : ""}`, cx, py + 318, { size: 12, color: THEME.textSub, align: "center" });
  }

  /**
   * 涂装商店（金币消费出口）：皮肤 = 纯外观车身色板（js/ui/skins.js）。
   * 购买成功自动装备；已拥有可切换装备；余额不足给无效音反馈。
   * 从主菜单进入（overlay = "shop"）。
   */
  _renderShopOverlay(ctx) {
    const list = skins.SKINS;
    const rowH = 58;
    const ph = Math.min(this.H - 110, 96 + rowH * list.length + 66);
    const { px, py, pw } = this._overlayPanel(ctx, ph);
    const cx = px + pw / 2;
    this._text(ctx, "🛒 涂装商店", cx, py + 38, { size: 22, weight: 700, align: "center" });
    this._text(ctx, `我的金币 🪙 ${this.save.data.coins || 0}`, cx, py + 64, { size: 13, weight: 700, color: "#e0a800", align: "center" });

    const equipped = this.save.data.equippedSkin || "classic";
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const ry = py + 80 + i * rowH;
      ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.10)";
      roundRect(ctx, px + 14, ry, pw - 28, rowH - 8, 10);
      ctx.fill();
      // 色板试色：目标色 + 前 4 个车身色
      const sw = [s.target].concat(s.cars.slice(0, 4));
      for (let j = 0; j < sw.length; j++) {
        ctx.fillStyle = sw[j];
        ctx.beginPath();
        ctx.arc(px + 30 + j * 15, ry + 18, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      this._text(ctx, s.name, px + 24, ry + 38, { size: 13, weight: 700 });
      this._text(ctx, s.desc, px + 96, ry + 38, { size: 10, color: THEME.textSub });
      const owned = this.save.ownsSkin(s.id);
      const bw2 = 84, bx2 = px + pw - 22 - bw2;
      if (equipped === s.id) {
        this._button(ctx, bx2, ry + 8, bw2, 32, "使用中", () => {}, { bg: "#2f9e58", fontSize: 12, radius: 10 });
      } else if (owned) {
        this._button(ctx, bx2, ry + 8, bw2, 32, "装备", () => {
          this.save.equipSkin(s.id);
          this.analytics.track("skin_equipped", { skinId: s.id });
        }, { bg: THEME.accent, fontSize: 12, radius: 10 });
      } else {
        const afford = (this.save.data.coins || 0) >= s.price;
        this._button(ctx, bx2, ry + 8, bw2, 32, `🪙 ${s.price}`, () => {
          const r = this.save.purchaseSkin(s.id, s.price);
          if (r === "ok") {
            this.audio.play("win"); // 购入即装备：短琶音庆祝
            this.analytics.track("skin_purchased", { skinId: s.id, price: s.price });
          } else {
            this.audio.play("invalid"); // 金币不足
          }
        }, { bg: afford ? THEME.gold : THEME.buttonBg, color: afford ? "#3a2600" : THEME.textSub, fontSize: 12, radius: 10 });
      }
    }
    this._button(ctx, cx - 70, py + ph - 52, 140, 40, "返 回", () => { this.overlay = null; }, { fontSize: 15 });
  }

  _renderPauseOverlay(ctx) {
    const { px, py, pw } = this._overlayPanel(ctx);
    const cx = px + pw / 2;
    this._text(ctx, "已暂停", cx, py + 56, { size: 26, weight: 700, align: "center" });
    const bw = pw - 56, bx = px + 28;
    this._button(ctx, bx, py + 96, bw, 46, "继续游戏", () => {
      this.overlay = null;
      this.gm.resume();
    }, { bg: THEME.accent, fontSize: 17 });
    this._button(ctx, bx, py + 154, bw, 44, "重新开始", () => {
      this.overlay = null;
      this.gm.restart();
    }, { fontSize: 15 });
    this._button(ctx, bx, py + 210, bw, 44, "退出到选关", () => {
      this.overlay = null;
      this.showSelect();
    }, { fontSize: 15 });
  }

  /**
   * 提示配额用尽弹层：看激励视频解锁「本关提示不限次」。
   * 仅当广告真实可用时才会进入本弹层（_hintGateActive 已保证）；
   * 广告失败时 AdManager 自动降级为免费发放，玩家不会被卡住。
   */
  _renderAdHintOverlay(ctx) {
    const { px, py, pw } = this._overlayPanel(ctx);
    const cx = px + pw / 2;
    this._text(ctx, "💡 本关免费提示已用完", cx, py + 56, { size: 20, weight: 700, align: "center" });
    this._text(ctx, `已用 ${this._hintFreeUsed} 次 · 看个短视频`, cx, py + 94, { size: 14, color: THEME.textSub, align: "center" });
    this._text(ctx, "即可解锁本关提示不限次", cx, py + 116, { size: 14, color: THEME.textSub, align: "center" });
    const bw = pw - 56, bx = px + 28;
    this._button(ctx, bx, py + 142, bw, 46, "📺 观看视频", () => {
      this.ads.requestReward("hint", (r) => {
        if (r.granted) {
          this._hintUnlimited = true;
          // 广告播放会触发 wx.onHide → 自动暂停：先恢复对局，再兑现本次提示
          if (this.gm.state === GameState.PAUSED) this.gm.resume();
          this.overlay = null;
          this._useHint();
        } else if (this.overlay === "adHint") {
          this.overlay = null; // 用户中途跳过：回到对局（若已转自动暂停层则保留）
        }
      });
    }, { bg: THEME.accent, fontSize: 16 });
    this._button(ctx, bx, py + 202, bw, 42, "暂不需要", () => { this.overlay = null; }, { fontSize: 14 });
    this._text(ctx, "（每关免费提示会重置）", cx, py + 268, { size: 11, color: THEME.textSub, align: "center" });
  }

  // ---------------- 最优解幽灵回放 ----------------
  // 通关结算页点「👻 看最优解回放」：把 solver 验证过的 solution 用与实机
  // 相同的吸附/出库动画演一遍（教学 + "原来还能这样"的顿悟感）。回放期间
  // 棋盘重置到初始局面，直接改 board（不走 tryMove，故不计步/不触发胜利）；
  // 轻点任意处跳过，回到结算页。可反复观看。
  _startReplay() {
    const level = this.gm.levelData;
    if (!level || !level.solution || !level.solution.length) return;
    this.overlay = null;
    this.gm.loadLevel(level); // 棋盘回到初始局面（READY，不计时不计步）
    this.tweens = [];
    this.particles = [];
    this.drag = null;
    this.hint = null;
    this.hintPending = false;
    this.flashes = [];
    this.gateOpenedAt = 0;
    this.replay = {
      steps: level.solution.map((s) => ({ vehicleId: s.vehicleId, delta: s.delta })),
      index: 0,
      nextAt: this._now() + 420, // 起步稍作停顿，让玩家看清初始局面
    };
    this.analytics.track("solution_replay", { levelId: level.id, steps: this.replay.steps.length });
  }

  /** 每帧推进回放（_loop 调用）：等动画结束 + 步间停顿，再走下一步 */
  _pumpReplay() {
    const r = this.replay;
    if (!r) return;
    if (this.scene !== SCENE.GAME) { this._endReplay(); return; }
    if (this.tweens.length) return;         // 当前移动动画未结束
    if (this._now() < r.nextAt) return;      // 步间停顿
    if (r.index >= r.steps.length) { this._endReplay(); return; }
    this._stepReplayOnce();
  }

  /** 回放一步：直接改 board 并挂吸附/出库 tween（与实机拖动提交同一条动画路径） */
  _stepReplayOnce() {
    const r = this.replay;
    const board = this.gm.board;
    const step = r.steps[r.index];
    const v = board.getVehicle(step.vehicleId);
    if (!v || !board.canMove(step.vehicleId, step.delta)) { this._endReplay(); return; }
    const axis = v.orientation === "H" ? "x" : "y";
    board.moveVehicle(step.vehicleId, step.delta);
    this.audio.play("move");
    const win = board.checkWin();
    if (win) {
      this.gateOpenedAt = this._now();
      const v2 = board.getVehicle(step.vehicleId);
      const exitPx = (board.cols - v2.x) * this.cell;
      this.tweens.push({ id: step.vehicleId, axis, from: -step.delta * this.cell, to: exitPx, start: this._now(), dur: 320 });
    } else {
      this.tweens.push({ id: step.vehicleId, axis, from: -step.delta * this.cell, to: 0, start: this._now(), dur: 180 });
    }
    r.index++;
    r.nextAt = this._now() + (win ? 620 : 250); // 出库后多停一会再收
  }

  /** 结束回放（跳过 / 播完）：清理并回到通关结算页 */
  _endReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.tweens = [];
    this.gateOpenedAt = 0;
    if (this.winInfo) { this.overlay = "win"; this.starAnim = this._now(); }
    else this.overlay = null;
  }

  /** 回放中的顶栏进度 + 底部"轻点跳过"提示 */
  _renderReplayBanner(ctx) {
    const r = this.replay;
    if (!r) return;
    const cx = this.W / 2;
    const y = this.boardY - 34;
    ctx.save();
    ctx.fillStyle = "rgba(108,92,231,0.94)";
    roundRect(ctx, cx - 116, y - 16, 232, 32, 16);
    ctx.fill();
    const done = Math.min(r.index, r.steps.length);
    this._text(ctx, `👻 最优解回放  ${done} / ${r.steps.length} 步`, cx, y + 5, { size: 14, weight: 700, align: "center", color: "#fff" });
    const hintY = Math.min(this.barY + 62, this.H - 28);
    this._text(ctx, "轻点任意处跳过", cx, hintY, { size: 12, color: THEME.textSub, align: "center" });
    ctx.restore();
  }
}

module.exports = { UIManager, SCENE, THEME };
