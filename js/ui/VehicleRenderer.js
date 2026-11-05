"use strict";
/**
 * VehicleRenderer：程序化预渲染俯视角车辆精灵图（文档 §7.1 统一俯视角）。
 *
 * 车型（按长度 + id 哈希稳定分配，无需外部图片资源）：
 * - sports：目标车（红色跑车，白色拉花）
 * - sedan / suv：2 格小车
 * - truck / bus：3 格大车（卡车头+货箱 / 巴士长车身+侧窗）
 *
 * 精灵渲染到离屏 canvas 并按 (车型,颜色,朝向,长度,尺寸) 缓存；
 * 非微信环境（Node 测试）返回 null，UI 自动降级为矢量色块。
 */

const cache = new Map();

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** amt ∈ [-1,1]，负值变暗，正值变亮 */
function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `rgb(${clamp01(f(r) / 255) * 255 | 0},${clamp01(f(g) / 255) * 255 | 0},${clamp01(f(b) / 255) * 255 | 0})`;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function vehicleKind(v, isTarget) {
  if (isTarget) return "sports";
  if (v.length === 3) return hashStr(v.id) % 2 === 0 ? "truck" : "bus";
  return hashStr(v.id) % 3 === 0 ? "suv" : "sedan";
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 绘制一辆朝右的水平车（逻辑坐标：x,y,w,h 已含内边距）。
 * 各车型共用该坐标系，V 朝向由 setTransform 旋转实现。
 */
function drawCar(ctx, kind, color, x, y, w, h) {
  const glass = "#1d2b3a";
  const glassLite = "rgba(160,200,235,0.35)";
  const tire = "#14161a";
  const wheelH = Math.max(3, h * 0.13);
  const outline = shade(color, -0.5);

  // 车轮（车身下方露出）
  ctx.fillStyle = tire;
  const wx1 = x + w * 0.16, wx2 = x + w * 0.68;
  if (kind === "truck") {
    roundRectPath(ctx, wx1, y - wheelH * 0.5, w * 0.12, wheelH * 2.1, 2); ctx.fill();
    roundRectPath(ctx, wx2, y - wheelH * 0.5, w * 0.16, wheelH * 2.1, 2); ctx.fill();
    roundRectPath(ctx, wx2, y + h - wheelH * 1.6, w * 0.16, wheelH * 2.1, 2); ctx.fill();
    roundRectPath(ctx, wx1, y + h - wheelH * 1.6, w * 0.12, wheelH * 2.1, 2); ctx.fill();
  } else {
    roundRectPath(ctx, wx1, y - wheelH * 0.4, w * 0.14, wheelH * 1.8, 2); ctx.fill();
    roundRectPath(ctx, wx1, y + h - wheelH * 1.4, w * 0.14, wheelH * 1.8, 2); ctx.fill();
    roundRectPath(ctx, wx2, y - wheelH * 0.4, w * 0.14, wheelH * 1.8, 2); ctx.fill();
    roundRectPath(ctx, wx2, y + h - wheelH * 1.4, w * 0.14, wheelH * 1.8, 2); ctx.fill();
  }

  if (kind === "truck") {
    // 货箱（后部 62%）：浅灰箱体 + 竖向加强筋
    const boxX = x, boxW = w * 0.62;
    ctx.fillStyle = "#cfd6dd";
    roundRectPath(ctx, boxX, y, boxW, h, 3); ctx.fill();
    ctx.strokeStyle = "#8b95a1"; ctx.lineWidth = 1;
    roundRectPath(ctx, boxX, y, boxW, h, 3); ctx.stroke();
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(boxX + (boxW * i) / 5, y + 2);
      ctx.lineTo(boxX + (boxW * i) / 5, y + h - 2);
      ctx.stroke();
    }
    // 驾驶舱（前部）
    const cabX = x + boxW + w * 0.02, cabW = w - boxW - w * 0.02;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, shade(color, 0.3));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, shade(color, -0.3));
    ctx.fillStyle = grad;
    roundRectPath(ctx, cabX, y, cabW, h, 4); ctx.fill();
    ctx.strokeStyle = outline; ctx.lineWidth = 1.2;
    roundRectPath(ctx, cabX, y, cabW, h, 4); ctx.stroke();
    // 前挡风
    ctx.fillStyle = glass;
    roundRectPath(ctx, cabX + cabW * 0.55, y + h * 0.12, cabW * 0.3, h * 0.76, 2); ctx.fill();
    ctx.fillStyle = glassLite;
    roundRectPath(ctx, cabX + cabW * 0.58, y + h * 0.16, cabW * 0.12, h * 0.3, 2); ctx.fill();
    // 车灯
    ctx.fillStyle = "#ffe9a8";
    ctx.fillRect(x + w - 2.5, y + h * 0.12, 2.5, h * 0.16);
    ctx.fillRect(x + w - 2.5, y + h * 0.72, 2.5, h * 0.16);
    return;
  }

  // ---- 轿车 / SUV / 巴士 / 跑车：整体车身 ----
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, shade(color, 0.32));
  grad.addColorStop(0.45, color);
  grad.addColorStop(1, shade(color, -0.32));
  ctx.fillStyle = grad;
  const r = kind === "suv" ? 4 : kind === "sports" ? 8 : 6;
  roundRectPath(ctx, x, y, w, h, r); ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 1.2;
  roundRectPath(ctx, x, y, w, h, r); ctx.stroke();

  if (kind === "bus") {
    // 车顶（浅色带）+ 两侧连续侧窗 + 前挡风
    ctx.fillStyle = shade(color, 0.45);
    roundRectPath(ctx, x + w * 0.04, y + h * 0.3, w * 0.92, h * 0.4, 3); ctx.fill();
    ctx.fillStyle = glass;
    for (let i = 0; i < 5; i++) {
      const wxp = x + w * 0.08 + (w * 0.8 * i) / 5;
      roundRectPath(ctx, wxp, y + h * 0.06, w * 0.1, h * 0.14, 1.5); ctx.fill();
      roundRectPath(ctx, wxp, y + h * 0.8, w * 0.1, h * 0.14, 1.5); ctx.fill();
    }
    roundRectPath(ctx, x + w * 0.88, y + h * 0.1, w * 0.08, h * 0.8, 2); ctx.fill();
    ctx.fillStyle = "#ffe9a8";
    ctx.fillRect(x + w - 2, y + h * 0.1, 2, h * 0.14);
    ctx.fillRect(x + w - 2, y + h * 0.76, 2, h * 0.14);
    return;
  }

  // 座舱布局（朝右）：前挡风 - 车顶 - 后窗
  const wsX = x + w * (kind === "sports" ? 0.56 : 0.52);   // 前挡风
  const roofX = x + w * 0.3, roofW = w * (kind === "sports" ? 0.24 : 0.2);
  ctx.fillStyle = glass;
  // 前挡风（略带梯形感：圆角矩形+高光）
  roundRectPath(ctx, wsX, y + h * 0.1, w * 0.14, h * 0.8, 2.5); ctx.fill();
  ctx.fillStyle = glassLite;
  roundRectPath(ctx, wsX + w * 0.015, y + h * 0.16, w * 0.05, h * 0.34, 2); ctx.fill();
  // 后窗
  ctx.fillStyle = glass;
  roundRectPath(ctx, x + w * 0.16, y + h * 0.14, w * 0.1, h * 0.72, 2.5); ctx.fill();
  // 车顶高光
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  roundRectPath(ctx, roofX, y + h * 0.18, roofW, h * 0.64, 3); ctx.fill();
  // 引擎盖/后备箱分割线
  ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(wsX + w * 0.15, y + h * 0.12); ctx.lineTo(wsX + w * 0.15, y + h * 0.88); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w * 0.14, y + h * 0.12); ctx.lineTo(x + w * 0.14, y + h * 0.88); ctx.stroke();

  if (kind === "sports") {
    // 白色双拉花
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fillRect(x + w * 0.06, y + h * 0.3, w * 0.88, h * 0.09);
    ctx.fillRect(x + w * 0.06, y + h * 0.61, w * 0.88, h * 0.09);
    // 尾翼
    ctx.fillStyle = "#22262c";
    roundRectPath(ctx, x + 1, y + h * 0.06, w * 0.05, h * 0.88, 2); ctx.fill();
  }
  if (kind === "suv") {
    // 行李架
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(roofX + 2, y + h * 0.26); ctx.lineTo(roofX + roofW - 2, y + h * 0.26); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(roofX + 2, y + h * 0.74); ctx.lineTo(roofX + roofW - 2, y + h * 0.74); ctx.stroke();
  }

  // 后视镜
  ctx.fillStyle = shade(color, -0.2);
  ctx.fillRect(wsX + w * 0.1, y - 2, w * 0.04, 3);
  ctx.fillRect(wsX + w * 0.1, y + h - 1, w * 0.04, 3);
  // 前大灯 / 尾灯
  ctx.fillStyle = "#fff3c4";
  roundRectPath(ctx, x + w - 3, y + h * 0.1, 3, h * 0.16, 1); ctx.fill();
  roundRectPath(ctx, x + w - 3, y + h * 0.74, 3, h * 0.16, 1); ctx.fill();
  ctx.fillStyle = "#d64545";
  roundRectPath(ctx, x, y + h * 0.1, 2.5, h * 0.16, 1); ctx.fill();
  roundRectPath(ctx, x, y + h * 0.74, 2.5, h * 0.16, 1); ctx.fill();
}

function offscreenSupported() {
  return typeof wx !== "undefined" && typeof wx.createCanvas === "function";
}

/**
 * 获取车辆精灵（带缓存）。非微信环境返回 null（调用方降级矢量绘制）。
 * orientation: "H" | "V"；cell: 单格逻辑像素。
 */
function getSprite(kind, color, orientation, length, cell) {
  if (!offscreenSupported()) return null;
  let dpr = 2;
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    dpr = Math.min(3, info.pixelRatio || 2);
  } catch (e) { /* 默认 dpr */ }

  const key = [kind, color, orientation, length, Math.round(cell * dpr)].join("|");
  if (cache.has(key)) return cache.get(key);

  const cv = wx.createCanvas();
  const longPx = Math.round(length * cell * dpr);
  const shortPx = Math.round(cell * dpr);
  cv.width = orientation === "H" ? longPx : shortPx;
  cv.height = orientation === "H" ? shortPx : longPx;
  const ctx = cv.getContext("2d");

  const L = length * cell; // 逻辑长边
  const S = cell;          // 逻辑短边
  if (orientation === "H") {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else {
    // 旋转 90°：水平绘制空间 (x,y) → 垂直画布 (S - y, x)，车头朝下
    ctx.setTransform(0, dpr, -dpr, 0, S * dpr, 0);
  }

  const pad = Math.max(3, S * 0.08);
  drawCar(ctx, kind, color, pad, pad, L - pad * 2, S - pad * 2);

  cache.set(key, cv);
  return cv;
}

function clearCache() {
  cache.clear();
}

module.exports = { getSprite, vehicleKind, shade, clearCache };
