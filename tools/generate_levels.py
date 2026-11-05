#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""关卡生成与批量导出工具（开发文档 §6）。

策略：手工设计优质关卡（1~10，6x6 教学） + 随机生成候选并用求解器筛选（11~30）。
后期关卡棋盘更大（7x7 / 8x8）并引入禁停区（obstacles，不可通行的格子），
构成 "棋盘变大 + 障碍变多 + par 变高" 的三重难度曲线。

每个导出的关卡都经过：
1. level_validator 合法性校验（越界 / 重叠 / 目标车 / 出口行 / 禁停区）
2. BFS 求解确认可解，parMoves 与 solution 由求解器写入
3. 布局去重（规范化签名，含棋盘尺寸与禁停区）

输出：js/data/levels.json 与 js/data/levels.js（小游戏运行时模块）
"""

import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from level_solver import solve, vehicle_cells
from level_validator import validate_level, validate_structure

SEED = 20261026

# ---------------------------------------------------------------------------
# 手工设计关卡（不含 parMoves/solution，由求解器计算填入）
# 坐标：x=列，y=行，原点左上角。出口：RIGHT / row 2。均为 6x6 教学关。
# ---------------------------------------------------------------------------
HANDCRAFTED = [
    ("初来乍到", [
        ("car_red", 1, 2, 2, "H", True),
        ("car_a", 3, 1, 2, "V", False),
    ]),
    ("小试身手", [
        ("car_red", 0, 2, 2, "H", True),
        ("car_a", 2, 2, 2, "V", False),
        ("car_b", 4, 1, 2, "V", False),
        ("car_c", 0, 5, 2, "H", False),
    ]),
    ("渐入佳境", [
        ("car_red", 1, 2, 2, "H", True),
        ("car_a", 3, 0, 3, "V", False),
        ("car_b", 4, 2, 2, "V", False),
        ("car_c", 0, 0, 2, "V", False),
        ("car_d", 1, 5, 2, "H", False),
    ]),
    ("迂回前进", [
        ("car_red", 2, 2, 2, "H", True),
        ("car_a", 4, 2, 2, "V", False),
        ("car_b", 3, 0, 2, "H", False),
        ("car_c", 4, 4, 2, "V", False),
    ]),
    ("见缝插针", [
        ("car_red", 0, 2, 2, "H", True),
        ("car_a", 2, 1, 3, "V", False),
        ("car_b", 1, 4, 2, "H", False),
        ("car_c", 4, 0, 2, "V", False),
        ("car_d", 4, 3, 2, "H", False),
    ]),
    ("环环相扣", [
        ("car_red", 1, 2, 2, "H", True),
        ("car_a", 3, 2, 2, "V", False),
        ("car_b", 3, 0, 2, "V", False),
        ("car_c", 2, 4, 2, "H", False),
        ("car_d", 5, 2, 2, "V", False),
    ]),
    ("前后呼应", [
        ("car_red", 1, 2, 2, "H", True),
        ("car_a", 3, 0, 3, "V", False),
        ("car_b", 4, 2, 2, "V", False),
        ("car_c", 4, 0, 2, "V", False),
        ("car_d", 3, 4, 2, "H", False),
        ("car_e", 0, 5, 2, "H", False),
    ]),
    ("层层封锁", [
        ("car_red", 0, 2, 2, "H", True),
        ("car_a", 2, 0, 3, "V", False),
        ("car_b", 1, 3, 2, "H", False),
        ("car_c", 3, 2, 2, "V", False),
        ("car_d", 4, 2, 2, "V", False),
        ("car_e", 5, 4, 2, "V", False),
    ]),
    ("曲径通幽", [
        ("car_red", 1, 2, 2, "H", True),
        ("car_a", 3, 1, 2, "V", False),
        ("car_b", 2, 0, 2, "H", False),
        ("car_c", 4, 2, 2, "V", False),
        ("car_d", 4, 0, 2, "V", False),
        ("car_e", 3, 5, 2, "H", False),
        ("car_f", 5, 1, 2, "V", False),
    ]),
    ("车水马龙", [
        ("car_red", 0, 2, 2, "H", True),
        ("car_a", 2, 2, 3, "V", False),
        ("car_b", 1, 0, 2, "H", False),
        ("car_c", 3, 2, 2, "V", False),
        ("car_d", 4, 0, 2, "H", False),
        ("car_e", 5, 2, 2, "V", False),
        ("car_f", 4, 5, 2, "H", False),
        ("car_g", 3, 4, 2, "V", False),
        ("car_h", 1, 5, 2, "H", False),
    ]),
]

GENERATED_TITLES = [
    "街头巷尾", "寸步难行", "移形换位", "左冲右突", "狭路相逢",
    "峰回路转", "步步为营", "进退两难", "水泄不通", "抽丝剥茧",
    "千头万绪", "绝处逢生", "运筹帷幄", "盘根错节", "柳暗花明",
    "此起彼伏", "错综复杂", "困兽犹斗", "步步惊心", "车阵迷踪",
]

# 随机生成分档：(rows, cols, exit_row, par_min, par_max, 数量, 车辆数范围, 禁停区数范围, state_limit)
# 棋盘尺寸与禁停区数量随档位递增，构成后期难度曲线。
BUCKETS = [
    (6, 6, 2, 6, 9, 6, (7, 10), (1, 3), 250000),    # 11~16：标准场 + 禁停区
    (7, 7, 3, 9, 13, 7, (8, 11), (2, 4), 400000),   # 17~23：大型停车场
    (8, 8, 3, 11, 18, 7, (13, 17), (3, 5), 500000),  # 24~30：超大型 + 多禁停区（高密度才有深解）
]


def make_level(level_id, title, vehicles, rows, cols, exit_row, obstacles=None):
    level = {
        "id": level_id,
        "title": title,
        "rows": rows,
        "cols": cols,
        "exit": {"side": "RIGHT", "row": exit_row},
        "targetVehicleId": "car_red",
        "parMoves": 0,  # 由求解器填入
        "vehicles": [
            {
                "id": vid, "x": x, "y": y, "length": length,
                "orientation": o, **({"isTarget": True} if is_target else {}),
            }
            for vid, x, y, length, o, is_target in vehicles
        ],
    }
    if obstacles:
        level["obstacles"] = [list(c) for c in obstacles]
    return level


def signature(level):
    """布局规范化签名，用于去重（忽略车辆 id 命名；含尺寸与禁停区）。"""
    items = sorted(
        (v["x"], v["y"], v["length"], v["orientation"], v["id"] == level["targetVehicleId"])
        for v in level["vehicles"]
    )
    obs = tuple(sorted(tuple(c) for c in level.get("obstacles") or []))
    return (level["rows"], level["cols"], level["exit"]["row"], tuple(items), obs)


def random_layout(rng, rows, cols, exit_row, num_cars, num_obstacles):
    """随机生成一个候选布局：目标车 → 禁停区 → 其余车辆。"""
    grid = [[False] * cols for _ in range(rows)]
    vehicles = []

    def free(x, y, length, o):
        cells = vehicle_cells(x, y, length, o)
        for cx, cy in cells:
            if not (0 <= cx < cols and 0 <= cy < rows) or grid[cy][cx]:
                return False
        return True

    def place(x, y, length, o):
        if not free(x, y, length, o):
            return False
        for cx, cy in vehicle_cells(x, y, length, o):
            grid[cy][cx] = True
        return True

    # 目标车：出口行，长度 2，横向
    tx = rng.randint(0, cols - 3)
    place(tx, exit_row, 2, "H")
    vehicles.append(("car_red", tx, exit_row, 2, "H", True))

    # 禁停区：不放出口行（避免永久封死出库路径），不与车辆重叠
    obstacles = []
    attempts = 0
    while len(obstacles) < num_obstacles and attempts < 100:
        attempts += 1
        ox, oy = rng.randint(0, cols - 1), rng.randint(0, rows - 1)
        if oy == exit_row or grid[oy][ox]:
            continue
        grid[oy][ox] = True
        obstacles.append((ox, oy))

    names = "abcdefghijklmnopqrstuvwxyz"
    attempts = 0
    while len(vehicles) < num_cars and attempts < 600:
        attempts += 1
        o = rng.choice(["H", "V"])
        length = 3 if rng.random() < 0.3 else 2
        if o == "H":
            x, y = rng.randint(0, cols - length), rng.randint(0, rows - 1)
        else:
            x, y = rng.randint(0, cols - 1), rng.randint(0, rows - length)
        if place(x, y, length, o):
            vehicles.append((f"car_{names[len(vehicles)]}", x, y, length, o, False))
    return vehicles, obstacles


def generate_pool(rng, bucket, seen_sigs, max_tries=6000):
    """随机搜索 par 落在档位区间内的可解关卡。"""
    rows, cols, exit_row, par_min, par_max, count, car_range, obs_range, state_limit = bucket
    pool = []
    tries = 0
    while len(pool) < count and tries < max_tries:
        tries += 1
        num_cars = rng.randint(*car_range)
        num_obs = rng.randint(*obs_range)
        vehicles, obstacles = random_layout(rng, rows, cols, exit_row, num_cars, num_obs)
        level = make_level("tmp", "tmp", vehicles, rows, cols, exit_row, obstacles)
        sig = signature(level)
        if sig in seen_sigs:
            continue
        result = solve(level, state_limit=state_limit)
        if result["solvable"] and par_min <= result["parMoves"] <= par_max:
            seen_sigs.add(sig)
            level["parMoves"] = result["parMoves"]
            level["solution"] = result["solution"]
            pool.append(level)
    return pool


def main():
    rng = random.Random(SEED)
    levels = []
    seen_sigs = set()

    # 1) 手工关卡（6x6 教学，无禁停区）：先结构校验，再由求解器填入 parMoves/solution
    print("== 手工设计关卡（6x6）==")
    for i, (title, vehicles) in enumerate(HANDCRAFTED, start=1):
        level = make_level(f"level_{i:03d}", title, vehicles, 6, 6, 2)
        struct_errors = validate_structure(level)
        if struct_errors:
            print(f"[FAIL] {level['id']} {title}: {struct_errors}")
            sys.exit(1)
        result = solve(level)
        if not result["solvable"]:
            print(f"[FAIL] {level['id']} {title}: 关卡不可解")
            sys.exit(1)
        level["parMoves"] = result["parMoves"]
        level["solution"] = result["solution"]
        seen_sigs.add(signature(level))
        levels.append(level)
        print(f"[OK] {level['id']} {title} par={level['parMoves']}")

    # 2) 随机生成关卡：棋盘尺寸/禁停区/par 三重递增
    generated = []
    for bucket in BUCKETS:
        rows, cols, exit_row, par_min, par_max, count = bucket[:6]
        print(f"== 生成 {rows}x{cols} par {par_min}~{par_max} x{count}（禁停区 {bucket[7][0]}~{bucket[7][1]}）==")
        pool = generate_pool(rng, bucket, seen_sigs)
        print(f"   找到 {len(pool)} 个")
        pool.sort(key=lambda l: l["parMoves"])
        generated.extend(pool)
        if len(pool) < count:
            print("   [警告] 数量不足，请调整区间或种子")

    for j, level in enumerate(generated):
        idx = len(HANDCRAFTED) + j + 1
        level["id"] = f"level_{idx:03d}"
        level["title"] = GENERATED_TITLES[j % len(GENERATED_TITLES)]
        levels.append(level)

    # 3) 难度标签（按求解器 parMoves 划分，而非关卡序号）
    for level in levels:
        par = level["parMoves"]
        level["difficulty"] = "easy" if par <= 5 else ("normal" if par <= 9 else "hard")

    # 4) 最终全量校验（结构 + 可解 + solution 重放 + parMoves 一致）
    print("== 最终校验 ==")
    all_ok = True
    for level in levels:
        ok, report = validate_level(level, check_solution=True)
        obs = len(level.get("obstacles") or [])
        print(f"[{'PASS' if ok else 'FAIL'}] {level['id']} 《{level['title']}》 "
              f"{level['rows']}x{level['cols']} par={report.get('parMoves')} "
              f"cars={len(level['vehicles'])} obs={obs}")
        all_ok = all_ok and ok
    if not all_ok:
        print("存在未通过校验的关卡，终止导出。")
        sys.exit(1)

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "levels.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(levels, f, ensure_ascii=False, indent=1)

    # 微信小游戏运行时不支持 require JSON，同步导出 JS 模块供游戏加载
    js_path = os.path.join(out_dir, "levels.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("// 由 tools/generate_levels.py 生成，请勿手工编辑（数据源：levels.json）\n")
        f.write("module.exports = ")
        json.dump(levels, f, ensure_ascii=False, indent=1)
        f.write(";\n")

    print(f"\n已导出 {len(levels)} 个关卡 → {os.path.normpath(out_path)}")
    print(f"                          → {os.path.normpath(js_path)}")


if __name__ == "__main__":
    main()
