"use strict";
/**
 * 游戏状态机（开发文档 §3.3）。
 * LOADING → READY → PLAYING ⇄ ANIMATING → WIN / FAIL
 * PLAYING ⇄ PAUSED；FAIL → PLAYING（复活）；任意状态可回到 LOADING / READY（重开、切关）。
 */

const GameState = {
  LOADING: "LOADING",
  READY: "READY",
  PLAYING: "PLAYING",
  ANIMATING: "ANIMATING",
  WIN: "WIN",
  FAIL: "FAIL",
  PAUSED: "PAUSED",
};

const TRANSITIONS = {
  LOADING: ["READY"],
  READY: ["PLAYING", "PAUSED", "LOADING"],
  PLAYING: ["ANIMATING", "PAUSED", "READY", "LOADING"],
  ANIMATING: ["PLAYING", "WIN", "FAIL", "READY", "LOADING"],
  WIN: ["READY", "LOADING"],
  FAIL: ["PLAYING", "READY", "LOADING"], // 复活 → PLAYING；重开/切关 → LOADING/READY
  PAUSED: ["PLAYING", "READY", "LOADING"],
};

class StateMachine {
  constructor(onChange) {
    this.state = GameState.LOADING;
    this.onChange = onChange || null;
  }

  canTransition(next) {
    const allowed = TRANSITIONS[this.state] || [];
    return allowed.indexOf(next) !== -1;
  }

  set(next) {
    if (this.state === next) return true;
    if (!this.canTransition(next)) {
      console.warn(`[StateMachine] 非法状态切换 ${this.state} -> ${next}`);
      return false;
    }
    const prev = this.state;
    this.state = next;
    if (this.onChange) this.onChange(next, prev);
    return true;
  }

  isPlaying() {
    return this.state === GameState.PLAYING;
  }
}

module.exports = { GameState, StateMachine };
