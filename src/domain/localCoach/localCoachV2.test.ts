/**
 * ローカルコーチ v2 で追加した機能の単体テスト。
 *  - 推定の不確実性（区間）を確からしさへ反映する
 *  - 効果量 × 確からしさで課題を並べ替える
 *  - 検出範囲の拡張（ターゲット別・モード別・投順間距離・テンポ・長期トレンド）
 *  - 比較対象がなくても「良かった点」を出せる
 */
import { describe, expect, it } from "vitest";
import { STEEL_BOARD } from "../../config/boardProfiles";
import { landingFromCoordinate, landingFromSegment } from "../landing";
import { calculateStatistics } from "../stats";
import { makeSegmentTarget } from "../targets";
import { buildThrows, fixtureSession, D16, T20 } from "../../test/fixtures";
import type { FixtureThrowSpec } from "../../test/fixtures";
import type {
  SessionStatistics,
  TargetDefinition,
  ThrowRecord,
  TrainingSession,
} from "../../types/models";
import { analyzeLocalCoach, buildBaseline } from "./analyzeLocalCoach";
import { ACTION_TEMPLATE_IDS, buildAction } from "./actions";
import { calculateConfidence, severityOf } from "./confidence";
import { CONFIDENCE_WEIGHTS, MIN_TREND_SESSIONS } from "./config";
import {
  detectCricketPatterns,
  detectLongTermTrend,
  detectTempoChange,
  detectWeakTarget,
  detectZeroOnePatterns,
  type RuleContext,
} from "./rules";

const REP = T20.representativePoint;
const CALCULATED_AT = "2026-01-01T11:00:00.000Z";
const T19: TargetDefinition = {
  ...makeSegmentTarget("triple", STEEL_BOARD, 19),
  id: "fixture-target-t19",
};

function makeSession(overrides?: Partial<TrainingSession>): TrainingSession {
  return fixtureSession({
    setCount: 20,
    plannedThrowCount: 60,
    plannedTargets: Array.from({ length: 20 }, () => [T20, T20, T20]),
    ...overrides,
  });
}

function statsOf(
  session: TrainingSession,
  throws: readonly ThrowRecord[],
  mode = session.trainingMode
): SessionStatistics {
  return calculateStatistics(
    session.id,
    session.plannedThrowCount,
    throws,
    mode,
    CALCULATED_AT
  );
}

/** ルールを直接呼ぶための最小コンテキスト。 */
function contextOf(
  session: TrainingSession,
  stats: SessionStatistics,
  throws: readonly ThrowRecord[],
  overrides?: Partial<RuleContext>
): RuleContext {
  return {
    session,
    stats,
    throws,
    scopeKey: "session",
    scopeLabel: "セッション全体",
    multiScope: false,
    completionRatio: 1,
    allowGroupingStats: true,
    allowBaselineComparison: true,
    ...overrides,
  };
}

describe("v2: 推定の不確実性を確からしさへ反映する", () => {
  it("差の区間が0をまたぐ場合は確からしさを1段階下げる", () => {
    const base = { sampleSize: 40, corroboratingConditions: 2 } as const;
    expect(calculateConfidence({ ...base })).toBe("high");
    expect(
      calculateConfidence({ ...base, differenceExcludesZero: true })
    ).toBe("high");
    expect(
      calculateConfidence({ ...base, differenceExcludesZero: false })
    ).toBe("medium");
  });

  it("区間の減点と完了率の減点は重ねて適用される", () => {
    expect(
      calculateConfidence({
        sampleSize: 40,
        corroboratingConditions: 2,
        differenceExcludesZero: false,
        completionRatio: 0.3,
      })
    ).toBe("low");
  });

  it("区間で減点しても、サンプル数の上限規則を破らない", () => {
    // 10投未満は常に low、10〜29投は最大 medium
    expect(
      calculateConfidence({
        sampleSize: 9,
        corroboratingConditions: 5,
        differenceExcludesZero: true,
      })
    ).toBe("low");
    expect(
      calculateConfidence({
        sampleSize: 29,
        corroboratingConditions: 5,
        differenceExcludesZero: true,
      })
    ).toBe("medium");
  });

  it("同じ差でも分母が小さいほど確からしさが下がる（実データ経由）", () => {
    // 3投目だけ命中率が下がり、横方向のばらつきも大きくなるセッションを
    // セット数だけ変えて2通り作る（同じ主題を2指標が裏付ける状態）
    const build = (setCount: number) => {
      const specs: FixtureThrowSpec[] = [];
      for (let set = 0; set < setCount; set += 1) {
        for (const dart of [1, 2, 3] as const) {
          // 3投目は3回に2回外す(命中率約33%)、他は常に命中(わずかに左右へ振れる)
          const miss = dart === 3 && set % 3 !== 0;
          const jitter = (set % 2 === 0 ? 1 : -1) * 0.02;
          specs.push({
            target: T20,
            landing: landingFromCoordinate(
              REP.x + (miss ? (set % 2 === 0 ? 0.35 : -0.35) : jitter),
              REP.y,
              STEEL_BOARD
            ),
            setId: `set-${set + 1}`,
          });
        }
      }
      const session = makeSession({
        setCount,
        plannedThrowCount: setCount * 3,
        plannedTargets: Array.from({ length: setCount }, () => [T20, T20, T20]),
      });
      const throws = buildThrows(specs, setCount * 3);
      return analyzeLocalCoach({ session, stats: statsOf(session, throws), throws });
    };
    const few = build(11); // 3投目11投
    const many = build(40); // 3投目40投
    // 3投目を指す所見は severity 最大になり、最優先の課題として出る
    const pick = (r: ReturnType<typeof build>) =>
      r.issueFindings.find((f) => f.subject?.startsWith("dart_order_3"));
    // 11セット(3投目11投)は 10〜29投の帯なので最大「中」
    expect(pick(few)?.confidence).toBe("medium");
    // 40セット(3投目40投)かつ、ばらつきと命中率の2指標が同じ投順を裏付ける
    expect(pick(many)?.confidence).toBe("high");
  });
});

describe("v2: 効果量による優先順位付け", () => {
  it("severity は効果量 × 確からしさの重みで決まる", () => {
    expect(severityOf(0.8, "high")).toBeCloseTo(0.8 * CONFIDENCE_WEIGHTS.high, 12);
    expect(severityOf(0.8, "medium")).toBeCloseTo(0.8 * CONFIDENCE_WEIGHTS.medium, 12);
    expect(severityOf(0.8, "low")).toBeCloseTo(0.8 * CONFIDENCE_WEIGHTS.low, 12);
  });

  it("課題は severity の降順で並び、最優先に最も大きい課題が来る", () => {
    // 3投目のばらつきが極端に大きく、同時に前半後半差もあるセッション
    const specs: FixtureThrowSpec[] = [];
    for (let set = 0; set < 20; set += 1) {
      for (const dart of [1, 2, 3] as const) {
        const spread = dart === 3 ? 0.3 : 0.02;
        const sign = set % 2 === 0 ? 1 : -1;
        specs.push({
          target: T20,
          landing: landingFromCoordinate(
            REP.x + sign * spread,
            REP.y,
            STEEL_BOARD
          ),
          setId: `set-${set + 1}`,
        });
      }
    }
    const session = makeSession();
    const throws = buildThrows(specs, 60);
    const report = analyzeLocalCoach({ session, stats: statsOf(session, throws), throws });
    expect(report.issueFindings.length).toBeGreaterThan(0);
    for (let i = 1; i < report.issueFindings.length; i += 1) {
      expect(report.issueFindings[i]!.severity).toBeLessThanOrEqual(
        report.issueFindings[i - 1]!.severity
      );
    }
    // 推奨メニューは severity 最大の課題に対応する
    expect(report.recommendedAction?.targetFindingId).toBe(
      report.issueFindings[0]!.id
    );
  });

  it("severity が同じでも並び順が決定論的になる", () => {
    const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
      target: i % 2 === 0 ? T20 : D16,
      landing: landingFromCoordinate(
        REP.x + (i % 4) * 0.05,
        REP.y + (i % 3) * 0.05,
        STEEL_BOARD
      ),
      setId: `set-${Math.ceil((i + 1) / 3)}`,
    }));
    const session = makeSession();
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws);
    const first = analyzeLocalCoach({ session, stats, throws });
    const second = analyzeLocalCoach({
      session,
      stats,
      throws: throws.slice().reverse(),
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("v2: 検出範囲の拡張", () => {
  it("ターゲット別の弱点は、十分な分母があるターゲットだけで比較する", () => {
    // T20は40投(ほぼ命中)、T19は20投(ほぼミス)、D16は3投だけ
    const specs: FixtureThrowSpec[] = [];
    let index = 0;
    const push = (target: TargetDefinition, miss: boolean) => {
      specs.push({
        target,
        landing: landingFromCoordinate(
          target.representativePoint.x + (miss ? 0.4 : 0),
          target.representativePoint.y,
          STEEL_BOARD
        ),
        setId: `set-${Math.ceil((index + 1) / 3)}`,
      });
      index += 1;
    };
    for (let i = 0; i < 40; i += 1) push(T20, false);
    for (let i = 0; i < 20; i += 1) push(T19, true);
    for (let i = 0; i < 3; i += 1) push(D16, true);
    const session = makeSession({ setCount: 21, plannedThrowCount: 63 });
    const throws = buildThrows(specs, 63);
    const stats = statsOf(session, throws);
    const findings = detectWeakTarget(contextOf(session, stats, throws));
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.id).toContain("T19");
    // 分母10投未満の D16 は比較へ含めない
    expect(JSON.stringify(finding)).not.toContain("D16");
    for (const evidence of finding.evidence) {
      expect(evidence.sampleSize).toBeGreaterThanOrEqual(10);
    }
  });

  it("クリケットのノーマーク率と切替直後の平均マークを検出する", () => {
    // セット内で T20 → T20 → T19 と切り替え、切替直後は必ずノーマーク
    const specs: FixtureThrowSpec[] = [];
    for (let set = 0; set < 20; set += 1) {
      const setId = `set-${set + 1}`;
      specs.push({
        target: T20,
        landing: landingFromSegment("triple", STEEL_BOARD, 20),
        setId,
      });
      specs.push({
        target: T20,
        landing: landingFromSegment("triple", STEEL_BOARD, 20),
        setId,
      });
      // T19狙いで1へ着弾 → 0マーク
      specs.push({
        target: T19,
        landing: landingFromSegment("outer_single", STEEL_BOARD, 1),
        setId,
      });
    }
    const session = makeSession({
      trainingMode: "cricket",
      plannedTargets: Array.from({ length: 20 }, () => [T20, T20, T19]),
    });
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws, "cricket");
    const findings = detectCricketPatterns(contextOf(session, stats, throws));
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("cricket_switch_marks_down");
    const switchFinding = findings.find((f) => f.id === "cricket_switch_marks_down")!;
    // 分母は同一継続20投・切替直後20投（セットの1投目は除外）
    expect(switchFinding.evidence.map((e) => e.sampleSize)).toEqual([20, 20]);
  });

  it("01のリング種別間の命中率差を検出する", () => {
    // Bullは命中、ダブルは全ミス
    const bull: TargetDefinition = {
      id: "bull",
      label: "Bull",
      type: "bull_any",
      representativePoint: { x: 0, y: 0 },
    };
    const d16 = D16;
    const specs: FixtureThrowSpec[] = [];
    for (let i = 0; i < 30; i += 1) {
      specs.push({
        target: bull,
        landing: landingFromSegment("inner_bull", STEEL_BOARD),
        setId: `set-${Math.ceil((i + 1) / 3)}`,
      });
    }
    for (let i = 30; i < 60; i += 1) {
      specs.push({
        target: d16,
        landing: landingFromSegment("outer_single", STEEL_BOARD, 16),
        setId: `set-${Math.ceil((i + 1) / 3)}`,
      });
    }
    const session = makeSession({ trainingMode: "zero_one" });
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws, "zero_one");
    const findings = detectZeroOnePatterns(contextOf(session, stats, throws));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toContain("ダブル");
    expect(findings[0]!.confidence).not.toBe("low");
  });

  it("投擲間隔(テンポ)の前後半変化を検出する", () => {
    const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
      target: T20,
      landing: landingFromCoordinate(REP.x, REP.y, STEEL_BOARD),
      setId: `set-${Math.ceil((i + 1) / 3)}`,
    }));
    const session = makeSession();
    const base = buildThrows(specs, 60);
    // 前半は投擲間隔10秒、後半は3秒になるよう elapsedMs を作り直す
    let elapsed = 0;
    const throws = base.map((t, i) => {
      const gapSeconds = t.dartInSet === 1 ? 30 : i < 30 ? 10 : 3;
      elapsed += gapSeconds * 1000;
      return { ...t, elapsedMs: elapsed };
    });
    const stats = statsOf(session, throws);
    const findings = detectTempoChange(contextOf(session, stats, throws));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toContain("shorter");
    expect(findings[0]!.title).toContain("短く");
    // セットの1投目(20投)は除外され、分母は40区間を半分に割った20/20
    expect(findings[0]!.evidence.map((e) => e.sampleSize)).toEqual([20, 20]);
  });

  it("長期トレンドは4セッション以上で方向が一貫したときだけ出す", () => {
    const mk = (id: string, startedAt: string, hitRate: number) => {
      const session = makeSession({ id, startedAt });
      const hits = Math.round(hitRate * 60);
      const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
        target: T20,
        landing: landingFromCoordinate(
          REP.x + (i < hits ? 0 : 0.4),
          REP.y,
          STEEL_BOARD
        ),
        setId: `${id}-set-${Math.ceil((i + 1) / 3)}`,
      }));
      const throws = buildThrows(specs, 60);
      return { session, stats: statsOf(session, throws), throws };
    };
    const older = [
      mk("p1", "2026-01-01T10:00:00.000Z", 0.8),
      mk("p2", "2026-01-02T10:00:00.000Z", 0.7),
      mk("p3", "2026-01-03T10:00:00.000Z", 0.6),
    ];
    const current = mk("session-1", "2026-01-04T10:00:00.000Z", 0.5);
    const baseline = buildBaseline(older)!;
    // 古い順の履歴が保持されている
    expect(baseline.history.map((h) => h.hitRate)).toEqual([0.8, 0.7, 0.6]);
    const findings = detectLongTermTrend(
      contextOf(current.session, current.stats, current.throws, { baseline })
    );
    const trend = findings.find((f) => f.id === "trend_hit_rate_down");
    expect(trend).toBeDefined();
    expect(trend!.title).toContain(`${MIN_TREND_SESSIONS}セッション連続`);

    // 3セッションしかなければ方向を語らない
    const shortBaseline = buildBaseline(older.slice(0, 2))!;
    const shortFindings = detectLongTermTrend(
      contextOf(current.session, current.stats, current.throws, {
        baseline: shortBaseline,
      })
    );
    expect(shortFindings.some((f) => f.id.startsWith("trend_hit_rate"))).toBe(false);
  });
});

describe("v2: 良かった点の専用検出", () => {
  it("比較可能な過去セッションがなくても良かった点を1件出せる", () => {
    // 1投目だけ極端に安定しているセッション
    const specs: FixtureThrowSpec[] = [];
    for (let set = 0; set < 20; set += 1) {
      for (const dart of [1, 2, 3] as const) {
        const spread = dart === 1 ? 0.01 : 0.2;
        const sign = set % 2 === 0 ? 1 : -1;
        specs.push({
          target: T20,
          landing: landingFromCoordinate(
            REP.x + sign * spread,
            REP.y,
            STEEL_BOARD
          ),
          setId: `set-${set + 1}`,
        });
      }
    }
    const session = makeSession();
    const throws = buildThrows(specs, 60);
    const report = analyzeLocalCoach({ session, stats: statsOf(session, throws), throws });
    expect(report.generatedFrom.comparisonSessionCount).toBe(0);
    expect(report.positiveFinding).toBeDefined();
    expect(report.positiveFinding!.id).toContain("strength_");
    expect(report.positiveFinding!.title).toContain("1投目");
  });
});

describe("v2: 追加ルールの安全性と配線", () => {
  it("すべての actionTemplateId に対応するメニューが存在する", () => {
    // v2で追加したテンプレートも含め、配線漏れがないことを確認する
    for (const templateId of ACTION_TEMPLATE_IDS) {
      const action = buildAction({
        id: "test",
        kind: "statistical_trend",
        priority: 1,
        effect: 0.5,
        severity: 0.35,
        title: "t",
        summary: "s",
        confidence: "medium",
        evidence: [{ metric: "テスト指標", sampleSize: 10 }],
        limitations: [],
        actionTemplateId: templateId,
      });
      expect(action, templateId).toBeDefined();
      expect(action!.avoid, templateId).toContain("同時に変更しない");
      expect(action!.recordItems.length, templateId).toBeGreaterThan(0);
      expect(action!.successCriteria.length, templateId).toBeGreaterThan(0);
      expect(action!.stopOrChangeCriteria.length, templateId).toBeGreaterThan(0);
    }
    // v2で追加した分を含む
    expect(ACTION_TEMPLATE_IDS).toContain("weak_target");
    expect(ACTION_TEMPLATE_IDS).toContain("cricket_switch_marks_down");
    expect(ACTION_TEMPLATE_IDS).toContain("zero_one_ring_gap");
    expect(ACTION_TEMPLATE_IDS).toContain("tempo_change");
    expect(ACTION_TEMPLATE_IDS).toContain("trend_hit_rate_down");
    expect(ACTION_TEMPLATE_IDS).toContain("grouping_inter_dart");
  });

  it("追加ルールも身体動作・医学・心理の断定を含まない", () => {
    const FORBIDDEN = [
      "肘",
      "肩",
      "手首",
      "グリップ",
      "リリース",
      "イップス",
      "メンタル",
      "集中力",
      "性格",
      "診断",
    ];
    for (const templateId of ACTION_TEMPLATE_IDS) {
      const action = buildAction({
        id: "test",
        kind: "statistical_trend",
        priority: 1,
        effect: 0.5,
        severity: 0.35,
        title: "t",
        summary: "s",
        confidence: "medium",
        evidence: [{ metric: "テスト指標", sampleSize: 10 }],
        limitations: [],
        actionTemplateId: templateId,
      })!;
      // avoid は「変更しない」ことの明示なので身体部位名を含んでよい。
      // それ以外の本文は身体動作へ踏み込まない。
      for (const text of [
        action.title,
        action.purpose,
        action.method,
        action.focus,
        ...action.recordItems,
        ...action.successCriteria,
      ]) {
        for (const word of FORBIDDEN) {
          expect(text, `${templateId}: "${text}" が「${word}」を含む`).not.toContain(
            word
          );
        }
      }
    }
  });
});
