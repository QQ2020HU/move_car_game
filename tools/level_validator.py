#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""关卡合法性校验器。

检查项（对应开发文档 §4.3 / §6.1）：
1. 结构字段完整、类型正确
2. 车辆越界
3. 车辆重叠
4. 目标车辆缺失 / 目标车不是横向 / 不在出口行
5. 出口行不匹配 / 出口方向不是 RIGHT
6. 关卡 ID、车辆 ID 唯一
7. 可解性（调用 level_solver.solve）
8. solution（若提供）能被引擎逐步重放并胜利，且步数 == parMoves
"""

import sys

from level_solver import solve, apply_solution, vehicle_cells


def validate_structure(level):
    """返回错误列表，空列表表示结构合法。"""
    errors = []

    def require(cond, msg):
        if not cond:
            errors.append(msg)

    require(isinstance(level.get("id"), str) and level["id"], "缺少关卡 id")
    require(isinstance(level.get("title"), str) and level["title"], "缺少关卡 title")
    require(isinstance(level.get("rows"), int) and isinstance(level.get("cols"), int)
            and 6 <= level["rows"] <= 9 and 6 <= level["cols"] <= 9,
            f"棋盘尺寸必须在 6x6 ~ 9x9 之间，当前 {level.get('rows')}x{level.get('cols')}")
    if errors:
        return errors

    exit_info = level.get("exit") or {}
    require(exit_info.get("side") == "RIGHT", "第一版出口方向必须为 RIGHT")
    require(isinstance(exit_info.get("row"), int)
            and 0 <= exit_info["row"] < level["rows"], "出口行不合法")

    vehicles = level.get("vehicles")
    require(isinstance(vehicles, list) and len(vehicles) >= 2, "车辆列表不合法")
    if errors:
        return errors

    rows, cols = level["rows"], level["cols"]
    exit_row = exit_info["row"]

    ids = [v["id"] for v in vehicles]
    require(len(ids) == len(set(ids)), "存在重复的车辆 id")

    target_id = level.get("targetVehicleId")
    require(target_id in ids, f"目标车辆 {target_id} 缺失")

    grid = {}
    for v in vehicles:
        require(v.get("length") in (2, 3), f"{v['id']}: length 必须为 2 或 3")
        require(v.get("orientation") in ("H", "V"), f"{v['id']}: orientation 必须为 H/V")
        if errors:
            continue
        cells = vehicle_cells(v["x"], v["y"], v["length"], v["orientation"])
        for cx, cy in cells:
            if not (0 <= cx < cols and 0 <= cy < rows):
                errors.append(f"{v['id']}: 车辆越界 ({cx},{cy})")
            if (cx, cy) in grid:
                errors.append(f"{v['id']}: 与 {grid[(cx, cy)]} 重叠于 ({cx},{cy})")
            grid[(cx, cy)] = v["id"]

    # 禁停区（障碍物）
    obstacles = level.get("obstacles") or []
    require(isinstance(obstacles, list), "obstacles 必须是列表")
    seen_obs = set()
    for ob in obstacles:
        require(isinstance(ob, (list, tuple)) and len(ob) == 2
                and all(isinstance(n, int) for n in ob), f"禁停区格式非法: {ob}")
        if errors:
            continue
        ox, oy = ob
        require(0 <= ox < cols and 0 <= oy < rows, f"禁停区越界: ({ox},{oy})")
        require((ox, oy) not in seen_obs, f"禁停区重复: ({ox},{oy})")
        seen_obs.add((ox, oy))
        require((ox, oy) not in grid, f"禁停区与车辆 {grid.get((ox, oy))} 重叠于 ({ox},{oy})")

    if target_id in ids:
        target = next(v for v in vehicles if v["id"] == target_id)
        require(target.get("orientation") == "H", "目标车辆必须是横向 (H)")
        require(target.get("y") == exit_row,
                f"目标车辆所在行 {target.get('y')} 与出口行 {exit_row} 不匹配")
        require(target.get("isTarget") is not False, "目标车辆 isTarget 标记异常")

    return errors


def validate_level(level, check_solution=True):
    """完整校验：结构 + 可解性 + 解法重放。返回 (ok, report dict)。"""
    report = {"id": level.get("id"), "errors": []}

    struct_errors = validate_structure(level)
    report["errors"].extend(struct_errors)
    if struct_errors:
        report["ok"] = False
        return False, report

    result = solve(level)
    report["solvable"] = result["solvable"]
    report["parMoves"] = result["parMoves"]
    report["truncated"] = result.get("truncated", False)
    if not result["solvable"]:
        report["errors"].append(
            "关卡不可解" if not result.get("truncated") else "搜索超限，可解性未确认")
        report["ok"] = False
        return False, report

    if level.get("parMoves") != result["parMoves"]:
        report["errors"].append(
            f"parMoves={level['parMoves']} 与求解器结果 {result['parMoves']} 不一致")

    if check_solution and level.get("solution"):
        won, err = apply_solution(level, level["solution"])
        if not won:
            report["errors"].append(f"solution 重放失败: {err}")
        elif len(level["solution"]) != result["parMoves"]:
            report["errors"].append(
                f"solution 步数 {len(level['solution'])} != 最短步数 {result['parMoves']}")

    report["ok"] = not report["errors"]
    return report["ok"], report


if __name__ == "__main__":
    import json

    if len(sys.argv) < 2:
        print("用法: python3 level_validator.py <levels.json 或单个 level.json>")
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    levels = data if isinstance(data, list) else [data]

    all_ok = True
    for lvl in levels:
        ok, rep = validate_level(lvl)
        status = "PASS" if ok else "FAIL"
        extra = f" par={rep.get('parMoves')}" if ok else f" {rep['errors']}"
        print(f"[{status}] {rep['id']}{extra}")
        all_ok = all_ok and ok
    sys.exit(0 if all_ok else 1)
