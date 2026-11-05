#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""碰撞与占格检测测试（开发文档 §9 tests/test_collision.py）。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))

from level_solver import vehicle_cells, build_grid, generate_moves, apply_solution


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


class TestVehicleCells(unittest.TestCase):
    def test_horizontal(self):
        self.assertEqual(vehicle_cells(1, 2, 2, "H"), [(1, 2), (2, 2)])
        self.assertEqual(vehicle_cells(0, 0, 3, "H"), [(0, 0), (1, 0), (2, 0)])

    def test_vertical(self):
        self.assertEqual(vehicle_cells(3, 1, 2, "V"), [(3, 1), (3, 2)])
        self.assertEqual(vehicle_cells(5, 3, 3, "V"), [(5, 3), (5, 4), (5, 5)])


class TestBuildGrid(unittest.TestCase):
    def test_occupancy(self):
        level = make_level([v("red", 1, 2, 2, "H", True), v("a", 3, 0, 2, "V")])
        pos = {"red": (1, 2), "a": (3, 0)}
        grid = build_grid(level, pos)
        self.assertEqual(grid[2][1], "red")
        self.assertEqual(grid[2][2], "red")
        self.assertEqual(grid[0][3], "a")
        self.assertEqual(grid[1][3], "a")
        self.assertIsNone(grid[5][5])


class TestGenerateMoves(unittest.TestCase):
    def positions(self, level):
        return {x["id"]: (x["x"], x["y"]) for x in level["vehicles"]}

    def test_blocking_prevents_pass_through(self):
        """文档 §5.2：不能只检查终点，整段路径被挡则不可移动。"""
        # red H 在 (0,2)-(1,2)，a V 在 (3,2)-(3,3) 挡路，b H 在 (5,2)? 越界不行。
        # red 向右最多到 x=1（占 1,2 -> 车头至 2），因为 (3,2) 被 a 占据。
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 2, 2, "V")])
        moves = generate_moves(level, self.positions(level))
        red_rights = sorted(d for vid, d, ex in moves if vid == "red" and d > 0 and not ex)
        self.assertEqual(red_rights, [1])  # 只能右移 1 格到 x=1（占 1,2 与 2,2）
        # 不允许出库（路径被挡）
        self.assertFalse(any(ex for vid, d, ex in moves if vid == "red"))

    def test_exit_move_available(self):
        level = make_level([v("red", 3, 2, 2, "H", True)])
        moves = generate_moves(level, self.positions(level))
        exits = [(d, ex) for vid, d, ex in moves if vid == "red" and ex]
        self.assertEqual(exits, [(3, True)])  # delta = cols - x = 3，出库

    def test_non_target_cannot_exit(self):
        # a 是横向车在出口行但不是目标车，即使右侧畅通也不能出库
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 2, 2, "H")])
        moves = generate_moves(level, self.positions(level))
        self.assertFalse(any(ex for vid, d, ex in moves if vid == "a"))
        a_moves = [(d, ex) for vid, d, ex in moves if vid == "a"]
        self.assertIn((1, False), a_moves)   # a 可以右移 1 到 x=4（占 4,5）
        self.assertNotIn((2, False), a_moves)  # 不能越界

    def test_vertical_limits(self):
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 1, 3, "V")])
        moves = generate_moves(level, self.positions(level))
        a_moves = sorted(d for vid, d, ex in moves if vid == "a")
        # a V 长3 在 y=1（占行1,2,3）：上移最多1（y=0），下移最多2（y=3）
        self.assertEqual(a_moves, [-1, 1, 2])

    def test_no_move_when_blocked_both_sides(self):
        # a V(3,1) 长2：上方被 c 挡、下方被 b 挡，完全无法移动
        level = make_level([
            v("red", 0, 2, 2, "H", True),
            v("a", 3, 1, 2, "V"),
            v("b", 3, 3, 2, "V"),
            v("c", 2, 0, 2, "H"),  # 占 (2,0)(3,0)，堵住 a 的上方
        ])
        moves = generate_moves(level, self.positions(level))
        self.assertEqual([m for m in moves if m[0] == "a"], [])


class TestApplySolution(unittest.TestCase):
    def test_reject_overlap(self):
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 2, 2, "V")])
        ok, err = apply_solution(level, [{"vehicleId": "red", "delta": 3}])
        self.assertFalse(ok)
        self.assertIn("阻挡", err)

    def test_reject_out_of_board(self):
        level = make_level([v("red", 0, 2, 2, "H", True)])
        ok, err = apply_solution(level, [{"vehicleId": "red", "delta": -1}])
        self.assertFalse(ok)

    def test_valid_exit(self):
        level = make_level([v("red", 3, 2, 2, "H", True)])
        ok, err = apply_solution(level, [{"vehicleId": "red", "delta": 3}])
        self.assertTrue(ok, err)

    def test_reject_wrong_row_exit(self):
        # 非目标车驶出应被拒绝；目标车不在出口行不能出库
        level = make_level([v("red", 0, 2, 2, "H", True), v("a", 3, 0, 2, "H")], exit_row=2)
        ok, err = apply_solution(level, [{"vehicleId": "a", "delta": 3}])
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
