"use strict";
/**
 * AnalyticsManager：关键事件记录（P1，文档 §8.2）。
 * 第一版写本地日志（console），正式测试时再替换为合规上报方案。
 */

class AnalyticsManager {
  constructor(options) {
    options = options || {};
    this.appVersion = options.appVersion || "1.0.0";
    this.silent = !!options.silent;
    this.buffer = []; // 本地日志缓冲，便于测试断言
    this.sessionStart = Date.now();
    this.currentLevel = null;
  }

  track(event, params) {
    const record = Object.assign(
      { event, ts: Date.now(), version: this.appVersion },
      params || {}
    );
    this.buffer.push(record);
    if (this.buffer.length > 500) this.buffer.shift();
    if (!this.silent) {
      console.log("[analytics]", event, JSON.stringify(params || {}));
    }
  }

  gameStart(levelId) {
    this.currentLevel = levelId;
    this.track("game_start", { levelId });
  }

  setLevel(levelId) {
    this.currentLevel = levelId;
  }

  gameExit() {
    this.track("game_exit", {
      currentLevel: this.currentLevel,
      sessionMs: Date.now() - this.sessionStart,
    });
  }
}

module.exports = { AnalyticsManager };
