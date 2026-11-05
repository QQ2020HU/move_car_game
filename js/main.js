"use strict";
/**
 * 游戏主入口（微信小游戏）。
 * 组装依赖：Analytics / Save / Level / Game / Audio / UI，启动主循环。
 */

const { GameManager } = require("./core/GameManager.js");
const { LevelManager } = require("./level/LevelManager.js");
const { SaveManager } = require("./save/SaveManager.js");
const { AnalyticsManager } = require("./platform/AnalyticsManager.js");
const { AdManager } = require("./platform/AdManager.js");
const { AudioManager } = require("./ui/AudioManager.js");
const { UIManager } = require("./ui/UIManager.js");

function main() {
  const canvas = wx.createCanvas();
  const analytics = new AnalyticsManager({ appVersion: "1.0.0" });
  const saveManager = new SaveManager();
  const levelManager = new LevelManager();
  const gameManager = new GameManager(analytics);
  const audio = new AudioManager(saveManager);
  // 广告：未配置广告位 ID 时自动降级（提示始终免费、无插屏/Banner），
  // 开通流量主后在 AdManager.js 的 AD_UNITS 填入 ID 即生效
  const ads = new AdManager({ analytics });

  const ui = new UIManager(canvas, {
    gameManager,
    levelManager,
    saveManager,
    audio,
    analytics,
    ads,
  });

  // 首屏埋点：进入游戏
  const firstIdx = Math.min(saveManager.data.unlockedLevel, levelManager.count - 1);
  analytics.gameStart(levelManager.getLevel(firstIdx).id);

  // 供调试：挂到全局
  if (typeof GameGlobal !== "undefined") {
    GameGlobal.__game = { ui, gameManager, levelManager, saveManager, analytics, ads };
  }
  return ui;
}

module.exports = { main };
