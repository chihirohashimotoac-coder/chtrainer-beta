"""PR環境で主要画面を実操作し、レスポンシブスクリーンショットを保存する。"""

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4173"
OUTPUT = Path("qa-screenshots")
# Playwright が同梱ブラウザを見つけられない環境（ブラウザだけ別途用意されている等）
# 向けの脱出口。未設定なら従来どおり Playwright 管理のブラウザを使う。
CHROMIUM_PATH = os.environ.get("PW_CHROMIUM_PATH") or None


def seed_completed_session(page) -> None:
    page.evaluate(
        """
        async () => {
          const open = indexedDB.open("darts-training-analyzer-beta");
          const db = await new Promise((resolve, reject) => {
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
          });
          const now = "2026-07-17T12:00:00.000Z";
          const player = {
            schemaVersion: 3, id: "qa-player", displayName: "QA Player",
            dominantHand: "right", dominantEye: "right", stance: "middle",
            form: { gripFingerCount: "3", gripPosition: "center", takeback: "standard", throwingTempo: "standard" },
            goal: "recovery", currentLevel: "練習中", targetLevel: "安定した投擲",
            defaultBoardType: "soft", dartColors: ["#e05252", "#4f7fe0", "#f0f0f0"],
            defaultInputMethod: "simple", vibrationEnabled: true, soundEnabled: false,
            autoAdvanceEnabled: true, createdAt: now, updatedAt: now
          };
          const target = (number) => ({
            id: `qa-t${number}`, label: `T${number}`, type: "exact_segment", number,
            ring: "triple", evaluationKind: "cricket_marks", representativePoint: { x: 0, y: 0.6 }
          });
          const t20 = target(20), t19 = target(19);
          const session = {
            schemaVersion: 3, id: "qa-session", playerId: player.id, boardType: "soft",
            boardProfileId: "soft_standard", trainingMode: "cricket", arrangement: "within_set_switch",
            inputMethod: "simple", dominantHand: "right", setCount: 20, plannedThrowCount: 60,
            plannedTargets: Array.from({ length: 20 }, (_, index) => index % 2 ? [t19, t20, t19] : [t20, t19, t20]),
            startedAt: now, endedAt: "2026-07-17T12:20:00.000Z", dailyCondition: "usual",
            assessments: [
              { timing: "before", recordedAt: now, fatigue: 2, concentration: 6, pain: 0, confidence: 4, anxiety: 6, releaseFear: 5, routineAdherence: 5, uninterruptedThrowRate: 30, releaseStopTiming: "before_takeback" },
              { timing: "middle", recordedAt: now, fatigue: 3, concentration: 7, pain: 0, confidence: 5, anxiety: 5, releaseFear: 4, routineAdherence: 6, uninterruptedThrowRate: 50, releaseStopTiming: "after_takeback" },
              { timing: "after", recordedAt: now, fatigue: 4, concentration: 7, pain: 0, confidence: 7, anxiety: 3, releaseFear: 2, routineAdherence: 8, uninterruptedThrowRate: 70, releaseStopTiming: "none" }
            ],
            contextSnapshot: { capturedAt: now, displayName: player.displayName, dominantHand: "right", goal: "recovery", dartColors: player.dartColors, boardType: "soft", inputMethod: "simple" },
            status: "completed", progress: { currentSetNumber: 3, middleAssessmentDone: true },
            createdAt: now, updatedAt: now
          };
          const sets = [1, 2].map((number) => ({
            schemaVersion: 3, id: `qa-set-${number}`, sessionId: session.id,
            setNumber: number, startedAt: now, completedAt: now,
            evaluationKind: "cricket_marks", inputMethod: "simple"
          }));
          const targets = [t20, t19, t20, t19, t20, t19];
          const throws = targets.map((aim, index) => {
            const inSet = (index % 3) + 1;
            const sameSet = inSet !== 1;
            const previous = index > 0 ? targets[index - 1] : undefined;
            const changed = sameSet && previous.label !== aim.label;
            const marks = index % 3 === 2 ? 1 : 3;
            return {
              schemaVersion: 3, id: `qa-throw-${index + 1}`, sessionId: session.id,
              setId: `qa-set-${Math.floor(index / 3) + 1}`, globalThrowNumber: index + 1,
              dartInSet: inSet, dartColor: player.dartColors[index % 3], target: aim,
              thrownAt: now, elapsedMs: (index + 1) * 10000,
              landing: { number: aim.number, ring: marks === 3 ? "triple" : "outer_single", positionPrecision: "segment_approximation", x: 0, y: 0.6 },
              derived: { exactHit: marks === 3, targetChangedFromPrevious: changed,
                sameSetAsPrevious: sameSet, sameTargetAsPrevious: sameSet ? !changed : undefined,
                previousThrowWasHitInSameSet: sameSet ? true : undefined,
                sessionProgress: (index + 1) / 60 },
              createdAt: now, updatedAt: now
            };
          });
          const tx = db.transaction(["settings", "players", "sessions", "throwSets", "throws", "sessionStatistics"], "readwrite");
          tx.objectStore("settings").put({ id: "app", schemaVersion: 3, onboardingCompleted: true, activePlayerId: player.id, updatedAt: now });
          tx.objectStore("players").put(player);
          tx.objectStore("sessions").put(session);
          sets.forEach((value) => tx.objectStore("throwSets").put(value));
          throws.forEach((value) => tx.objectStore("throws").put(value));
          tx.objectStore("sessionStatistics").delete(session.id);
          await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
          db.close();
        }
        """
    )


def seed_active_session(page) -> None:
    page.evaluate(
        """
        async () => {
          const open = indexedDB.open("darts-training-analyzer-beta");
          const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
          const t20 = { id: "qa-active-t20", label: "T20", type: "exact_segment", number: 20, ring: "triple", evaluationKind: "cricket_marks", representativePoint: { x: 0, y: 0.6 } };
          const t19 = { ...t20, id: "qa-active-t19", label: "T19", number: 19 };
          const session = {
            schemaVersion: 3, id: "qa-active", playerId: "qa-player", boardType: "soft", boardProfileId: "soft_standard",
            trainingMode: "cricket", arrangement: "within_set_switch", inputMethod: "simple", dominantHand: "right",
            setCount: 20, plannedThrowCount: 60, plannedTargets: Array.from({ length: 20 }, (_, i) => i % 2 ? [t19, t20, t19] : [t20, t19, t20]),
            startedAt: "2026-07-17T13:00:00.000Z", dailyCondition: "usual",
            assessments: [{ timing: "before", recordedAt: "2026-07-17T13:00:00.000Z", fatigue: 2, concentration: 7, pain: 0, confidence: 6 }],
            status: "active", progress: { currentSetNumber: 1, middleAssessmentDone: false },
            createdAt: "2026-07-17T13:00:00.000Z", updatedAt: "2026-07-17T13:00:00.000Z"
          };
          const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").put(session);
          await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
        }
        """
    )


def assert_no_page_overflow(page, name: str, report: dict) -> None:
    metrics = page.evaluate("() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })")
    report[name] = metrics
    assert metrics["scrollWidth"] <= metrics["width"] + 1, f"{name}: horizontal overflow {metrics}"


def capture(page, name: str, report: dict, full_page: bool = True) -> None:
    page.screenshot(path=OUTPUT / f"{name}.png", full_page=full_page)
    assert_no_page_overflow(page, name, report)


def assert_major_tap_targets(page, name: str, report: dict) -> None:
    sizes = page.evaluate(
        """() => [...document.querySelectorAll('.btn.primary, .choice')]
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ width: Math.round(rect.width), height: Math.round(rect.height) }))"""
    )
    report[name] = sizes
    assert sizes, f"{name}: no major tap targets found"
    assert all(size["height"] >= 48 for size in sizes), f"{name}: tap target below 48px {sizes}"


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    report = {}
    with sync_playwright() as playwright:
        browser = (
            playwright.chromium.launch(executable_path=CHROMIUM_PATH)
            if CHROMIUM_PATH
            else playwright.chromium.launch()
        )
        page = browser.new_page(viewport={"width": 375, "height": 900}, device_scale_factor=1)
        page.goto(BASE_URL, wait_until="networkidle")
        seed_completed_session(page)
        page.reload(wait_until="networkidle")

        for width in [320, 360, 375, 390, 430, 768, 1024, 1440]:
            page.set_viewport_size({"width": width, "height": 900})
            page.goto(f"{BASE_URL}/#/", wait_until="networkidle")
            # ベータ版バッジが表示され、狭幅でも見出しを崩さないこと
            assert page.locator(".home-hero .badge.beta").count() == 1
            capture(page, f"home-{width}", report)

        page.set_viewport_size({"width": 1024, "height": 900})
        page.goto(f"{BASE_URL}/#/train/mode", wait_until="networkidle")
        capture(page, "mode-select-1024", report)

        page.goto(f"{BASE_URL}/#/settings/player", wait_until="networkidle")
        page.get_by_text("フォーム情報").click()
        for name in ["グリップ本数", "グリップ位置", "テイクバック", "投擲テンポ"]:
            assert page.get_by_role("combobox", name=name).count() == 1
        capture(page, "player-settings-1024", report)

        page.goto(f"{BASE_URL}/#/train/mode", wait_until="networkidle")
        diagnostic_mode = page.get_by_role("button", name="全体診断")
        diagnostic_mode.focus()
        page.keyboard.press("Enter")
        page.wait_for_url("**/#/train/targets")
        report["keyboard_navigation"] = {"activated": "全体診断", "url": page.url}
        page.get_by_text("固定ダブル：3本とも同じダブルを狙う").wait_for()
        capture(page, "skill-r4-explanation-1024", report)

        page.goto(f"{BASE_URL}/#/train/mode", wait_until="networkidle")
        page.get_by_role("button", name="クリケット練習").click()
        page.get_by_role("button", name="セット内切替").click()
        capture(page, "cricket-within-set-switch-1024", report)
        assert_major_tap_targets(page, "major_tap_targets", report)

        seed_active_session(page)
        page.set_viewport_size({"width": 375, "height": 900})
        page.goto(f"{BASE_URL}/#/train/session", wait_until="networkidle")
        page.get_by_text("T20").first.wait_for()
        capture(page, "throw-input-375", report, full_page=False)

        page.set_viewport_size({"width": 1024, "height": 900})
        page.goto(f"{BASE_URL}/#/session/qa-session/result", wait_until="networkidle")
        page.get_by_text("セット内のターゲット継続・切替比較").wait_for()
        capture(page, "statistics-1024", report)

        page.goto(f"{BASE_URL}/#/session/qa-session/throws", wait_until="networkidle")
        page.get_by_text("N/A：").wait_for()
        capture(page, "throw-history-1024", report)

        for width in [320, 360, 390, 430]:
            page.set_viewport_size({"width": width, "height": 900})
            page.goto(f"{BASE_URL}/#/about", wait_until="networkidle")
            page.get_by_text("ベータ版について").wait_for()
            assert page.locator(".badge.beta").count() >= 1
            capture(page, f"about-beta-{width}", report)

        page.set_viewport_size({"width": 1024, "height": 900})
        page.goto(f"{BASE_URL}/#/session/qa-session/export", wait_until="networkidle")
        page.get_by_role("button", name="AIへ渡すテキストを生成").wait_for()
        capture(page, "ai-export-1024", report)

        page.keyboard.press("Tab")
        focused = page.evaluate("() => ({ tag: document.activeElement?.tagName, outline: getComputedStyle(document.activeElement).outlineStyle })")
        report["keyboard_focus"] = focused
        assert focused["outline"] != "none"
        browser.close()

    (OUTPUT / "qa-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
