"use strict";
/**
 * skins.js：金币商店的车辆涂装皮肤（纯外观，不影响玩法数值）。
 * 每套皮肤 = 8 个普通车身色 + 1 个目标车色，替换 THEME.cars / THEME.target。
 * VehicleRenderer 的精灵缓存 key 含颜色 → 换肤零缓存改动，自动重渲染。
 * 定价参考：通关奖励 星数×10（可翻倍），30 关满星 ≈ 900+ 金币。
 */

const SKINS = [
  {
    id: "classic", name: "经典涂装", price: 0, desc: "驾校默认配色",
    target: "#e04b4b",
    cars: ["#4a90d9", "#f5a623", "#7ed321", "#b072d4", "#42c6b0", "#ef87a8", "#8d99ae", "#d98e4a"],
  },
  {
    id: "candy", name: "糖果屋", price: 200, desc: "甜甜的马卡龙色",
    target: "#ff5d8f",
    cars: ["#ff9aa2", "#ffdac1", "#b5ead7", "#c7ceea", "#a0e7e5", "#fbe7c6", "#b4f8c8", "#e0bbe4"],
  },
  {
    id: "neon", name: "霓虹之夜", price: 300, desc: "赛博霓虹灯色",
    target: "#ff2e63",
    cars: ["#08d9d6", "#ff9e00", "#b537f2", "#3cf077", "#ff6fd8", "#2ec4b6", "#e8d44d", "#5d7ce8"],
  },
  {
    id: "desert", name: "沙漠越野", price: 300, desc: "大地色硬核越野",
    target: "#c1440e",
    cars: ["#b08968", "#7f5539", "#ddb892", "#9c6644", "#ede0d4", "#6b705c", "#a5a58d", "#b7b7a4"],
  },
  {
    id: "ocean", name: "深海舰队", price: 400, desc: "碧海与珊瑚礁",
    target: "#ff6b6b",
    cars: ["#0077b6", "#00b4d8", "#90e0ef", "#48cae4", "#023e8a", "#f77f00", "#8ecae6", "#219ebc"],
  },
  {
    id: "rainbow", name: "彩虹车队", price: 600, desc: "七彩炫目出道",
    target: "#ff3b3b",
    cars: ["#ff595e", "#ff924c", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#ff70a6", "#70d6ff"],
  },
];

/** 按 id 取皮肤；未知 id（旧存档/异常）回落经典涂装 */
function byId(id) {
  for (let i = 0; i < SKINS.length; i++) {
    if (SKINS[i].id === id) return SKINS[i];
  }
  return SKINS[0];
}

module.exports = { SKINS, byId };
