#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""求解器与关卡数据测试（开发文档 §9 tests/test_solver.py）。"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

from level_solver import solve, apply_solution, vehicle_cells
from level_validator import validate_level, validate_structure

LEVELS_PATH = os.path.join(HERE, "..", "js", "data", "levels.json")


def make_level(vehicles, exit_row=2):
    return {
        "id": "t", "title": "t", "rows": 6, "cols": 6,
        "exit": {"side": "RIGHT", "row": exit_row},
        "targetVehicleId": "red",
        "parMoves": 1,
        "vehicles": vehicles,
    }


def v(vid, x, y, length, o, target=False):
    d = {"id": vid, "x": x, "y": y, "length": length, "orientation": o}
    if target:
        d["isTarget"] = True
    return d


class TestSolver(unittest.TestCase):
    def test_trivial_one_move(self):
        level = make_level([v("red", 4, 2, 2, "H", True)])
        r = solve(level)
        self.assertTrue(r["solvable"])
        self.assertEqual(r["parMoves"], 1)

    def test_two_moves(self):
        level = make_level([v("red", 1, 2, 2, "H", True), v("a", 3, 1, 2, "V")])
        r = solve(level)
        self.assertTrue(r["solvable"])
        self.assertEqual(r["parMoves"], 2)
        won, err = apply_solution(level, r["solution"])
        self.assertTrue(won, err)

    def test_unsolvable(self):
        # a V 长3 卡在 col3 行0-2，上方无处可去（已到顶），下方 b 长3 堵死 col3 行3-5
        level = make_level([
            v("red", 0, 2, 2, "H", True),
            v("a", 3, 0, 3, "V"),
            v("b", 3, 3, 3, "V"),
        ])
        r = solve(level)
        self.assertFalse(r["solvable"])

    def test_move_count_definition(self):
        """一次拖动多格 = 一步（文档 §6.2）。"""
        # red 从 x=0 直接出库，应记 1 步而非 4 步
        level = make_level([v("red", 0, 2, 2, "H", True)])
        r = solve(level)
        self.assertEqual(r["parMoves"], 1)
        self.assertEqual(len(r["solution"]), 1)

    def test_optimality_requires_chain(self):
        # c 挡住 b，b 挡住 red：需要先移 c 再移 b
        level = make_level([
            v("red", 0, 2, 2, "H", True),
            v("b", 3, 2, 2, "V"),   # 占 (3,2)(3,3)
            v("c", 3, 4, 2, "V"),   # 占 (3,4)(3,5)，b 无法下移
        ])
        r = solve(level)
        self.assertTrue(r["solvable"])
        # b 只能上移；b 上移到行0-1 需要 (3,0)(3,1) 为空 → 直接可行，共 2 步
        self.assertEqual(r["parMoves"], 2)
        won, err = apply_solution(level, r["solution"])
        self.assertTrue(won, err)


class TestValidator(unittest.TestCase):
    def test_detects_overlap(self):
        level = make_level([v("red", 1, 2, 2, "H", True), v("a", 2, 2, 2, "V")])
        errors = validate_structure(level)
        self.assertTrue(any("重叠" in e for e in errors))

    def test_detects_out_of_board(self):
        level = make_level([v("red", 5, 2, 2, "H", True), v("a", 0, 0, 2, "V")])
        errors = validate_structure(level)
        self.assertTrue(any("越界" in e for e in errors))

    def test_detects_missing_target(self):
        level = make_level([v("a", 0, 0, 2, "V"), v("b", 2, 0, 2, "V")])
        level["targetVehicleId"] = "red"
        errors = validate_structure(level)
        self.assertTrue(any("缺失" in e for e in errors))

    def test_detects_target_row_mismatch(self):
        level = make_level([v("red", 0, 3, 2, "H", True), v("a", 4, 0, 2, "V")])
        errors = validate_structure(level)
        self.assertTrue(any("出口行" in e for e in errors))

    def test_detects_vertical_target(self):
        level = make_level([v("red", 0, 2, 2, "V", True), v("a", 4, 0, 2, "V")])
        errors = validate_structure(level)
        self.assertTrue(any("横向" in e for e in errors))


class TestObstacles(unittest.TestCase):
    """禁停区（obstacles）规则。"""

    def test_obstacle_on_exit_row_blocks_exit(self):
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 4, 0, 2, "V")])
        level["obstacles"] = [[2, 2]]
        r = solve(level)
        self.assertFalse(r["solvable"], "出口行被禁停区封死应不可解")

    def test_obstacle_off_exit_row_keeps_solvable(self):
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 0, 2, "V")])
        level["obstacles"] = [[3, 4]]
        r = solve(level)
        self.assertTrue(r["solvable"])
        self.assertEqual(r["parMoves"], 1)
        won, err = apply_solution(level, r["solution"])
        self.assertTrue(won, err)

    def test_obstacle_blocks_vehicle_movement(self):
        # car_a V (3,1)-(3,2)，(3,3) 为禁停区 → 不能向下移动
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 1, 2, "V")])
        level["obstacles"] = [[3, 3]]
        from level_solver import generate_moves
        positions = {"red": (0, 2), "a": (3, 1)}
        moves = generate_moves(level, positions)
        a_moves = [(vid, d) for vid, d, _ in moves if vid == "a"]
        self.assertIn(("a", -1), a_moves, "向上应可移动")
        self.assertNotIn(("a", 1), a_moves, "向下被禁停区阻挡")
        self.assertNotIn(("a", 2), a_moves)

    def test_validator_rejects_obstacle_overlap_and_out_of_board(self):
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 1, 2, "V")])
        level["obstacles"] = [[3, 1]]
        errors = validate_structure(level)
        self.assertTrue(any("重叠" in e for e in errors))
        level["obstacles"] = [[6, 0]]
        errors = validate_structure(level)
        self.assertTrue(any("越界" in e for e in errors))


class TestShippedLevels(unittest.TestCase):
    """对导出的 levels.json 全量验收。"""

    @classmethod
    def setUpClass(cls):
        with open(LEVELS_PATH, encoding="utf-8") as f:
            cls.levels = json.load(f)

    def test_level_count(self):
        self.assertGreaterEqual(len(self.levels), 20)
        self.assertLessEqual(len(self.levels), 30)

    def test_ids_unique_and_ordered(self):
        ids = [l["id"] for l in self.levels]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids, sorted(ids))

    def test_all_levels_valid_and_solvable(self):
        for level in self.levels:
            ok, report = validate_level(level, check_solution=True)
            self.assertTrue(ok, f"{level['id']}: {report['errors']}")

    def test_solution_replay_wins(self):
        for level in self.levels:
            won, err = apply_solution(level, level["solution"])
            self.assertTrue(won, f"{level['id']}: {err}")
            self.assertEqual(len(level["solution"]), level["parMoves"])

    def test_difficulty_curve_non_decreasing(self):
        pars = [l["parMoves"] for l in self.levels]
        # 前 10 关（新手）par 应较小，整体趋势不减
        self.assertLessEqual(max(pars[:10]), 6)
        self.assertGreaterEqual(pars[-1], pars[0])
        # 允许小幅波动，但不允许后期出现比前期最小值还低的关
        self.assertGreaterEqual(min(pars[20:]), max(pars[:5]))

    def test_no_duplicate_layouts(self):
        sigs = set()
        for level in self.levels:
            sig = tuple(sorted(
                (x["x"], x["y"], x["length"], x["orientation"], x["id"] == level["targetVehicleId"])
                for x in level["vehicles"]
            ))
            self.assertNotIn(sig, sigs, f"{level['id']} 布局重复")
            sigs.add(sig)

    def test_required_fields(self):
        for level in self.levels:
            for key in ("id", "title", "rows", "cols", "exit", "targetVehicleId",
                        "parMoves", "vehicles", "solution"):
                self.assertIn(key, level, f"{level.get('id')} 缺字段 {key}")
            self.assertIn(level["rows"], (6, 7, 8))
            self.assertEqual(level["rows"], level["cols"], "棋盘应为正方形")
            self.assertEqual(level["exit"]["side"], "RIGHT")
            self.assertLess(level["exit"]["row"], level["rows"])

    def test_board_size_grows_with_progression(self):
        """后期关卡棋盘更大（6x6 → 7x7 → 8x8），且尺寸不回落。"""
        sizes = [l["rows"] for l in self.levels]
        self.assertEqual(sizes[0], 6, "第 1 关应为 6x6 教学")
        self.assertGreaterEqual(max(sizes), 7, "应存在更大的棋盘")
        for a, b in zip(sizes, sizes[1:]):
            self.assertGreaterEqual(b, a, "棋盘尺寸不应随关卡回落")

    def test_obstacles_present_and_valid(self):
        """后期关卡引入禁停区；禁停区不得与车辆重叠、不得越界。"""
        has_obs = [l for l in self.levels if l.get("obstacles")]
        self.assertGreaterEqual(len(has_obs), 5, "应有足够多的禁停区关卡")
        for level in has_obs:
            occupied = set()
            for v in level["vehicles"]:
                occupied.update(vehicle_cells(v["x"], v["y"], v["length"], v["orientation"]))
            seen = set()
            for ob in level["obstacles"]:
                ox, oy = tuple(ob)
                self.assertTrue(0 <= ox < level["cols"] and 0 <= oy < level["rows"],
                                f"{level['id']}: 禁停区越界 {ob}")
                self.assertNotIn((ox, oy), occupied, f"{level['id']}: 禁停区与车辆重叠 {ob}")
                self.assertNotIn((ox, oy), seen, f"{level['id']}: 禁停区重复 {ob}")
                seen.add((ox, oy))
            # 出口行不允许禁停（否则会永久封死出库路径，虽然求解器也会拒绝）
            self.assertTrue(all(oy != level["exit"]["row"] for _, oy in seen),
                            f"{level['id']}: 禁停区不应位于出口行")


if __name__ == "__main__":
    unittest.main(verbosity=2)
