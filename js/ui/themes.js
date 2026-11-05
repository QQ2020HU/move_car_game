"use strict";
/**
 * themes.js：章节主题与卡通场景（P1 美术，零图片资源，纯 Canvas 矢量）。
 *
 * 每 6 关一个主题：驾校 → 小区 → 商场 → 医院 → 机场。
 * 每个主题的 drawBackground() 绘制**全屏场景**（天空/墙面/地面/远景/道具，
 * 带轻量动画），棋盘与 HUD 叠加其上；同一章节内每关的道具布局由
 * 关卡序号做确定性伪随机（prng），关关有细微差别。
 * 另提供：棋盘配色（地面/车位线）、drawFaceBubble 情绪气泡、
 * drawMenuScene 主菜单卡通场景。Node 冒烟测试的 ctx stub 可直接跑通。
 */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 确定性伪随机（关卡号做种子 → 每关布局稳定但不同） */
function prng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------- 卡通小部件 ----------------

/** 交通锥（x=中心, y=底部, s=高度） */
function cone(ctx, x, y, s) {
  ctx.fillStyle = "#2b2f36";
  roundRect(ctx, x - s * 0.55, y - s * 0.14, s * 1.1, s * 0.14, 3);
  ctx.fill();
  ctx.fillStyle = "#f2762e";
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.4, y - s * 0.1);
  ctx.lineTo(x - s * 0.4, y - s * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(x - s * 0.24, y - s * 0.6, s * 0.48, s * 0.15);
}

/** 树（x=中心, y=底部, s=总高, dark=剪影模式） */
function tree(ctx, x, y, s, dark) {
  ctx.fillStyle = dark ? "#1d2b18" : "#6b4a2f";
  ctx.fillRect(x - s * 0.06, y - s * 0.42, s * 0.12, s * 0.42);
  const blobs = [[0, -0.62, 0.3], [-0.2, -0.45, 0.22], [0.2, -0.45, 0.22], [0, -0.85, 0.2]];
  ctx.fillStyle = dark ? "#24381e" : "#4e9a3d";
  for (const [dx, dy, r] of blobs) {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!dark) {
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.arc(x - s * 0.08, y - s * 0.7, s * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 云朵（x=中心, y=中心, s=宽） */
function cloud(ctx, x, y, s, alpha) {
  ctx.fillStyle = `rgba(255,255,255,${alpha == null ? 0.9 : alpha})`;
  ctx.beginPath();
  ctx.arc(x - s * 0.22, y, s * 0.16, 0, Math.PI * 2);
  ctx.arc(x, y - s * 0.09, s * 0.22, 0, Math.PI * 2);
  ctx.arc(x + s * 0.24, y, s * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x - s * 0.36, y, s * 0.74, s * 0.12);
}

/** 表情小车（侧视卡通，x/y=左上角, w=宽, flip=朝左） */
function cuteCar(ctx, x, y, w, color, flip) {
  const h = w * 0.55;
  ctx.save();
  if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); x = 0; y = 0; }
  ctx.fillStyle = "#2b2f36";
  ctx.beginPath(); ctx.arc(x + w * 0.24, y + h * 0.9, h * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + w * 0.76, y + h * 0.9, h * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, y + h * 0.34, w, h * 0.52, h * 0.22); ctx.fill();
  roundRect(ctx, x + w * 0.2, y + h * 0.06, w * 0.56, h * 0.48, h * 0.18); ctx.fill();
  ctx.fillStyle = "rgba(223,241,255,0.95)";
  roundRect(ctx, x + w * 0.27, y + h * 0.14, w * 0.42, h * 0.28, h * 0.1); ctx.fill();
  const er = h * 0.06;
  ctx.fillStyle = "#22303f";
  ctx.beginPath(); ctx.arc(x + w * 0.38, y + h * 0.27, er, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + w * 0.58, y + h * 0.27, er, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#22303f";
  ctx.lineWidth = Math.max(1.2, h * 0.04);
  ctx.beginPath(); ctx.arc(x + w * 0.85, y + h * 0.56, h * 0.13, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = "#ffe9a8";
  ctx.beginPath(); ctx.arc(x + w * 0.965, y + h * 0.5, h * 0.075, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** 飞机剪影（x=中心, y, s=机身长） */
function planeSil(ctx, x, y, s, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.55, s * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath(); // 上主翼
  ctx.moveTo(x + s * 0.05, y - s * 0.02);
  ctx.lineTo(x - s * 0.3, y - s * 0.4);
  ctx.lineTo(x - s * 0.12, y - s * 0.02);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); // 下主翼
  ctx.moveTo(x + s * 0.05, y + s * 0.02);
  ctx.lineTo(x - s * 0.26, y + s * 0.36);
  ctx.lineTo(x - s * 0.1, y + s * 0.03);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); // 尾翼
  ctx.moveTo(x - s * 0.44, y - s * 0.02);
  ctx.lineTo(x - s * 0.62, y - s * 0.26);
  ctx.lineTo(x - s * 0.38, y - s * 0.03);
  ctx.closePath(); ctx.fill();
}

/** 红十字（x=中心, y=中心, s=尺寸） */
function crossMark(ctx, x, y, s, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x - s * 0.16, y - s * 0.5, s * 0.32, s);
  ctx.fillRect(x - s * 0.5, y - s * 0.16, s, s * 0.32);
}

/** 购物车（x=左上, y=底部, s=高） */
function cart(ctx, x, y, s, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.6, s * 0.07);
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.25, y - s);
  ctx.lineTo(x + s * 0.4, y - s * 0.35);
  ctx.lineTo(x + s * 1.05, y - s * 0.35);
  ctx.lineTo(x + s * 1.2, y - s * 0.92);
  ctx.lineTo(x + s * 0.3, y - s * 0.92);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x + s * 0.5, y - s * 0.16, s * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + s * 0.95, y - s * 0.16, s * 0.1, 0, Math.PI * 2); ctx.fill();
}

/** 购物袋（x=中心, y=底部, s=高） */
function bag(ctx, x, y, s, color, ribbon) {
  ctx.fillStyle = color;
  roundRect(ctx, x - s * 0.4, y - s * 0.75, s * 0.8, s * 0.75, s * 0.08);
  ctx.fill();
  ctx.strokeStyle = ribbon;
  ctx.lineWidth = Math.max(1.4, s * 0.06);
  ctx.beginPath();
  ctx.arc(x, y - s * 0.75, s * 0.2, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = ribbon;
  ctx.fillRect(x - s * 0.4, y - s * 0.42, s * 0.8, s * 0.1);
}

/** 救护车（x=左上, y=底部, w=宽, now 用于警灯闪烁） */
function ambulance(ctx, x, y, w, now) {
  const h = w * 0.52;
  ctx.fillStyle = "#2b2f36";
  ctx.beginPath(); ctx.arc(x + w * 0.22, y - h * 0.1, h * 0.13, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + w * 0.78, y - h * 0.1, h * 0.13, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#f4f7fa";
  roundRect(ctx, x, y - h * 0.85, w * 0.68, h * 0.72, h * 0.1); ctx.fill();
  roundRect(ctx, x + w * 0.62, y - h * 0.62, w * 0.36, h * 0.5, h * 0.12); ctx.fill();
  ctx.fillStyle = "rgba(150,200,235,0.9)";
  roundRect(ctx, x + w * 0.7, y - h * 0.56, w * 0.2, h * 0.2, h * 0.05); ctx.fill();
  ctx.fillStyle = "#e05252";
  ctx.fillRect(x + w * 0.04, y - h * 0.45, w * 0.56, h * 0.1);
  crossMark(ctx, x + w * 0.28, y - h * 0.65, h * 0.26, "#e05252");
  const blink = Math.floor(now / 280) % 2 === 0;
  ctx.fillStyle = blink ? "#ff5b5b" : "#5b8bff";
  roundRect(ctx, x + w * 0.2, y - h * 0.98, w * 0.2, h * 0.14, h * 0.05); ctx.fill();
}

/** 轮胎堆（x=中心, y=底部, s=单胎半径） */
function tires(ctx, x, y, s) {
  for (let i = 0; i < 3; i++) {
    const ty = y - s - i * s * 1.5;
    ctx.fillStyle = "#22262c";
    ctx.beginPath(); ctx.ellipse(x, ty, s * 1.15, s * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3d434c";
    ctx.beginPath(); ctx.ellipse(x, ty, s * 0.5, s * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  }
}

/** 路灯（x, y=底部, s=高） */
function lamp(ctx, x, y, s, glow) {
  ctx.strokeStyle = "#4a5464";
  ctx.lineWidth = Math.max(2, s * 0.045);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - s * 0.85);
  ctx.quadraticCurveTo(x, y - s, x + s * 0.22, y - s);
  ctx.stroke();
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(x + s * 0.26, y - s * 0.98, s * 0.08, 0, Math.PI * 2); ctx.fill();
  // 光晕
  ctx.fillStyle = "rgba(255,232,160,0.12)";
  ctx.beginPath(); ctx.arc(x + s * 0.26, y - s * 0.98, s * 0.3, 0, Math.PI * 2); ctx.fill();
}

/** 气球（x=中心, y=中心, s=半径, color, now 浮动） */
function balloon(ctx, x, y, s, color, now, seed) {
  const dy = Math.sin(now / 700 + seed) * 4;
  ctx.strokeStyle = "rgba(120,100,90,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + s + dy);
  ctx.quadraticCurveTo(x + 3, y + s * 1.8 + dy, x - 2, y + s * 2.4 + dy);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y + dy, s * 0.8, s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.ellipse(x - s * 0.25, y - s * 0.35 + dy, s * 0.18, s * 0.3, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

/** 星星（夜空闪烁） */
function starDot(ctx, x, y, r, a) {
  ctx.fillStyle = `rgba(255,255,240,${a})`;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// ---------------- 章节主题定义 ----------------

const CHAPTERS = [
  {
    key: "school", name: "驾校", icon: "🚧", range: "1-6",
    tagline: "新手训练场 · 先把车挪顺",
    pageBg: ["#5db4e8", "#cfe4c8"],
    curb: "#3c4658", rim: "rgba(245,166,35,0.30)",
    ground: ["#7b8aa0", "#68758c"],
    cellTint: ["rgba(255,255,255,0.07)", "rgba(255,255,255,0.02)"],
    line: "rgba(255,255,255,0.42)",
    accent: "#f5a623", accentDark: "#a86a00", tile: "#3b4663", light: true,
    // 白天训练场：蓝天 / 太阳 / 云 / 远处驾校楼与树 / 围栏 / 草地 / 锥桶阵 / 教练车巡游
    drawBackground(ctx, e, now) {
      const { W, H, bx, by, bw, bh } = e;
      const rnd = prng(e.li * 7919 + 11);
      const horizon = Math.max(by - 16, H * 0.16);
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#4facdf");
      sky.addColorStop(0.45, "#a9daf2");
      sky.addColorStop(1, "#cfe3bf");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      // 太阳
      ctx.fillStyle = "#ffe066";
      ctx.beginPath(); ctx.arc(W - 52, horizon * 0.38, 20, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,224,102,0.3)";
      ctx.beginPath(); ctx.arc(W - 52, horizon * 0.38, 30, 0, Math.PI * 2); ctx.fill();
      // 云（漂移）
      const cw = W + 180;
      cloud(ctx, ((now / 60) % cw) - 90, horizon * 0.3, 70, 0.85);
      cloud(ctx, ((now / 95 + 300) % cw) - 90, horizon * 0.55, 50, 0.7);
      // 远处驾校教学楼
      ctx.fillStyle = "#b9c4cf";
      ctx.fillRect(bx - 4, horizon - 40, 64, 40);
      ctx.fillStyle = "#93a3b3";
      ctx.fillRect(bx + 60, horizon - 28, 40, 28);
      ctx.fillStyle = "#6d7f91";
      for (let i = 0; i < 3; i++) ctx.fillRect(bx + 4 + i * 20, horizon - 32, 10, 9);
      // "驾校"招牌
      ctx.fillStyle = "#2f6fb5";
      roundRect(ctx, bx + bw - 66, horizon - 34, 62, 20, 5); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "700 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("平安驾校", bx + bw - 35, horizon - 23);
      // 树（每关位置微变）
      for (let i = 0; i < 3; i++) {
        const tx = bx + bw + 14 + rnd() * (W - bx - bw - 20);
        tree(ctx, Math.min(tx, W - 14), horizon, 26 + rnd() * 10);
      }
      // 白色围栏
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (let x = 4; x < W; x += 26) ctx.fillRect(x, horizon - 12, 4, 12);
      ctx.fillRect(0, horizon - 10, W, 3);
      // 草地
      ctx.fillStyle = "#7cb661";
      ctx.fillRect(0, horizon, W, H - horizon);
      ctx.fillStyle = "#6ea553";
      ctx.fillRect(0, horizon, W, 6);
      // 棋盘下方：水泥训练区 + 锥桶阵 + 轮胎
      const gy = by + bh + 12;
      if (H - gy > 26) {
        ctx.fillStyle = "#9aa4ad";
        ctx.fillRect(0, gy, W, H - gy);
        ctx.fillStyle = "#8b959e";
        ctx.fillRect(0, gy, W, 5);
        // S 形训练路线（白色虚线）
        ctx.strokeStyle = "rgba(255,255,255,0.8)";
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 8]);
        ctx.beginPath();
        ctx.moveTo(14, H - 18);
        ctx.bezierCurveTo(W * 0.3, gy + 10, W * 0.6, H - 10, W - 14, gy + 16);
        ctx.stroke();
        ctx.setLineDash([]);
        const nCones = 3 + (e.li % 3);
        for (let i = 0; i < nCones; i++) {
          cone(ctx, 16 + rnd() * (W - 32), H - 6 - rnd() * 14, 13 + rnd() * 6);
        }
        tires(ctx, W - 26, H - 8, 8);
        // 教练车巡游（车顶"学"字牌）
        const carX = ((now / 14) % (W + 160)) - 80;
        cuteCar(ctx, carX, gy + (H - gy) * 0.55 - 14, 52, "#f2f5fa", false);
        ctx.fillStyle = "#e8b23a";
        roundRect(ctx, carX + 18, gy + (H - gy) * 0.55 - 24, 16, 10, 3); ctx.fill();
        ctx.fillStyle = "#5a4200";
        ctx.font = "700 8px sans-serif";
        ctx.fillText("学", carX + 26, gy + (H - gy) * 0.55 - 18);
      }
    },
  },
  {
    key: "community", name: "小区", icon: "🏘", range: "7-12",
    tagline: "回家车位紧 · 别让邻居堵门",
    pageBg: ["#241d42", "#4a3550"],
    curb: "#241f30", rim: "rgba(126,211,33,0.22)",
    ground: ["#87796a", "#71655a"],
    cellTint: ["rgba(255,240,210,0.06)", "rgba(255,240,210,0.02)"],
    line: "rgba(255,244,214,0.4)",
    accent: "#7ed321", tile: "#3c4a33", light: false,
    // 傍晚小区：晚霞 / 月亮星星 / 居民楼剪影亮灯 / 树木 / 路灯 / 遛狗行人
    drawBackground(ctx, e, now) {
      const { W, H, bx, by, bw, bh } = e;
      const rnd = prng(e.li * 7919 + 29);
      const horizon = Math.max(by - 16, H * 0.2);
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#1d1838");
      sky.addColorStop(0.4, "#4a3159");
      sky.addColorStop(0.75, "#c96f4a");
      sky.addColorStop(1, "#e8a15e");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      // 星星与月亮
      for (let i = 0; i < 14; i++) {
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(now / 900 + i * 2.1));
        starDot(ctx, rnd() * W, rnd() * horizon * 0.6, 1.2, tw * 0.8);
      }
      ctx.fillStyle = "#ffeeba";
      ctx.beginPath(); ctx.arc(W * 0.2, horizon * 0.3, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,238,186,0.25)";
      ctx.beginPath(); ctx.arc(W * 0.2, horizon * 0.3, 24, 0, Math.PI * 2); ctx.fill();
      // 居民楼群剪影（亮灯窗户随时间闪）
      const builds = [];
      let bxp = -10;
      while (bxp < W + 10) {
        const w = 34 + rnd() * 34;
        const h = 50 + rnd() * (horizon * 0.75);
        builds.push([bxp, w, h]);
        bxp += w + 6 + rnd() * 12;
      }
      for (let bi = 0; bi < builds.length; bi++) {
        const [x, w, h] = builds[bi];
        ctx.fillStyle = "#181328";
        ctx.fillRect(x, horizon - h, w, h);
        // 窗
        for (let wy = 0; wy < Math.floor(h / 16); wy++) {
          for (let wx = 0; wx < Math.floor(w / 13); wx++) {
            const seedv = bi * 31 + wy * 7 + wx * 3;
            if (seedv % 3 === 0) continue;
            const lit = Math.floor(now / 3000 + seedv) % 5 !== 0;
            ctx.fillStyle = lit ? "rgba(255,214,130,0.85)" : "rgba(255,214,130,0.12)";
            ctx.fillRect(x + 4 + wx * 13, horizon - h + 6 + wy * 16, 7, 9);
          }
        }
        // 屋顶水箱
        if (bi % 2 === 0) {
          ctx.fillStyle = "#181328";
          ctx.fillRect(x + w * 0.3, horizon - h - 8, 10, 8);
        }
      }
      // 地面：小区步道 + 草坪
      ctx.fillStyle = "#3f4a33";
      ctx.fillRect(0, horizon, W, H - horizon);
      const gy = by + bh + 12;
      if (H - gy > 26) {
        ctx.fillStyle = "#5d5548";
        ctx.fillRect(0, gy, W, H - gy);
        ctx.fillStyle = "#4c453a";
        ctx.fillRect(0, gy, W, 5);
        // 树与路灯（每关微变）
        tree(ctx, 22 + rnd() * 12, H - 8, 46 + rnd() * 12, true);
        tree(ctx, W - 26 - rnd() * 12, H - 8, 40 + rnd() * 12, true);
        lamp(ctx, W * 0.5 + (rnd() - 0.5) * 40, H - 8, 44, "rgba(255,232,160,0.95)");
        // 遛狗行人剪影（缓慢走动）
        const px = ((now / 26) % (W + 120)) - 60;
        ctx.fillStyle = "#20242c";
        ctx.beginPath(); ctx.arc(px, H - 30, 4, 0, Math.PI * 2); ctx.fill();       // 头
        ctx.fillRect(px - 2.5, H - 26, 5, 12);                                    // 身
        const step = Math.sin(now / 160) * 3;
        ctx.fillRect(px - 2.5 + step * 0.4, H - 14, 2.5, 8);
        ctx.fillRect(px + step * -0.4, H - 14, 2.5, 8);
        ctx.beginPath(); ctx.arc(px + 16, H - 9, 3.5, 0, Math.PI * 2); ctx.fill(); // 狗
        ctx.fillRect(px + 12, H - 8, 9, 3);
        ctx.strokeStyle = "#20242c"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px + 3, H - 22); ctx.lineTo(px + 12, H - 10); ctx.stroke();
      }
    },
  },
  {
    key: "mall", name: "商场", icon: "🛒", range: "13-18",
    tagline: "周末抢购潮 · 车位全满了",
    pageBg: ["#f3e2ee", "#e6cfe0"],
    curb: "#8a72a8", rim: "rgba(239,135,168,0.35)",
    ground: ["#dcc9e8", "#c8b2d8"],
    cellTint: ["rgba(255,255,255,0.28)", "rgba(255,255,255,0.10)"],
    line: "rgba(255,255,255,0.65)",
    accent: "#ef87a8", accentDark: "#c24c72", tile: "#4a3d63", light: true,
    // 明亮室内商场：奶油墙 / 店铺门头与遮阳篷 / 促销吊旗 / 气球 / 格纹地砖 / 购物车与购物袋
    drawBackground(ctx, e, now) {
      const { W, H, bx, by, bw, bh } = e;
      const rnd = prng(e.li * 7919 + 47);
      // 墙面
      const wall = ctx.createLinearGradient(0, 0, 0, H);
      wall.addColorStop(0, "#f7e9f0");
      wall.addColorStop(0.6, "#efd9e6");
      wall.addColorStop(1, "#e3cade");
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, W, H);
      // 顶部：店铺门头（彩色遮阳篷 + 玻璃橱窗）
      const shopY = Math.max(by - 58, 64);
      const nShops = 4;
      const sw = W / nShops;
      const awnColors = [["#ef87a8", "#fff3f7"], ["#59c3a8", "#f0fff9"], ["#f5a623", "#fff8ea"], ["#7aa5e8", "#f2f7ff"]];
      for (let i = 0; i < nShops; i++) {
        const sx = i * sw + 5;
        const [c1, c2] = awnColors[(i + e.li) % awnColors.length];
        // 橱窗
        ctx.fillStyle = "rgba(90,110,140,0.32)";
        roundRect(ctx, sx + 4, shopY - 30, sw - 18, 30, 4); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillRect(sx + 8, shopY - 26, (sw - 26) * 0.3, 22);
        // 遮阳篷（条纹扇贝边）
        const aw = sw - 10, nScal = 5, scalW = aw / nScal;
        for (let s = 0; s < nScal; s++) {
          ctx.fillStyle = s % 2 === 0 ? c1 : c2;
          ctx.beginPath();
          ctx.moveTo(sx + 5 + s * scalW, shopY);
          ctx.lineTo(sx + 5 + (s + 1) * scalW, shopY);
          ctx.lineTo(sx + 5 + (s + 1) * scalW, shopY + 8);
          ctx.arc(sx + 5 + (s + 0.5) * scalW, shopY + 8, scalW / 2, 0, Math.PI);
          ctx.lineTo(sx + 5 + s * scalW, shopY + 8);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = c1;
        ctx.fillRect(sx + 5, shopY - 4, aw, 6);
      }
      // 促销吊旗 "SALE"
      const bannerSwing = Math.sin(now / 800) * 3;
      ctx.save();
      ctx.translate(W * 0.5, shopY + 20);
      ctx.rotate(bannerSwing * Math.PI / 180);
      ctx.fillStyle = "#e8402a";
      roundRect(ctx, -34, 0, 68, 22, 6); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "900 13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("SALE 5折", 0, 12);
      ctx.strokeStyle = "rgba(120,100,90,0.5)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-20, 0); ctx.lineTo(-26, -12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(26, -12); ctx.stroke();
      ctx.restore();
      // 气球（浮动，每关颜色/位置微变）
      const ballColors = ["#ef87a8", "#f5a623", "#7ed321", "#4a90d9", "#b072d4"];
      for (let i = 0; i < 3; i++) {
        balloon(ctx, 20 + rnd() * (W - 40), by + bh + 40 + rnd() * 30, 9 + rnd() * 4,
          ballColors[(i + e.li) % ballColors.length], now, i * 2.4 + e.li);
      }
      // 底部：格纹地砖
      const gy = by + bh + 12;
      const tileSize = 34;
      for (let ty = gy; ty < H; ty += tileSize) {
        for (let tx = -((ty / tileSize) % 2) * tileSize; tx < W; tx += tileSize) {
          ctx.fillStyle = ((tx + ty) / tileSize) % 2 === 0 ? "rgba(255,255,255,0.35)" : "rgba(190,150,200,0.18)";
          ctx.fillRect(tx, ty, tileSize, tileSize);
        }
      }
      ctx.fillStyle = "rgba(150,110,160,0.25)";
      ctx.fillRect(0, gy, W, 4);
      if (H - gy > 26) {
        cart(ctx, 14, H - 10, 26, "#a58bb0");
        bag(ctx, W - 52, H - 10, 26, "#ef87a8", "rgba(255,255,255,0.9)");
        bag(ctx, W - 24, H - 10, 21, "#f5a623", "rgba(255,255,255,0.9)");
      }
    },
  },
  {
    key: "hospital", name: "医院", icon: "🏥", range: "19-24",
    tagline: "生命通道 · 急救车要先走",
    pageBg: ["#e4f0f2", "#cfe0e4"],
    curb: "#7d97a1", rim: "rgba(224,82,82,0.28)",
    ground: ["#cddce2", "#b7c9d1"],
    cellTint: ["rgba(255,255,255,0.30)", "rgba(255,255,255,0.12)"],
    line: "rgba(255,255,255,0.7)",
    accent: "#e05252", accentDark: "#b03a3a", tile: "#31484f", light: true,
    // 明亮医院：浅青墙 / 红十字灯箱 / 心电图带 / 指示牌 / 救护车通道 / 盆栽
    drawBackground(ctx, e, now) {
      const { W, H, bx, by, bw, bh } = e;
      const rnd = prng(e.li * 7919 + 63);
      const wall = ctx.createLinearGradient(0, 0, 0, H);
      wall.addColorStop(0, "#eef6f7");
      wall.addColorStop(0.6, "#dcebee");
      wall.addColorStop(1, "#c7dbdf");
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, W, H);
      // 顶部：红十字灯箱 + "急诊"指示
      const signY = Math.max(by - 52, 62);
      ctx.fillStyle = "#f8fbfc";
      roundRect(ctx, bx - 6, signY - 26, 74, 34, 8); ctx.fill();
      ctx.strokeStyle = "rgba(120,150,160,0.5)"; ctx.lineWidth = 1.5;
      roundRect(ctx, bx - 6, signY - 26, 74, 34, 8); ctx.stroke();
      crossMark(ctx, bx + 12, signY - 9, 18, "#e05252");
      ctx.fillStyle = "#3a5560";
      ctx.font = "700 14px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText("急诊", bx + 28, signY - 8);
      // 悬挂指示牌（摇摆）
      const swing = Math.sin(now / 900) * 2.5;
      ctx.save();
      ctx.translate(bx + bw - 40, signY - 30);
      ctx.rotate(swing * Math.PI / 180);
      ctx.strokeStyle = "rgba(90,110,120,0.6)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(-14, 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(14, 10); ctx.stroke();
      ctx.fillStyle = "#59c36b";
      roundRect(ctx, -26, 10, 52, 18, 4); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "700 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("P 停车场→", 0, 20);
      ctx.restore();
      // 心电图带（横贯墙面，滚动脉冲）
      const ecgY = signY + 18;
      ctx.strokeStyle = "rgba(89,195,107,0.65)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const phase = (now / 900) % 1;
      for (let x = 0; x <= W; x += 3) {
        const t = (x / W + phase) % 1;
        let y = ecgY;
        if (t > 0.4 && t < 0.45) y = ecgY - 9;
        else if (t >= 0.45 && t < 0.49) y = ecgY + 11;
        else if (t >= 0.49 && t < 0.54) y = ecgY - 5;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 底部：急救通道地面（浅灰地砖 + 黄网格线）
      const gy = by + bh + 12;
      ctx.fillStyle = "#b9c8cd";
      ctx.fillRect(0, gy, W, H - gy);
      const tileSize = 30;
      for (let ty = gy; ty < H; ty += tileSize) {
        for (let tx = 0; tx < W; tx += tileSize) {
          ctx.fillStyle = ((tx + ty) / tileSize) % 2 === 0 ? "rgba(255,255,255,0.30)" : "rgba(140,170,180,0.14)";
          ctx.fillRect(tx, ty, tileSize, tileSize);
        }
      }
      // 黄色网格禁停线（急救通道）
      ctx.strokeStyle = "rgba(230,180,40,0.5)";
      ctx.lineWidth = 2;
      for (let x = -H; x < W + H; x += 18) {
        ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + (H - gy), gy); ctx.stroke();
      }
      if (H - gy > 26) {
        ambulance(ctx, 12 + (rnd() - 0.5) * 10, H - 10, 70, now);
        // 盆栽 x2
        for (const px of [W - 40, W - 78]) {
          ctx.fillStyle = "#b0724a";
          roundRect(ctx, px - 11, H - 24, 22, 14, 4); ctx.fill();
          ctx.fillStyle = "#4e9a3d";
          ctx.beginPath();
          ctx.arc(px, H - 31, 9, 0, Math.PI * 2);
          ctx.arc(px - 8, H - 26, 6.5, 0, Math.PI * 2);
          ctx.arc(px + 8, H - 26, 6.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
  },
  {
    key: "airport", name: "机场", icon: "✈️", range: "25-30",
    tagline: "赶飞机要紧 · 统统闪开",
    pageBg: ["#101a2e", "#1a2438"],
    curb: "#0f1622", rim: "rgba(66,198,176,0.28)",
    ground: ["#4c5666", "#3b4351"],
    cellTint: ["rgba(255,255,255,0.05)", "rgba(255,255,255,0.015)"],
    line: "rgba(255,255,255,0.22)",
    accent: "#42c6b0", tile: "#2e3d55", light: false,
    // 夜晚停机坪：星空 / 月亮 / 航站楼与塔台 / 起降飞机 / 跑道灯 / 风向袋 / 行李车
    drawBackground(ctx, e, now) {
      const { W, H, bx, by, bw, bh } = e;
      const rnd = prng(e.li * 7919 + 91);
      const horizon = Math.max(by - 16, H * 0.22);
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#070d1c");
      sky.addColorStop(0.5, "#12203c");
      sky.addColorStop(1, "#22304a");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      // 星空
      for (let i = 0; i < 26; i++) {
        const tw = 0.3 + 0.7 * Math.abs(Math.sin(now / 800 + i * 1.7));
        starDot(ctx, rnd() * W, rnd() * horizon * 0.8, 1.3, tw);
      }
      // 月亮
      ctx.fillStyle = "#e8eef8";
      ctx.beginPath(); ctx.arc(W * 0.78, horizon * 0.32, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#0f1a30";
      ctx.beginPath(); ctx.arc(W * 0.78 + 6, horizon * 0.32 - 3, 12, 0, Math.PI * 2); ctx.fill();
      // 航站楼剪影（右侧，亮窗）+ 塔台（左侧）
      ctx.fillStyle = "#0d1526";
      ctx.fillRect(bx + bw - 40, horizon - 52, W, 52);
      ctx.beginPath();
      ctx.moveTo(bx + bw - 40, horizon - 52);
      ctx.quadraticCurveTo(bx + bw + 10, horizon - 74, W + 10, horizon - 56);
      ctx.lineTo(W + 10, horizon - 52);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 8; i++) {
        const lit = Math.floor(now / 2600 + i * 5) % 4 !== 0;
        ctx.fillStyle = lit ? "rgba(160,210,255,0.8)" : "rgba(160,210,255,0.15)";
        ctx.fillRect(bx + bw - 32 + i * 14, horizon - 40, 8, 12);
      }
      const tx = Math.max(bx - 30, 18);
      ctx.fillStyle = "#0d1526";
      ctx.fillRect(tx - 4, horizon - 66, 8, 66);
      ctx.fillStyle = "#16233c";
      roundRect(ctx, tx - 14, horizon - 82, 28, 18, 4); ctx.fill();
      ctx.fillStyle = "rgba(140,200,255,0.85)";
      ctx.fillRect(tx - 11, horizon - 79, 22, 8);
      if (Math.floor(now / 600) % 2 === 0) {
        ctx.fillStyle = "#ff5b5b";
        ctx.beginPath(); ctx.arc(tx, horizon - 87, 3, 0, Math.PI * 2); ctx.fill();
      }
      // 巡航飞机（高空划过 + 航行灯闪烁）
      const px = -80 + ((now / 22) % (W + 160));
      const py = horizon * 0.35 + Math.sin(now / 900) * 4;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(Math.max(-10, px - 130), py + 7); ctx.lineTo(px - 30, py + 2); ctx.stroke();
      planeSil(ctx, px, py, 40, "#c9d6e8");
      if (Math.floor(now / 500) % 2 === 0) {
        ctx.fillStyle = "#ff4d4d";
        ctx.beginPath(); ctx.arc(px - 18, py - 2, 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#4dff88";
        ctx.beginPath(); ctx.arc(px + 18, py - 2, 2, 0, Math.PI * 2); ctx.fill();
      }
      // 停机坪地面
      ctx.fillStyle = "#232a36";
      ctx.fillRect(0, horizon, W, H - horizon);
      const gy = by + bh + 12;
      if (H - gy > 26) {
        ctx.fillStyle = "#2c3442";
        ctx.fillRect(0, gy, W, H - gy);
        // 滑行道黄色虚线
        ctx.strokeStyle = "rgba(247,201,72,0.75)";
        ctx.lineWidth = 3;
        ctx.setLineDash([16, 12]);
        ctx.lineDashOffset = -(now / 30) % 28;
        ctx.beginPath();
        ctx.moveTo(0, (gy + H) / 2 + 8);
        ctx.lineTo(W, (gy + H) / 2 + 8);
        ctx.stroke();
        ctx.setLineDash([]);
        // 蓝色跑道边灯（顺序闪烁）
        const blink = Math.floor(now / 400);
        for (let i = 0; i < 9; i++) {
          const on = (blink + i) % 3 === 0;
          ctx.fillStyle = on ? "rgba(120,190,255,0.95)" : "rgba(120,190,255,0.22)";
          ctx.beginPath(); ctx.arc(10 + i * (W - 20) / 8, H - 6, 2.8, 0, Math.PI * 2); ctx.fill();
        }
        // 行李拖车（缓慢驶过）
        const lx = W + 60 - ((now / 18) % (W + 140));
        ctx.fillStyle = "#3d4d70";
        roundRect(ctx, lx, H - 26, 26, 14, 3); ctx.fill();
        ctx.fillStyle = "#d98e4a";
        roundRect(ctx, lx + 30, H - 22, 16, 10, 2); ctx.fill();
        roundRect(ctx, lx + 50, H - 22, 16, 10, 2); ctx.fill();
        ctx.fillStyle = "#22262c";
        for (const wx2 of [lx + 5, lx + 20, lx + 35, lx + 58]) {
          ctx.beginPath(); ctx.arc(wx2, H - 11, 3, 0, Math.PI * 2); ctx.fill();
        }
        // 风向袋
        const wxp = W - 20;
        ctx.strokeStyle = "#5a6a85"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(wxp, H - 30); ctx.lineTo(wxp, gy + 8); ctx.stroke();
        const sway = Math.sin(now / 600) * 2;
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = i % 2 === 0 ? "#f2762e" : "#f4f7fa";
          ctx.fillRect(wxp - 15 + i * 4 + sway * (i / 4), gy + 8 + i * 0.6, 5, 8);
        }
      }
    },
    // 棋盘内：黄色滑行道边线（虚线内框）
    boardDeco(ctx, bx, by, bw, bh) {
      ctx.strokeStyle = "rgba(247,201,72,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 9]);
      ctx.strokeRect(bx + 5, by + 5, bw - 10, bh - 10);
      ctx.setLineDash([]);
    },
  },
];

function chapterOf(levelIndex) {
  const i = Math.floor(levelIndex / 6);
  return CHAPTERS[Math.max(0, Math.min(CHAPTERS.length - 1, i))];
}

/**
 * 情绪气泡（目标车状态反馈，纯矢量卡通脸）：
 *  - "angry"：被彻底堵死 → 皱眉 + 嘟嘴 + 怒气符
 *  - "happy"：出口通路已打开 → 眯眼笑 + 腮红
 */
function drawFaceBubble(ctx, cx, cy, r, mood, now) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath(); ctx.arc(cx + 1.5, cy + 2.5, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = mood === "angry" ? "#ffe9e2" : "#ffffff";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.3, cy + r * 0.82);
  ctx.lineTo(cx - r * 0.05, cy + r * 1.4);
  ctx.lineTo(cx + r * 0.25, cy + r * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(40,50,65,0.35)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

  if (mood === "angry") {
    const ax = cx + r * 0.72, ay = cy - r * 0.72, as = r * 0.3;
    ctx.strokeStyle = "#e8402a";
    ctx.lineWidth = Math.max(1.6, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(ax - as, ay - as); ctx.lineTo(ax + as, ay + as);
    ctx.moveTo(ax + as, ay - as); ctx.lineTo(ax - as, ay + as);
    ctx.stroke();
    ctx.strokeStyle = "#3a2a26";
    ctx.lineWidth = Math.max(1.4, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.34); ctx.lineTo(cx - r * 0.14, cy - r * 0.16);
    ctx.moveTo(cx + r * 0.5, cy - r * 0.34); ctx.lineTo(cx + r * 0.14, cy - r * 0.16);
    ctx.stroke();
    ctx.fillStyle = "#3a2a26";
    ctx.beginPath(); ctx.arc(cx - r * 0.28, cy + r * 0.02, r * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.28, cy + r * 0.02, r * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#c0492f";
    ctx.lineWidth = Math.max(1.4, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.3, cy + r * 0.42);
    ctx.quadraticCurveTo(cx - r * 0.15, cy + r * 0.28, cx, cy + r * 0.42);
    ctx.quadraticCurveTo(cx + r * 0.15, cy + r * 0.56, cx + r * 0.3, cy + r * 0.42);
    ctx.stroke();
  } else {
    ctx.strokeStyle = "#2f3a4a";
    ctx.lineWidth = Math.max(1.4, r * 0.1);
    ctx.beginPath();
    ctx.arc(cx - r * 0.28, cy + r * 0.02, r * 0.16, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + r * 0.28, cy + r * 0.02, r * 0.16, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.18, r * 0.38, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,150,150,0.55)";
    ctx.beginPath(); ctx.arc(cx - r * 0.55, cy + r * 0.24, r * 0.13, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.55, cy + r * 0.24, r * 0.13, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** 主菜单卡通场景：天空 / 太阳 / 流云 / 马路 / 表情小车 */
function drawMenuScene(ctx, W, H, now) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#63b8f0");
  sky.addColorStop(0.55, "#a5dcf7");
  sky.addColorStop(1, "#d9f0e0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const sx = W - 64, sy = 92;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(now / 6000);
  ctx.fillStyle = "rgba(255,214,90,0.55)";
  for (let i = 0; i < 8; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(-4, -30);
    ctx.lineTo(4, -30);
    ctx.lineTo(0, -46);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = "#ffd93d";
  ctx.beginPath(); ctx.arc(sx, sy, 24, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath(); ctx.arc(sx - 7, sy - 7, 9, 0, Math.PI * 2); ctx.fill();
  const cw = W + 160;
  cloud(ctx, ((now / 55) % cw) - 80, H * 0.14, 78, 0.9);
  cloud(ctx, ((now / 90 + 260) % cw) - 80, H * 0.22, 56, 0.7);
  cloud(ctx, ((now / 70 + 480) % cw) - 80, H * 0.09, 46, 0.6);
  ctx.fillStyle = "#9fd8a5";
  ctx.beginPath();
  ctx.moveTo(-20, H - 96);
  ctx.quadraticCurveTo(W * 0.25, H - 190, W * 0.55, H - 100);
  ctx.quadraticCurveTo(W * 0.8, H - 160, W + 20, H - 96);
  ctx.lineTo(W + 20, H);
  ctx.lineTo(-20, H);
  ctx.closePath();
  ctx.fill();
  const ry = H - 92;
  ctx.fillStyle = "#4c5561";
  ctx.fillRect(0, ry, W, 92);
  ctx.fillStyle = "#3d454f";
  ctx.fillRect(0, ry, W, 6);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 4;
  ctx.setLineDash([22, 18]);
  ctx.lineDashOffset = -(now / 22) % 40;
  ctx.beginPath();
  ctx.moveTo(0, ry + 48);
  ctx.lineTo(W, ry + 48);
  ctx.stroke();
  ctx.setLineDash([]);
  const span = W + 220;
  const c1 = ((now / 9) % span) - 110;
  const c2 = span - ((now / 13 + 300) % span) - 110;
  cuteCar(ctx, c1, ry + 6, 84, "#e05252", false);
  cuteCar(ctx, W - c2 - 78, ry + 50, 78, "#4a90d9", true);
}

module.exports = {
  CHAPTERS, chapterOf, drawMenuScene, drawFaceBubble, prng,
  roundRect, cuteCar, cloud, cone, tree, planeSil, crossMark,
};
