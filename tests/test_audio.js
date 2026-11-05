"use strict";
/**
 * 音频修复回归测试（Node 运行：node tests/test_audio.js）。
 * 用假 WebAudio 上下文验证真机"声音特别小"的修复：
 * ①iOS 切媒体音量通道（setInnerAudioOption obeyMuteSwitch:false）；
 * ②主总线（压缩器→总增益）构建，所有声音接总线而非直连 destination；
 * ③音效/引擎增益提升至真机可听水平（旧值 0.05~0.09 → 新值 ≥0.24）；
 * ④压缩器不支持/无 WebAudio 环境时逐级降级不抛异常。
 */

const assert = require("assert");

// ---------------- 假 WebAudio 桩件 ----------------
function makeParam() {
  return {
    calls: [],
    setValueAtTime(v, t) { this.calls.push(["set", v, t]); return this; },
    linearRampToValueAtTime(v, t) { this.calls.push(["lin", v, t]); return this; },
    exponentialRampToValueAtTime(v, t) { this.calls.push(["exp", v, t]); return this; },
    setTargetAtTime(v, t) { this.calls.push(["target", v, t]); return this; },
    cancelScheduledValues() { return this; },
  };
}

function makeFakeWebAudio(withoutCompressor, withShaper) {
  const log = { connects: [], gains: [], comps: [], shapers: [], oscs: [], filters: [], innerAudioOption: null };
  function makeNode(name, params, extra) {
    const n = Object.assign(
      { __name: name, connect(dst) { log.connects.push([n, dst]); return dst; }, disconnect() {} },
      extra || {}
    );
    (params || []).forEach((p) => { n[p] = makeParam(); });
    return n;
  }
  const destination = { __name: "destination", connect() {} };
  const ctx = {
    currentTime: 1.5,
    destination,
    state: "running",
    resume() {},
    createOscillator: () => { const o = makeNode("osc", ["frequency", "detune"], { type: "sine", start() {}, stop() {} }); log.oscs.push(o); return o; },
    createGain: () => { const g = makeNode("gain", ["gain"]); log.gains.push(g); return g; },
    createBiquadFilter: () => { const f = makeNode("filter", ["frequency", "Q"], { type: "lowpass" }); log.filters.push(f); return f; },
  };
  if (!withoutCompressor) {
    ctx.createDynamicsCompressor = () => {
      const c = makeNode("comp", ["threshold", "knee", "ratio", "attack", "release"]);
      log.comps.push(c);
      return c;
    };
  }
  if (withShaper) {
    ctx.createWaveShaper = () => {
      const s = makeNode("shaper", [], { curve: null, oversample: "" });
      log.shapers.push(s);
      return s;
    };
  }
  log.ctx = ctx;
  log.destination = destination;
  return log;
}

function installWx(log) {
  global.wx = {
    createWebAudioContext: () => log.ctx,
    setInnerAudioOption: (o) => { log.innerAudioOption = o; },
    getStorageSync: () => null,
    setStorageSync: () => {},
  };
}

const { AudioManager } = require("../js/ui/AudioManager.js");
const { SaveManager } = require("../js/save/SaveManager.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log("\n[音频修复回归测试]");

test("iOS 音量通道：setInnerAudioOption({obeyMuteSwitch:false}) 被调用", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  // eslint-disable-next-line no-unused-vars
  const am = new AudioManager(new SaveManager());
  assert.ok(log.innerAudioOption, "应调用 setInnerAudioOption");
  assert.strictEqual(log.innerAudioOption.obeyMuteSwitch, false, "应切到媒体音量通道");
});

test("主总线：压缩器→总增益(0.9)→destination；音效接总线而非直连输出", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(log.comps.length, 1, "应创建一个压缩器");
  const comp = log.comps[0];
  assert.strictEqual(am.master, comp, "master 应指向压缩器总线");
  const masterGain = log.gains[0]; // 总线里先建压缩器再建总增益
  assert.ok(log.connects.some((c) => c[0] === comp && c[1] === masterGain), "压缩器→总增益");
  assert.ok(log.connects.some((c) => c[0] === masterGain && c[1] === log.destination), "总增益→输出");
  assert.ok(masterGain.gain.calls.some((c) => c[0] === "set" && c[1] === 0.9), "总增益 0.9");
  am.play("button");
  const btnGain = log.gains[log.gains.length - 1];
  assert.ok(log.connects.some((c) => c[0] === btnGain && c[1] === comp), "音效包络应接主总线");
  assert.ok(!log.connects.some((c) => c[0] === btnGain && c[1] === log.destination), "不应再直连输出");
});

test("音效增益提升至真机可听水平（旧 0.05~0.09 → 新 ≥0.24）", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager());
  function peakOf(name, kind) {
    const before = log.gains.length;
    am.play(name, kind);
    const peaks = log.gains.slice(before).map(
      (g) => Math.max(...g.gain.calls.filter((c) => c[0] !== "target").map((c) => c[1]))
    );
    return Math.max(...peaks);
  }
  assert.ok(peakOf("button") >= 0.24, `button 峰值应 ≥0.24`);
  assert.ok(peakOf("undo") >= 0.28, `undo 峰值应 ≥0.28`);
  assert.ok(peakOf("hint") >= 0.24, `hint 峰值应 ≥0.24`);
  assert.ok(peakOf("invalid") >= 0.35, `invalid 峰值应 ≥0.35（低频感知弱需更高增益）`);
  assert.ok(peakOf("horn", "truck") >= 0.35, `horn 峰值应 ≥0.35`);
  assert.ok(peakOf("move") >= 0.3, `move(vroom) 起始增益应 ≥0.3`);
  assert.ok(peakOf("win") >= 0.3, `win 琶音峰值应 ≥0.3`);
});

test("引擎声增益提升：起步 ≥0.1，满强度 ≥0.2（旧 0.05/0.095），且接主总线", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager());
  am.startEngine("sedan");
  const engGain = log.gains[log.gains.length - 1]; // 引擎主包络（lfoGain 之后创建）
  const startPeak = Math.max(...engGain.gain.calls.filter((c) => c[0] === "lin").map((c) => c[1]));
  assert.ok(startPeak >= 0.1, `引擎起步增益应 ≥0.1，实际 ${startPeak}`);
  assert.ok(log.connects.some((c) => c[0] === engGain && c[1] === am.master), "引擎声应接主总线");
  am.updateEngine(1);
  const target = Math.max(...engGain.gain.calls.filter((c) => c[0] === "target").map((c) => c[1]));
  assert.ok(target >= 0.2, `满强度引擎增益应 ≥0.2，实际 ${target}`);
  am.stopEngine();
  assert.strictEqual(am.engine, null);
});

test("基础库不支持压缩器 → 降级纯增益总线，声音仍接总线且限幅外无异常", () => {
  const log = makeFakeWebAudio(true); // 无 createDynamicsCompressor
  installWx(log);
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(am.master, log.gains[0], "master 应为降级增益总线");
  const masterGain = log.gains[1];
  assert.ok(log.connects.some((c) => c[0] === am.master && c[1] === masterGain), "总线→总增益");
  assert.ok(log.connects.some((c) => c[0] === masterGain && c[1] === log.destination), "总增益→输出");
  const before = log.gains.length;
  am.play("win"); // 琶音 5 个音符不抛异常
  const toneGains = log.gains.slice(before);
  assert.ok(toneGains.length >= 5, "应创建 5 个音符包络");
  assert.ok(toneGains.every((g) => log.connects.some((c) => c[0] === g && c[1] === am.master)));
});

test("无 WebAudio 环境（Node/老基础库）→ 静默降级，全部接口不抛异常", () => {
  global.wx = { getStorageSync: () => null, setStorageSync: () => {} };
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(am.ctx, null);
  assert.strictEqual(am.master, null);
  assert.ok(!am.available, "无音频上下文时不可用");
  am.play("button"); am.play("horn", "truck"); am.play("win");
  am.startEngine("truck"); am.updateEngine(0.5); am.stopEngine();
  am.startBgm(); am._scheduleBgm(); am.stopBgm(); // BGM 同样静默降级
  am.setEnabled(false); am.setEnabled(true);
  am.setBgmEnabled(false); am.setBgmEnabled(true);
});

// ---------------- 背景音乐（BGM） ----------------

test("BGM：默认开启；启动即建前瞻调度器，音符接专属总线→主总线", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const save = new SaveManager();
  assert.strictEqual(save.data.bgmEnabled, true, "背景音乐默认开启");
  const am = new AudioManager(save);
  assert.ok(am.bgmGain, "应创建 BGM 专属总线");
  assert.ok(log.connects.some((c) => c[0] === am.bgmGain && c[1] === am.master), "BGM 总线→主总线");
  am.startBgm();
  assert.ok(am._bgm, "调度器应启动");
  assert.ok(am._bgm.timer, "应注册 200ms 前瞻定时器");
  const noteGains = log.gains.filter((g) => log.connects.some((c) => c[0] === g && c[1] === am.bgmGain));
  assert.ok(noteGains.length >= 3, `首个窗口应排入低音+琶音+旋律音符，实际 ${noteGains.length}`);
  am.stopBgm();
  assert.strictEqual(am._bgm, null, "停止应清空调度器");
});

test("BGM：音符增益在铺垫区间（0.05~0.2，盖不过音效）；时间推进持续排程并 32 步回绕", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager());
  am.startBgm();
  const noteGains = log.gains.filter((g) => log.connects.some((c) => c[0] === g && c[1] === am.bgmGain));
  const peaks = noteGains.map(
    (g) => Math.max(...g.gain.calls.filter((c) => c[0] === "lin").map((c) => c[1]))
  );
  assert.ok(peaks.length >= 3);
  assert.ok(peaks.every((p) => p >= 0.05 && p <= 0.2), `增益应在可听且不喧宾夺主区间: ${peaks.join(",")}`);
  const gains0 = log.gains.length;
  log.ctx.currentTime += 3.0; // 前进 3s（10 个八分音符步）
  am._scheduleBgm();
  assert.ok(log.gains.length > gains0, "应继续排入新音符");
  assert.ok(am._bgm.step >= 0 && am._bgm.step < 32, "步进应在循环内");
  log.ctx.currentTime += 20; // 跨多圈
  am._scheduleBgm();
  assert.ok(am._bgm.step >= 0 && am._bgm.step < 32, "长推进后仍回绕于 32 步");
  am.stopBgm();
});

test("BGM 开关：关闭即停调度+淡出+持久化；新实例读档不播；再开恢复总线增益", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const save = new SaveManager();
  const am = new AudioManager(save);
  am.startBgm();
  am.setBgmEnabled(false);
  assert.strictEqual(save.data.bgmEnabled, false, "关闭应持久化");
  assert.strictEqual(am._bgm, null, "关闭应立即停调度器");
  assert.ok(am.bgmGain.gain.calls.some((c) => c[0] === "target" && c[1] < 0.001), "关闭应淡出 BGM 总线");
  am.startBgm();
  assert.strictEqual(am._bgm, null, "开关关闭时 startBgm 应无效");
  // 重启（新实例）读档：默认不播
  const am2 = new AudioManager(save);
  assert.strictEqual(am2.bgmEnabled, false);
  am2.startBgm();
  assert.strictEqual(am2._bgm, null);
  // 重新打开：立即开播 + 总线增益恢复 1（撤销淡出）
  am2.setBgmEnabled(true);
  assert.strictEqual(save.data.bgmEnabled, true);
  assert.ok(am2._bgm, "打开应立即播放");
  assert.ok(am2.bgmGain.gain.calls.some((c) => c[0] === "set" && c[1] === 1), "应恢复总线增益");
  am2.stopBgm();
});

test("BGM 与音效开关相互独立：🔇 关音效不断音乐；stop/start 模拟切后台恢复", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const save = new SaveManager();
  const am = new AudioManager(save);
  am.startBgm();
  am.setEnabled(false); // 🔇 关音效
  assert.ok(am._bgm, "🔇 不应影响背景音乐");
  const g0 = log.gains.length;
  am.play("button");
  assert.strictEqual(log.gains.length, g0, "🔇 后音效应静默");
  am.setEnabled(true);
  am.stopBgm();   // 切后台（onAppHide）
  assert.strictEqual(am._bgm, null);
  am.startBgm();  // 回前台（onAppShow）
  assert.ok(am._bgm, "回前台应恢复背景音乐");
  am.stopBgm();
});

test("iOS 挂起上下文：startBgm 尝试 resume；时间冻结期间音符不堆积", () => {
  const log = makeFakeWebAudio();
  log.ctx.state = "suspended";
  let resumed = 0;
  log.ctx.resume = () => { resumed++; };
  installWx(log);
  const am = new AudioManager(new SaveManager());
  am.startBgm();
  assert.strictEqual(resumed, 1, "应尝试 resume 解锁音频");
  const g0 = log.gains.length;
  am._scheduleBgm();
  am._scheduleBgm(); // 挂起时 currentTime 不前进
  assert.strictEqual(log.gains.length, g0, "挂起期间不应继续排程（防堆积）");
  am.stopBgm();
});

// ---------------- 安卓友好音频调整 ----------------

// 取参数首个 "set" 调用值 / 首个某类型调用的时间
function firstSet(node, param) {
  const c = node[param].calls.find((x) => x[0] === "set");
  return c ? c[1] : undefined;
}
function firstSetTime(node, param) {
  const c = node[param].calls.find((x) => x[0] === "set");
  return c ? c[2] : undefined;
}
function callOfType(node, param, type) {
  return node[param].calls.find((x) => x[0] === type);
}

test("平台探测：wx.getDeviceInfo 缺失时不崩，platform 为空、桌面调校(freqMul=1)", () => {
  const log = makeFakeWebAudio();
  installWx(log); // 桩件不含 getDeviceInfo/getSystemInfoSync
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(am.platform, "", "无平台 API 时应安全回退空串");
  assert.strictEqual(am.dsp.freqMul, 1, "桌面/未知平台不抬频");
  assert.strictEqual(am.dsp.cutoffMul, 1);
  assert.strictEqual(am.dsp.minDur, 0);
});

test("平台探测：wx.getDeviceInfo().platform='android' → 启用小喇叭调校", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  global.wx.getDeviceInfo = () => ({ platform: "android" });
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(am.platform, "android");
  assert.ok(am.dsp.freqMul > 1, "安卓应抬高低频基频");
  assert.ok(am.dsp.cutoffMul > 1, "安卓应放宽滤波截止");
  assert.ok(am.dsp.minDur > 0, "安卓短音应有最小时长");
});

test("安卓：引擎基频与截止按 freqMul/cutoffMul 抬高（手机喇叭可放）", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager(), { platform: "android" });
  const fm = am.dsp.freqMul, cm = am.dsp.cutoffMul;
  am.startEngine("truck"); // ENGINE_BASE.truck freq=42 cutoff=190
  const main = log.oscs[log.oscs.length - 3]; // osc, sub, lfo 三个
  const sub = log.oscs[log.oscs.length - 2];
  const filt = log.filters[log.filters.length - 1];
  assert.strictEqual(firstSet(main, "frequency"), 42 * fm, "主振荡器基频应抬高");
  assert.strictEqual(firstSet(sub, "frequency"), 42 * 0.5 * fm, "副振荡器按 subRatio 抬高");
  assert.strictEqual(firstSet(filt, "frequency"), 190 * cm, "低通截止应放宽");
});

test("安卓：低频音(<180Hz)抬到可听区，中高频(按钮660/喇叭双音)保持原音程", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager(), { platform: "android" });
  const fm = am.dsp.freqMul;
  // invalid 160→110（低频）应被抬升
  let n0 = log.oscs.length;
  am.play("invalid");
  const invOsc = log.oscs[n0];
  assert.strictEqual(firstSet(invOsc, "frequency"), 160 * fm, "invalid 低频应抬升");
  assert.strictEqual(callOfType(invOsc, "frequency", "lin")[1], 110 * fm, "invalid 滑音终点同步抬升");
  // button 660（中高频）不抬升
  n0 = log.oscs.length;
  am.play("button");
  assert.strictEqual(firstSet(log.oscs[n0], "frequency"), 660, "按钮中高频不抬升（避免变尖）");
  // 喇叭 truck 双音 196/247（≥180）两个都不抬升，保持音程
  n0 = log.oscs.length;
  am.play("horn", "truck");
  const h1 = log.oscs[n0], h2 = log.oscs[n0 + 1];
  assert.strictEqual(firstSet(h1, "frequency"), 196, "喇叭双音不单独抬升");
  assert.strictEqual(firstSet(h2, "frequency"), 247, "喇叭双音保持原音程");
});

test("起音放宽 12→20ms（安卓大缓冲不削瞬态）；短音最小时长兜底", () => {
  // 桌面：attack=0.02，button dur=0.06
  const logD = makeFakeWebAudio();
  installWx(logD);
  const amD = new AudioManager(new SaveManager());
  amD.play("button");
  const gD = logD.gains[logD.gains.length - 1];
  const atkD = callOfType(gD, "gain", "lin");
  assert.ok(Math.abs((atkD[2] - firstSetTime(gD, "gain")) - 0.02) < 1e-9, "起音斜坡应为 20ms");
  const expD = callOfType(gD, "gain", "exp");
  assert.ok(Math.abs((expD[2] - firstSetTime(gD, "gain")) - 0.06) < 1e-9, "桌面 button 时长 0.06");
  // 安卓：attack=0.02，button dur 抬到 minDur(≥0.1)
  const logA = makeFakeWebAudio();
  installWx(logA);
  const amA = new AudioManager(new SaveManager(), { platform: "android" });
  amA.play("button");
  const gA = logA.gains[logA.gains.length - 1];
  const expA = callOfType(gA, "gain", "exp");
  const durA = expA[2] - firstSetTime(gA, "gain");
  assert.ok(durA >= amA.dsp.minDur - 1e-9, `安卓 button 时长应≥minDur，实际 ${durA}`);
});

test("无压缩器但有 WaveShaper → tanh 软削波兜底限幅，总增益仍 0.9", () => {
  const log = makeFakeWebAudio(true, true); // 无 compressor，有 shaper
  installWx(log);
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(log.shapers.length, 1, "应创建一个 WaveShaper");
  const shaper = log.shapers[0];
  assert.strictEqual(am.master, shaper, "master 应指向软削波总线");
  assert.ok(shaper.curve && shaper.curve.length === 1024, "应写入软削波曲线");
  assert.strictEqual(shaper.oversample, "2x", "应 2x 过采样减少混叠");
  // 曲线单调、近中心过零、两端被压进 (-1,1)（tanh(2.2)/2.2≈0.44）
  assert.ok(Math.abs(shaper.curve[512]) < 0.01, "曲线近中心过零");
  assert.ok(shaper.curve[0] < 0 && shaper.curve[1023] > 0, "曲线负端正峰负、正端正");
  assert.ok(shaper.curve[1023] > 0.3 && shaper.curve[1023] < 1, "正峰被限幅在 ~0.44（<1）");
  assert.ok(shaper.curve[1023] > shaper.curve[900], "曲线单调递增");
  const masterGain = log.gains[0];
  assert.ok(masterGain.gain.calls.some((c) => c[0] === "set" && c[1] === 0.9), "软削波路径总增益仍 0.9");
  am.play("win");
  const last = log.gains[log.gains.length - 1];
  assert.ok(log.connects.some((c) => c[0] === last && c[1] === shaper), "音效应接软削波总线");
});

test("失败音：下行双音锯齿（与通关上行琶音对称）；安卓小喇叭调校不反转滑音方向", () => {
  const log = makeFakeWebAudio();
  installWx(log);
  const am = new AudioManager(new SaveManager());
  const n0 = log.oscs.length;
  am.play("fail");
  const oscs = log.oscs.slice(n0);
  assert.strictEqual(oscs.length, 2, "fail 应为双音");
  assert.ok(oscs.every((o) => o.type === "sawtooth"), "应用锯齿波（叹息感的粗粝音色）");
  // 第一音 330→220 立即；第二音 262→196 延迟 0.18s——两段都下行
  assert.strictEqual(firstSet(oscs[0], "frequency"), 330);
  assert.strictEqual(callOfType(oscs[0], "frequency", "lin")[1], 220);
  assert.strictEqual(firstSet(oscs[1], "frequency"), 262);
  assert.strictEqual(callOfType(oscs[1], "frequency", "lin")[1], 196);
  assert.ok(Math.abs(firstSetTime(oscs[1], "frequency") - firstSetTime(oscs[0], "frequency") - 0.18) < 1e-9,
    "第二音应比第一音晚 0.18s");
  // 安卓调校回归：滑音端点 196 > 180Hz 交叉点 → _liftFreq 不介入，下行方向保持
  // （若端点误设 <180，freqMul 会把它抬到起点之上，"叹息"变"上扬"）
  const logA = makeFakeWebAudio();
  installWx(logA);
  const amA = new AudioManager(new SaveManager(), { platform: "android" });
  const mA = logA.oscs.length;
  amA.play("fail");
  const oscsA = logA.oscs.slice(mA);
  assert.strictEqual(oscsA.length, 2);
  for (const o of oscsA) {
    const f0 = firstSet(o, "frequency");
    const f1 = callOfType(o, "frequency", "lin")[1];
    assert.ok(f1 < f0, `安卓调校后仍应下行滑音（${f0}→${f1}）`);
  }
});

test("既无压缩器也无 WaveShaper → 纯增益总线，总增益降到 0.7 防削波", () => {
  const log = makeFakeWebAudio(true, false);
  installWx(log);
  const am = new AudioManager(new SaveManager());
  assert.strictEqual(am.master, log.gains[0], "master 为降级增益总线");
  const masterGain = log.gains[1];
  assert.ok(masterGain.gain.calls.some((c) => c[0] === "set" && c[1] === 0.7), "无限幅节点时总增益降到 0.7");
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);