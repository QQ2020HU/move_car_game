"use strict";
/**
 * SaveManager：本地存档（P0，文档 §8.1）。
 * 微信环境使用 wx.setStorageSync / getStorageSync；
 * Node 环境（单元测试）自动降级为内存存储。
 * 读取时做版本兼容：缺失字段用默认值补齐。
 */

const SAVE_KEY = "traffic_puzzle_save_v1";
const CURRENT_VERSION = 1;

function defaultSave() {
  return {
    version: CURRENT_VERSION,
    unlockedLevel: 0, // 已解锁的最大关卡索引（0 = 只有第一关）
    levelStars: {},   // levelId -> 1~3
    bestMoves: {},    // levelId -> 最少步数
    bestTimeMs: {},   // levelId -> 最快用时
    chaptersSeen: {}, // chapterKey -> true（章节过场卡片只首次展示）
    soundEnabled: true,
    bgmEnabled: true,   // 背景音乐开关（独立于音效，🎵 按钮切换）
    coins: 0,         // 金币（通关奖励 星数×10，可看激励视频翻倍；商店消费：皮肤/复活）
    ownedSkins: ["classic"], // 已拥有的涂装皮肤 id（classic 永久免费）
    equippedSkin: "classic", // 当前装备的皮肤 id
  };
}

class SaveManager {
  constructor(storage) {
    // storage: {get(key), set(key, value)}；缺省按平台选择
    if (storage) {
      this.storage = storage;
    } else if (typeof wx !== "undefined" && wx.getStorageSync) {
      this.storage = {
        get(key) {
          try { return wx.getStorageSync(key); } catch (e) { return null; }
        },
        set(key, value) {
          try { wx.setStorageSync(key, value); } catch (e) { /* 存储失败不致命 */ }
        },
      };
    } else {
      const mem = {};
      this.storage = {
        get(key) { return mem[key] || null; },
        set(key, value) { mem[key] = value; },
      };
    }
    this.data = this.load();
  }

  load() {
    const raw = this.storage.get(SAVE_KEY);
    const base = defaultSave();
    if (!raw) return base;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      // 版本兼容：合并默认值，忽略未知版本破坏性字段
      const merged = Object.assign(base, parsed, {
        levelStars: Object.assign({}, base.levelStars, parsed.levelStars || {}),
        bestMoves: Object.assign({}, base.bestMoves, parsed.bestMoves || {}),
        bestTimeMs: Object.assign({}, base.bestTimeMs, parsed.bestTimeMs || {}),
        chaptersSeen: Object.assign({}, base.chaptersSeen, parsed.chaptersSeen || {}),
        version: CURRENT_VERSION,
      });
      // 皮肤字段兼容：旧存档无 ownedSkins/equippedSkin 时补默认；数组去重且保证 classic 常驻
      if (!Array.isArray(merged.ownedSkins)) merged.ownedSkins = ["classic"];
      if (merged.ownedSkins.indexOf("classic") === -1) merged.ownedSkins.unshift("classic");
      if (typeof merged.equippedSkin !== "string" || merged.ownedSkins.indexOf(merged.equippedSkin) === -1) {
        merged.equippedSkin = "classic";
      }
      return merged;
    } catch (e) {
      console.warn("[SaveManager] 存档损坏，已重置:", e);
      return base;
    }
  }

  persist() {
    this.storage.set(SAVE_KEY, JSON.stringify(this.data));
  }

  getStars(levelId) {
    return this.data.levelStars[levelId] || 0;
  }

  isUnlocked(index) {
    return index <= this.data.unlockedLevel;
  }

  /** 通关后更新存档：星级取历史最高，步数/用时取历史最佳 */
  recordWin(levelId, levelIndex, stars, moves, timeMs) {
    const d = this.data;
    d.levelStars[levelId] = Math.max(d.levelStars[levelId] || 0, stars);
    if (!d.bestMoves[levelId] || moves < d.bestMoves[levelId]) d.bestMoves[levelId] = moves;
    if (!d.bestTimeMs[levelId] || timeMs < d.bestTimeMs[levelId]) d.bestTimeMs[levelId] = timeMs;
    if (levelIndex + 1 > d.unlockedLevel) d.unlockedLevel = levelIndex + 1;
    this.persist();
  }

  setSoundEnabled(on) {
    this.data.soundEnabled = !!on;
    this.persist();
  }

  setBgmEnabled(on) {
    this.data.bgmEnabled = !!on;
    this.persist();
  }

  /** 金币入账（通关奖励/视频翻倍）；返回最新余额。旧存档缺字段按 0 处理 */
  addCoins(n) {
    this.data.coins = Math.max(0, (this.data.coins || 0) + (n || 0));
    this.persist();
    return this.data.coins;
  }

  /** 金币消费（商店皮肤/金币复活）；余额不足返回 false，不扣款 */
  spendCoins(n) {
    const cost = Math.max(0, Math.floor(n || 0));
    if ((this.data.coins || 0) < cost) return false;
    this.data.coins -= cost;
    this.persist();
    return true;
  }

  /** 是否已拥有某涂装皮肤（classic 恒为 true） */
  ownsSkin(id) {
    return (this.data.ownedSkins || []).indexOf(id) !== -1;
  }

  /**
   * 购买皮肤：成功扣款并自动装备。
   * 返回 "ok"（购买成功）/ "owned"（已拥有，不重复扣款）/ "poor"（金币不足）。
   */
  purchaseSkin(id, price) {
    if (!id || id === "classic" || this.ownsSkin(id)) return "owned";
    if (!this.spendCoins(price)) return "poor";
    this.data.ownedSkins.push(id);
    this.data.equippedSkin = id;
    this.persist();
    return "ok";
  }

  /** 装备已拥有的皮肤；未拥有返回 false */
  equipSkin(id) {
    if (!this.ownsSkin(id)) return false;
    this.data.equippedSkin = id;
    this.persist();
    return true;
  }

  /** 标记章节过场已展示；返回是否首次（首次才弹章节卡片） */
  markChapterSeen(key) {
    if (this.data.chaptersSeen[key]) return false;
    this.data.chaptersSeen[key] = true;
    this.persist();
    return true;
  }

  totalStars() {
    let sum = 0;
    for (const k in this.data.levelStars) sum += this.data.levelStars[k];
    return sum;
  }
}

module.exports = { SaveManager, SAVE_KEY, defaultSave };
