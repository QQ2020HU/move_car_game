"use strict";
/**
 * LevelManager：读取关卡数据、按序号取关（P0）。
 * 关卡数据由 tools/generate_levels.py 生成并全量校验。
 * 注意：微信小游戏运行时不支持 require JSON，故使用 levels.js 模块
 * （levels.json 为 Python 工具链的数据源，两者由生成器同步导出）。
 */

const LEVELS = require("../data/levels.js");

class LevelManager {
  constructor() {
    this.levels = LEVELS;
  }

  get count() {
    return this.levels.length;
  }

  /** index 从 0 开始 */
  getLevel(index) {
    if (index < 0 || index >= this.levels.length) return null;
    return this.levels[index];
  }

  findById(id) {
    for (const l of this.levels) if (l.id === id) return l;
    return null;
  }

  indexOf(id) {
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i].id === id) return i;
    }
    return -1;
  }
}

module.exports = { LevelManager };
