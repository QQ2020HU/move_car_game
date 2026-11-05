"use strict";
/**
 * AudioManager（P1）：WebAudio 实时合成引擎声与音效，零音频文件、零包体开销。
 *
 * - 引擎声：拖动时循环播放，音色按车型区分（卡车低沉 / 巴士中低 /
 *   SUV·轿车中高频 / 跑车高亢），音高与音量随拖动速度变化。
 * - 音效：按钮、移动、撤销、提示、通关（上行琶音）、无效移动（闷响）。
 * - 主总线：压缩器（防爆音削波）→ 总增益 → 输出；音效增益按真机响度校准
 *   （旧值 0.05~0.09 在手机上几乎听不见）。
 * - iOS 音量通道：setInnerAudioOption({obeyMuteSwitch:false}) 切到媒体音量，
 *   否则 WebAudio 跟随铃声/静音开关，真机声音极小。
 * - 背景音乐：程序化合成循环（C-G-Am-F 进行，低音+琶音+主旋律三层织体，
 *   前瞻调度器每 200ms 补排 0.9s 音符），独立 🎵 开关、切后台自动暂停。
 * - 手机小喇叭调校（android/ios 自动启用，桌面/模拟器不受影响）：
 *   引擎声与 BGM 低音基频 ×1.6、滤波截止 ×2（小喇叭放不出深低频），
 *   短音效最小时长 100ms + 起音 20ms（高延迟缓冲不吞瞬态）。
 * - 限幅降级链：压缩器 → WaveShaper tanh 软削波 → 纯增益(总增益降至 0.7)。
 * - 尊重存档中的 soundEnabled（音效）与 bgmEnabled（背景音乐）两个独立开关；
 *   非微信环境（Node 测试）自动静默。
 */

// 每种车型独立音色配置：主/副振荡器波形、基础频率、滤波截止、
// LFO 抖动速率与深度、失谐量——卡车柴油轰鸣 / 巴士中低沉 / SUV 饱满 /
// 轿车平顺 / 跑车高转嘶吼，听感明显区分。
const ENGINE_BASE = {
  truck: { freq: 42, cutoff: 190, Q: 7, type: "square", subType: "sawtooth", subRatio: 0.5, lfo: 6, lfoDepth: 0.16, detune: 0 },
  bus: { freq: 55, cutoff: 280, Q: 5, type: "sawtooth", subType: "square", subRatio: 0.5, lfo: 8, lfoDepth: 0.11, detune: 0 },
  suv: { freq: 70, cutoff: 420, Q: 4, type: "sawtooth", subType: "triangle", subRatio: 0.5, lfo: 10, lfoDepth: 0.08, detune: 5 },
  sedan: { freq: 84, cutoff: 500, Q: 3, type: "triangle", subType: "sawtooth", subRatio: 0.5, lfo: 12, lfoDepth: 0.06, detune: 0 },
  sports: { freq: 98, cutoff: 650, Q: 5, type: "sawtooth", subType: "sawtooth", subRatio: 1.0, lfo: 14, lfoDepth: 0.05, detune: 14 },
};

// 喇叭音高（Hz 双音）：大车低沉气喇叭，小车清脆电喇叭
const HORNS = {
  truck: [196, 247],
  bus: [233, 294],
  suv: [330, 415],
  sedan: [392, 494],
  sports: [440, 554],
};

// ---------------- 背景音乐（程序化合成，零音频文件） ----------------
// 轻快循环：C-G-Am-F 卡农进行，100bpm 八分音符步进，32 步（9.6s）一圈。
// 三层织体：低音（根音长音）+ 琶音（和弦分解）+ 主旋律（四分音符，稀疏留白），
// 音量控制在音效之下作铺垫，久听不吵。
const BGM_STEP = 0.3;                                  // 八分音符时长（秒）
const BGM_BASS = [130.81, 98.0, 110.0, 87.31];         // C3 / G2 / A2 / F2
const BGM_ARP = [
  [261.63, 329.63, 392.0, 523.25],                     // C:  C4 E4 G4 C5
  [246.94, 293.66, 392.0, 493.88],                     // G:  B3 D4 G4 B4
  [261.63, 329.63, 440.0, 523.25],                     // Am: C4 E4 A4 C5
  [261.63, 349.23, 440.0, 523.25],                     // F:  C4 F4 A4 C5
];
const BGM_MELODY = [
  329.63, 0, 392.0, 0, 523.25, 0, 392.0, 0,            // C:  E4 G4 C5 G4
  293.66, 0, 392.0, 0, 493.88, 0, 392.0, 0,            // G:  D4 G4 B4 G4
  261.63, 0, 329.63, 0, 440.0, 0, 329.63, 0,           // Am: C4 E4 A4 E4
  349.23, 0, 440.0, 0, 523.25, 0, 440.0, 0,            // F:  F4 A4 C5 A4（回到 C）
];

class AudioManager {
  /**
   * options.platform 可注入（"android"/"ios"/"devtools"…，测试用）；
   * 缺省从 wx.getDeviceInfo()/getSystemInfoSync() 探测。
   */
  constructor(saveManager, options) {
    const o = options || {};
    this.save = saveManager;
    this.enabled = saveManager ? saveManager.data.soundEnabled : true;
    this.bgmEnabled = saveManager ? !!saveManager.data.bgmEnabled : true;
    this.ctx = null;
    this.engine = null; // {osc, sub, filter, gain, base}
    this.master = null; // 主总线入口（压缩器或降级增益），所有声音接这里
    this.bgmGain = null; // BGM 专属总线（独立淡入淡出，不影响音效）
    this._bgm = null;    // BGM 调度器状态 {step, nextTime, timer}

    // 平台探测：手机小喇叭低频响应差 + 安卓音频链路延迟大，
    // 启用「小喇叭调校」；桌面（devtools/windows/mac）保持原调校
    this.platform = o.platform || "";
    if (!this.platform) {
      try {
        if (typeof wx !== "undefined") {
          if (wx.getDeviceInfo) this.platform = wx.getDeviceInfo().platform || "";
          else if (wx.getSystemInfoSync) this.platform = wx.getSystemInfoSync().platform || "";
        }
      } catch (e) { this.platform = ""; }
    }
    const small = this.platform === "android" || this.platform === "ios";
    this.dsp = small
      ? { freqMul: 1.6, cutoffMul: 2.0, minDur: 0.1 }
      : { freqMul: 1, cutoffMul: 1, minDur: 0 };

    try {
      // iOS 上小游戏声音默认走"铃声/静音开关"通道，音量极小且受静音键影响；
      // obeyMuteSwitch:false 切到媒体音量通道（Android 忽略该参数，无副作用）
      if (typeof wx !== "undefined" && wx.setInnerAudioOption) {
        wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: false });
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof wx !== "undefined" && wx.createWebAudioContext) {
        this.ctx = wx.createWebAudioContext();
      }
    } catch (e) {
      this.ctx = null;
    }
    if (this.ctx) this._initMaster();
  }

  /**
   * 主总线：限幅（压缩器或软削波）→ 总增益 → destination。
   * 降级链：DynamicsCompressor → WaveShaper(tanh 软削波，部分安卓 WebView
   * 无压缩器时兜底限幅) → 纯增益（无任何限幅，总增益降到 0.7 防削波）；
   * 再失败则直连输出（仅失去限幅与总增益）。
   */
  _initMaster() {
    const ctx = this.ctx;
    this.master = ctx.destination; // 保底：直连输出
    try {
      const t = ctx.currentTime;
      let bus;
      let plain = false; // 无限幅节点 → 需下调总增益
      if (ctx.createDynamicsCompressor) {
        bus = ctx.createDynamicsCompressor();
        bus.threshold.setValueAtTime(-18, t);
        bus.knee.setValueAtTime(10, t);
        bus.ratio.setValueAtTime(6, t);
        bus.attack.setValueAtTime(0.004, t);
        bus.release.setValueAtTime(0.2, t);
      } else if (ctx.createWaveShaper) {
        // tanh 软削波曲线：小信号近线性通过，大信号渐进压到 ±0.45 内，
        // 斜率在 0 处为 1（不改变整体响度），只"兜住"叠加峰值
        bus = ctx.createWaveShaper();
        const n = 1024, k = 2.2;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          curve[i] = Math.tanh(k * x) / k;
        }
        bus.curve = curve;
        bus.oversample = "2x";
      } else {
        bus = ctx.createGain();
        plain = true;
      }
      const master = ctx.createGain();
      master.gain.setValueAtTime(plain ? 0.7 : 0.9, t);
      bus.connect(master);
      master.connect(ctx.destination);
      this.master = bus;
      // BGM 专属总线：stopBgm 时淡出这里即可静音全部已排程音符
      this.bgmGain = ctx.createGain();
      this.bgmGain.gain.setValueAtTime(1, t);
      this.bgmGain.connect(bus);
    } catch (e) { /* 总线构建失败：保持直连（增益提升仍生效） */ }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.save) this.save.setSoundEnabled(this.enabled);
    if (!this.enabled) this.stopEngine();
  }

  /** 🎵 背景音乐开关（独立于音效开关）：立即生效并持久化 */
  setBgmEnabled(on) {
    this.bgmEnabled = !!on;
    if (this.save) this.save.setBgmEnabled(this.bgmEnabled);
    if (this.bgmEnabled) this.startBgm();
    else this.stopBgm();
  }

  get available() {
    return this.enabled && this.ctx;
  }

  // ---------------- 引擎声 ----------------
  startEngine(kind) {
    if (!this.available) return;
    this.stopEngine();
    try {
      const cfg = ENGINE_BASE[kind] || ENGINE_BASE.sedan;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const fm = this.dsp.freqMul, cm = this.dsp.cutoffMul; // 手机小喇叭抬频/开截止

      const osc = ctx.createOscillator();
      osc.type = cfg.type;
      osc.frequency.setValueAtTime(cfg.freq * fm, t);
      if (cfg.detune) osc.detune.setValueAtTime(cfg.detune, t);

      // 次级振荡器制造"气缸抖动"感（车型不同波形/比例不同）
      const sub = ctx.createOscillator();
      sub.type = cfg.subType;
      sub.frequency.setValueAtTime(cfg.freq * cfg.subRatio * fm, t);
      if (cfg.detune) sub.detune.setValueAtTime(-cfg.detune, t); // 跑车双振荡器拍频嘶吼

      // 低频抖动（怠速不稳）：卡车慢而深，跑车快而浅
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.setValueAtTime(cfg.lfo, t);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(cfg.freq * cfg.lfoDepth * fm, t);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cfg.cutoff * cm, t);
      filter.Q.setValueAtTime(cfg.Q, t);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.08);

      osc.connect(filter);
      sub.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      sub.start(t);
      lfo.start(t);

      this.engine = { osc, sub, lfo, filter, gain, cfg };
    } catch (e) { /* 合成失败静默降级 */ }
  }

  /** intensity 0~1（拖动速度） */
  updateEngine(intensity) {
    if (!this.engine) return;
    try {
      const { osc, sub, filter, gain, cfg } = this.engine;
      const t = this.ctx.currentTime;
      const i = Math.max(0, Math.min(1, intensity));
      const fm = this.dsp.freqMul, cm = this.dsp.cutoffMul;
      osc.frequency.setTargetAtTime(cfg.freq * fm * (1 + 0.9 * i), t, 0.05);
      // 副振荡器按车型 subRatio（修复：跑车 1.0 曾被写死 0.5 掉八度）
      sub.frequency.setTargetAtTime(cfg.freq * cfg.subRatio * fm * (1 + 0.9 * i), t, 0.05);
      filter.frequency.setTargetAtTime(cfg.cutoff * cm * (1 + 2.2 * i), t, 0.06);
      gain.gain.setTargetAtTime(0.10 + 0.14 * i, t, 0.06);
    } catch (e) { /* ignore */ }
  }

  stopEngine() {
    if (!this.engine) return;
    const { osc, sub, lfo, gain } = this.engine;
    this.engine = null;
    try {
      const t = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setTargetAtTime(0.0001, t, 0.04);
      osc.stop(t + 0.25);
      sub.stop(t + 0.25);
      lfo.stop(t + 0.25);
    } catch (e) { /* ignore */ }
  }

  // ---------------- 背景音乐（前瞻调度循环） ----------------

  /**
   * 启动 BGM（幂等）。iOS 要求用户手势后才能出声：UIManager 在构造与
   * 首次触摸时都会调用本方法，ctx 处于 suspended 时顺手 resume。
   * 挂起期间 currentTime 冻结，调度循环自动等待，不会堆积音符。
   */
  startBgm() {
    if (!this.ctx || !this.bgmEnabled) return;
    try {
      if (this.ctx.state === "suspended" && this.ctx.resume) this.ctx.resume();
    } catch (e) { /* ignore */ }
    if (this._bgm) return; // 已在播放
    const dest = this.bgmGain || this.master;
    if (!dest) return;
    try {
      if (this.bgmGain) { // 恢复上次 stopBgm 的淡出
        const t = this.ctx.currentTime;
        this.bgmGain.gain.cancelScheduledValues(t);
        this.bgmGain.gain.setValueAtTime(1, t);
      }
      this._bgm = { step: 0, nextTime: this.ctx.currentTime + 0.15, timer: null };
      this._scheduleBgm(); // 先排满前瞻窗口，避免起步空拍
      if (typeof setInterval !== "undefined") {
        this._bgm.timer = setInterval(() => this._scheduleBgm(), 200);
      }
    } catch (e) {
      this._bgm = null; // 启动失败静默降级（游戏无音乐照常运行）
    }
  }

  /** 停止 BGM：清调度器 + 总线淡出（已排程尾音一并静音） */
  stopBgm() {
    if (!this._bgm) return;
    const timer = this._bgm.timer;
    this._bgm = null;
    if (timer && typeof clearInterval !== "undefined") clearInterval(timer);
    try {
      if (this.bgmGain) {
        const t = this.ctx.currentTime;
        this.bgmGain.gain.cancelScheduledValues(t);
        this.bgmGain.gain.setTargetAtTime(0.0001, t, 0.08);
      }
    } catch (e) { /* ignore */ }
  }

  /** 前瞻排程：把 0.9s 内的音符全部写入 WebAudio 时间线（每 200ms 补一次） */
  _scheduleBgm() {
    if (!this._bgm || !this.ctx) return;
    try {
      while (this._bgm.nextTime < this.ctx.currentTime + 0.9) {
        this._playStep(this._bgm.step, this._bgm.nextTime);
        this._bgm.step = (this._bgm.step + 1) % 32;
        this._bgm.nextTime += BGM_STEP;
      }
    } catch (e) { /* 排程失败不致命，下个 tick 重试 */ }
  }

  /** 单步（八分音符）：低音（每拍）+ 琶音（每步）+ 主旋律（查表） */
  _playStep(step, t) {
    const bar = step >> 3;        // 0~3：C / G / Am / F
    const idx = step & 7;         // 小节内第几个八分音符
    if (idx === 0 || idx === 4) {
      this._bgmNote("triangle", BGM_BASS[bar] * this.dsp.freqMul, t, 0.55, 0.16);
    }
    const arp = BGM_ARP[bar];
    this._bgmNote("sine", arp[idx % arp.length], t, 0.24, 0.08);
    const mel = BGM_MELODY[step];
    if (mel) this._bgmNote("triangle", mel, t, 0.5, 0.11);
  }

  /** BGM 单音符：AD 包络，接 BGM 总线（无总线时退化接主总线） */
  _bgmNote(type, freq, t, dur, vol) {
    const ctx = this.ctx;
    const dest = this.bgmGain || this.master;
    if (!dest) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // ---------------- 一次性音效 ----------------
  play(name, kind) {
    if (!this.available) return;
    try {
      if (name === "button") this._tone("square", 660, 660, 0.06, 0.28);
      else if (name === "move") this._vroom();
      else if (name === "undo") this._tone("triangle", 440, 300, 0.12, 0.32);
      else if (name === "hint") { this._tone("sine", 880, 880, 0.09, 0.30); this._tone("sine", 1320, 1320, 0.12, 0.26, 0.09); }
      else if (name === "invalid") this._tone("sine", 160, 110, 0.1, 0.40);
      else if (name === "fail") { // 失败：下行双音（叹息感），与通关上行琶音对称
        this._tone("sawtooth", 330, 220, 0.22, 0.30);
        this._tone("sawtooth", 262, 196, 0.40, 0.28, 0.18); // 端点 >180Hz：小喇叭调校不改变下行方向
      }
      else if (name === "horn") this._horn(kind);
      else if (name === "win") this._fanfare();
    } catch (e) { /* ignore */ }
  }

  /** 鸣笛：双音喇叭，大车低沉气喇叭 / 小车清脆电喇叭（0.35s 两声短促） */
  _horn(kind) {
    const [f1, f2] = HORNS[kind] || HORNS.sedan;
    const big = kind === "truck" || kind === "bus";
    const dur = big ? 0.3 : 0.18;
    const vol = big ? 0.40 : 0.38;
    this._tone(big ? "sawtooth" : "square", f1, f1, dur, vol, 0);
    this._tone(big ? "sawtooth" : "square", f2, f2, dur, vol, 0);
    if (!big) { // 小车"滴滴"两声
      this._tone("square", f1, f1, dur, 0.32, dur + 0.06);
      this._tone("square", f2, f2, dur, 0.32, dur + 0.06);
    }
  }

  /**
   * 低频提升：手机小喇叭放不出 <180Hz 的基频，把落在该频段的音高按
   * freqMul 抬到可听区；中高频（按钮/提示/通关琶音/喇叭双音等本就清晰）
   * 原样返回。分界取 180Hz 以免只抬喇叭双音中的一个、破坏音程。
   * 桌面 freqMul=1 → 恒等，不影响 Mac 听感。
   */
  _liftFreq(f) {
    return f < 180 ? f * this.dsp.freqMul : f;
  }

  /** 简单音符：freq → endFreq 滑音，delay 秒后触发 */
  _tone(type, freq, endFreq, dur, vol, delay) {
    const ctx = this.ctx;
    const f0 = this._liftFreq(freq), f1 = this._liftFreq(endFreq);
    const t = ctx.currentTime + (delay || 0);
    const d = Math.max(dur, this.dsp.minDur); // 手机高延迟缓冲下短音不被吞
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.linearRampToValueAtTime(f1, t + d);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.02); // 起音 12→20ms，安卓大缓冲不削瞬态
    gain.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + d + 0.05);
  }

  /** 移动确认：短促"嗡-哒"（引擎给油收尾） */
  _vroom() {
    const ctx = this.ctx;
    const fm = this.dsp.freqMul;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(200 * fm, t);
    osc.frequency.exponentialRampToValueAtTime(80 * fm, t + 0.14);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.38, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(filter); filter.connect(gain); gain.connect(this.master);
    osc.start(t); osc.stop(t + 0.2);
  }

  /** 通关：C-E-G-C 上行琶音 */
  _fanfare() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this._tone("triangle", f, f, 0.22, 0.36, i * 0.11));
    this._tone("triangle", 1318.5, 1318.5, 0.4, 0.28, 0.46);
  }
}

module.exports = { AudioManager, ENGINE_BASE, BGM_STEP, BGM_BASS, BGM_ARP, BGM_MELODY };
