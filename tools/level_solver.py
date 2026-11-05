#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""滑块挪车解谜求解器（BFS 最少步数）。

规则与游戏引擎保持一致：
- 棋盘 rows x cols（默认 6x6），坐标原点在左上角。
- 每辆车占 length(2|3) 个连续格子，H 横向 / V 纵向。
- 车辆只能沿自身方向移动，不能重叠、不能越界（目标车出库除外）。
- 一次移动 = 任选一辆车沿其轴向拖动任意格数（一次拖动记一步）。
- 目标车位于出口行且右侧路径畅通时，可向右驶出棋盘，即胜利（计一步）。

solve() 返回 {"solvable": bool, "parMoves": int|None, "solution": [...]|None}
solution 为按顺序执行的 [{"vehicleId": str, "delta": int}, ...]。
"""

from collections import deque

DEFAULT_STATE_LIMIT = 500000

# 禁停区（障碍物）在网格中的标记：不可通行、不可停留
OBSTACLE = "#"


def vehicle_cells(x, y, length, orientation):
    """返回车辆占据的格子列表 [(cx, cy), ...]。"""
    if orientation == "H":
        return [(x + i, y) for i in range(length)]
    return [(x, y + i) for i in range(length)]


def build_grid(level, positions):
    """根据车辆位置构建占用网格，grid[row][col] = vehicle_id / "#"（禁停区）/ None。"""
    rows, cols = level["rows"], level["cols"]
    grid = [[None] * cols for _ in range(rows)]
    for ox, oy in level.get("obstacles") or []:
        if 0 <= ox < cols and 0 <= oy < rows:
            grid[oy][ox] = OBSTACLE
    for v in level["vehicles"]:
        x, y = positions[v["id"]]
        for cx, cy in vehicle_cells(x, y, v["length"], v["orientation"]):
            if 0 <= cx < cols and 0 <= cy < rows:
                grid[cy][cx] = v["id"]
    return grid


def generate_moves(level, positions):
    """枚举当前状态下所有合法移动。

    返回 [(vehicle_id, delta, is_exit), ...]，is_exit 表示目标车驶出棋盘的终结移动。
    """
    rows, cols = level["rows"], level["cols"]
    exit_row = level["exit"]["row"]
    target_id = level["targetVehicleId"]
    meta = {v["id"]: v for v in level["vehicles"]}
    grid = build_grid(level, positions)
    moves = []

    for vid, v in meta.items():
        x, y = positions[vid]
        length = v["length"]
        if v["orientation"] == "H":
            # 向左：new_x 最小可到 lo
            lo = x
            while lo - 1 >= 0 and grid[y][lo - 1] is None:
                lo -= 1
            for d in range(lo - x, 0):
                moves.append((vid, d, False))
            # 向右：车头最远可到 hi-1（hi 为第一个障碍或边界）
            hi = x + length
            while hi < cols and grid[y][hi] is None:
                hi += 1
            for d in range(1, hi - (x + length) + 1):
                moves.append((vid, d, False))
            # 目标车出库：出口行且右侧棋盘内路径畅通
            if vid == target_id and y == exit_row:
                if all(grid[y][c] is None for c in range(x + length, cols)):
                    moves.append((vid, cols - x, True))
        else:
            # 向上
            lo = y
            while lo - 1 >= 0 and grid[lo - 1][x] is None:
                lo -= 1
            for d in range(lo - y, 0):
                moves.append((vid, d, False))
            # 向下
            hi = y + length
            while hi < rows and grid[hi][x] is None:
                hi += 1
            for d in range(1, hi - (y + length) + 1):
                moves.append((vid, d, False))
    return moves


def solve(level, state_limit=DEFAULT_STATE_LIMIT):
    """BFS 求最少步数解法。达到 state_limit 视为未确认（solvable=False, truncated=True）。"""
    vehicles = level["vehicles"]
    ids = [v["id"] for v in vehicles]
    index = {vid: i for i, vid in enumerate(ids)}
    start = tuple((v["x"], v["y"]) for v in vehicles)

    queue = deque([(start, ())])
    seen = {start}
    truncated = False

    while queue:
        if len(seen) > state_limit:
            truncated = True
            break
        state, sol = queue.popleft()
        positions = {ids[i]: state[i] for i in range(len(ids))}
        for vid, delta, is_exit in generate_moves(level, positions):
            new_sol = sol + ((vid, delta),)
            if is_exit:
                return {
                    "solvable": True,
                    "parMoves": len(new_sol),
                    "solution": [
                        {"vehicleId": v, "delta": d} for v, d in new_sol
                    ],
                    "truncated": False,
                }
            i = index[vid]
            x, y = state[i]
            if level["vehicles"][i]["orientation"] == "H":
                new_pos = (x + delta, y)
            else:
                new_pos = (x, y + delta)
            new_state = list(state)
            new_state[i] = new_pos
            new_state = tuple(new_state)
            if new_state not in seen:
                seen.add(new_state)
                queue.append((new_state, new_sol))

    return {
        "solvable": False,
        "parMoves": None,
        "solution": None,
        "truncated": truncated,
        "statesExplored": len(seen),
    }


def apply_solution(level, solution):
    """按顺序执行解法，返回 (是否胜利, 出错信息)。供校验和测试使用。"""
    positions = {v["id"]: (v["x"], v["y"]) for v in level["vehicles"]}
    meta = {v["id"]: v for v in level["vehicles"]}
    rows, cols = level["rows"], level["cols"]
    target_id = level["targetVehicleId"]
    exit_row = level["exit"]["row"]

    for step, move in enumerate(solution):
        vid, delta = move["vehicleId"], move["delta"]
        if vid not in meta or delta == 0:
            return False, f"step {step}: 非法移动 {move}"
        v = meta[vid]
        x, y = positions[vid]
        grid = build_grid(level, positions)
        if v["orientation"] == "H":
            new_x = x + delta
            # 新占格：越出右边界的格子仅目标车在出口行允许（即出库）
            cells = []
            for k in range(v["length"]):
                cx = new_x + k
                if cx >= cols:
                    if not (vid == target_id and y == exit_row):
                        return False, f"step {step}: {vid} 非法越出右边界"
                    continue
                if cx < 0:
                    return False, f"step {step}: {vid} 越出左边界"
                cells.append((cx, y))
            # 整段路径检查：扫过的格子必须为空
            if delta > 0:
                swept = [(c, y) for c in range(x + v["length"], new_x + v["length"])]
            else:
                swept = [(c, y) for c in range(new_x, x)]
            for cx, cy in swept:
                if cx < 0 or cx >= cols:
                    continue  # 出库路径的界外部分已在上文校验
                if grid[cy][cx] not in (None, vid):
                    return False, f"step {step}: {vid} 路径被 {grid[cy][cx]} 阻挡"
            for cx, cy in cells:
                if grid[cy][cx] not in (None, vid):
                    return False, f"step {step}: {vid} 终点与 {grid[cy][cx]} 重叠"
            positions[vid] = (new_x, y)
        else:
            new_y = y + delta
            if new_y < 0 or new_y + v["length"] > rows:
                return False, f"step {step}: {vid} 越出上下边界"
            if delta > 0:
                swept = [(x, r) for r in range(y + v["length"], new_y + v["length"])]
            else:
                swept = [(x, r) for r in range(new_y, y)]
            for cx, cy in swept:
                if grid[cy][cx] not in (None, vid):
                    return False, f"step {step}: {vid} 路径被 {grid[cy][cx]} 阻挡"
            positions[vid] = (x, new_y)

        # 胜利判定：目标车驶出右边界
        tx, ty = positions[target_id]
        if tx + meta[target_id]["length"] > cols and ty == exit_row:
            if step != len(solution) - 1:
                return False, f"step {step}: 目标车已出库但解法未结束"
            return True, None

    return False, "解法执行完毕但目标车未出库"


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print("用法: python3 level_solver.py <level.json>")
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        lvl = json.load(f)
    result = solve(lvl)
    print(json.dumps(result, ensure_ascii=False, indent=2))
