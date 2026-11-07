#!/usr/bin/env python3
"""
PlaytestLoop CLI Orchestrator (Python 3.11 + Node/Playwright Harness Bridge)
Usage:
  python run.py --prompt "A 2D platformer with high-speed dash, coins, spikes, and an exit gate"
  python run.py --seeded-bug B1_TUNNELING
  python run.py --eval
"""

from __future__ import annotations
import argparse
import asyncio
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


def init_sqlite_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS loop_runs (
            run_id TEXT PRIMARY KEY,
            prompt TEXT,
            seeded_bug_id TEXT,
            verified INTEGER,
            iterations_used INTEGER,
            bugs_found INTEGER,
            bugs_fixed INTEGER,
            tokens_cost INTEGER,
            report_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    conn.close()


def save_run_to_sqlite(db_path: Path, report: dict) -> None:
    init_sqlite_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT OR REPLACE INTO loop_runs
        (run_id, prompt, seeded_bug_id, verified, iterations_used, bugs_found, bugs_fixed, tokens_cost, report_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            report["runId"],
            report["prompt"],
            report.get("seededBugId") or "",
            1 if report["verified"] else 0,
            report["iterationsUsed"],
            report["totalBugsFound"],
            report["totalBugsFixed"],
            report["totalTokensCost"],
            json.dumps(report),
        ),
    )
    conn.commit()
    conn.close()


async def run_cli() -> int:
    parser = argparse.ArgumentParser(description="PlaytestLoop — Closed-Loop 2D Game Synthesis & Verification")
    parser.add_argument("--prompt", type=str, default="Create a 2D platformer with dash, solid walls, coins, hazards, and exit goal.", help="Natural-language game idea")
    parser.add_argument("--seeded-bug", type=str, default="", help="Optional seeded bug ID (B1_TUNNELING, B2_UNWIRED_INPUT, B3_SCORE_STUCK, B4_UNREACHABLE_GOAL, B5_SOFTLOCK)")
    parser.add_argument("--max-iters", type=int, default=8, help="Max closed-loop repair iterations")
    parser.add_argument("--eval", action="store_true", help="Run full 5-Seeded-Bug + Known-Good + 10-Prompt evaluation benchmark")
    parser.add_argument("--out-dir", type=str, default="runs", help="Directory for JSON/Markdown/SQLite output")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.eval:
        cmd = [
            "npx",
            "--yes",
            "tsx",
            "-e",
            "import { runFullEvaluationSuite } from './src/engine/loopController'; console.log(JSON.stringify(runFullEvaluationSuite(), null, 2));",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        metrics = json.loads(proc.stdout)
        (out_dir / "eval_metrics.json").write_text(json.dumps(metrics, indent=2))
        print("=== PLAYTESTLOOP EVALUATION METRICS ===")
        print(f"1. Seeded-Bug Detection Recall (5 bugs): {metrics['seededBugRecall'] * 100:.1f}%")
        print(f"2. False-Positive Rate (Known-Good Game): {metrics['knownGoodFalsePositiveRate'] * 100:.1f}% ({metrics['knownGoodAssertionsChecked']} assertions)")
        print(f"3. 10-Prompt Success Rate:               {metrics['promptBenchmarkSuccessRate'] * 100:.1f}% (Avg Iters: {metrics['avgIterationsToVerified']})")
        print(f"4. Patch Regression Rate:                {metrics['regressionRate'] * 100:.1f}%")
        print(f"5. Avg Token Cost / Verified Game:       {metrics['avgTokensPerVerifiedGame']} tokens")
        return 0

    js_payload = json.dumps(
        {
            "prompt": args.prompt,
            "seededBugId": args.seeded_bug if args.seeded_bug else None,
            "maxIterations": args.max_iters,
        }
    )
    cmd = [
        "npx",
        "--yes",
        "tsx",
        "-e",
        f"import {{ runPlaytestLoop }} from './src/engine/loopController'; console.log(JSON.stringify(runPlaytestLoop({js_payload})));",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    report = json.loads(proc.stdout)

    save_run_to_sqlite(out_dir / "playtest_runs.sqlite", report)
    (out_dir / "latest_report.json").write_text(json.dumps(report, indent=2))
    (out_dir / "latest_report.md").write_text(report["markdownReport"])

    print(report["markdownReport"])
    print(f"\nSaved structured JSON report -> {out_dir / 'latest_report.json'}")
    print(f"Saved Markdown report        -> {out_dir / 'latest_report.md'}")
    print(f"Saved SQLite run log         -> {out_dir / 'playtest_runs.sqlite'}")
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_cli()))
