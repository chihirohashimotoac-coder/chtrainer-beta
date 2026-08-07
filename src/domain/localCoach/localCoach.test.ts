import { describe, expect, it } from "vitest";
import { STEEL_BOARD } from "../../config/boardProfiles";
import {
  landingBounceOut,
  landingFromCoordinate,
  landingFromSegment,
} from "../landing";
import { calculateStatistics } from "../stats";
import { buildThrows, fixtureSession, D16, T20 } from "../../test/fixtures";
import type { FixtureThrowSpec } from "../../test/fixtures";
import type {
  SessionStatistics,
  ThrowRecord,
  TrainingSession,
} from "../../types/models";
import {
  analyzeLocalCoach,
  buildBaseline,
  isComparableSession,
  precisionProfileOf,
  selectComparableSessions,
  NO_COMPARABLE_SESSION_REASON,
} from "./analyzeLocalCoach";
import { ACTION_TEMPLATE_IDS, buildAction } from "./actions";
import { calculateConfidence, downgrade } from "./confidence";
import {
  MIN_ANALYZABLE_SAMPLE,
  MIN_HIGH_CONFIDENCE_SAMPLE,
  MAX_ISSUE_FINDINGS,
  MAX_POSITIVE_FINDINGS,
} from "./config";
import {
  detectBaselineDiff,
  detectTargetSwitch,
  rateOf,
  relativeDiff,
  sampleStdDev,
} from "./rules";
import type { LocalCoachFinding, LocalCoachReport } from "./types";

const CALCULATED_AT = "2026-01-01T11:00:00.000Z";
const REP = T20.representativePoint;

/** 同一ターゲット反復セッションを組み立てる（3投目だけ横へ大きく散らす）。 */
function lateralSpreadSpecs(setCount: number): FixtureThrowSpec[] {
  const specs: FixtureThrowSpec[] = [];
  for (let set = 0; set < setCount; set += 1) {
    for (const dart of [1, 2, 3] as const) {
      const spread = dart === 3 ? 0.18 : 0.02;
      const sign = set % 2 === 0 ? 1 : -1;
      const jitter = ((set % 5) - 2) / 10;
      specs.push({
        target: T20,
        landing: landingFromCoordinate(
          REP.x + sign * spread * (1 + jitter),
          REP.y + jitter * 0.02,
          STEEL_BOARD
        ),
        setId: `set-${set + 1}`,
      });
    }
  }
  return specs;
}

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
  throws: readonly ThrowRecord[]
): SessionStatistics {
  return calculateStatistics(
    session.id,
    session.plannedThrowCount,
    throws,
    session.trainingMode,
    CALCULATED_AT
  );
}

/** 3投目だけ横へ散る60投セッション。 */
function lateralSpreadScenario() {
  const session = makeSession();
  const throws = buildThrows(lateralSpreadSpecs(20), 60);
  return { session, throws, stats: statsOf(session, throws) };
}

/** 所見・メニューのうち「コーチが主張している文」だけを集める。 */
function assertiveTexts(report: LocalCoachReport): string[] {
  const findings: LocalCoachFinding[] = [
    ...(report.positiveFinding ? [report.positiveFinding] : []),
    ...report.issueFindings,
  ];
  const out = findings.flatMap((f) => [f.title, f.summary]);
  const action = report.recommendedAction;
  if (action) out.push(action.title, action.purpose, action.method, action.focus);
  return out;
}

describe("ローカルコーチ分析（決定論・サンプル数）", () => {
  it("1. 同じ入力からは常に同じ結果を返す", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const first = analyzeLocalCoach({ session, stats, throws });
    // 投擲の並び順を変えても、内部で通し番号昇順へ整列するため結果は変わらない
    const second = analyzeLocalCoach({
      session,
      stats,
      throws: throws.slice().reverse(),
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("2. 完了投擲数が10投未満では主要傾向を断定しない", () => {
    const session = makeSession({ setCount: 3, plannedThrowCount: 9, status: "aborted" });
    const throws = buildThrows(lateralSpreadSpecs(3), 9);
    const report = analyzeLocalCoach({ session, stats: statsOf(session, throws), throws });
    expect(report.analyzable).toBe(false);
    expect(report.issueFindings).toHaveLength(0);
    expect(report.positiveFinding).toBeUndefined();
    expect(report.recommendedAction).toBeUndefined();
    expect(report.unavailableReasons.join("\n")).toContain(
      `完了投擲数が最低分析数${MIN_ANALYZABLE_SAMPLE}投を下回っています`
    );
  });

  it("3. 10投未満では確からしさ「高」を出さない", () => {
    for (let n = 0; n < MIN_ANALYZABLE_SAMPLE; n += 1) {
      expect(
        calculateConfidence({ sampleSize: n, corroboratingConditions: 5 })
      ).toBe("low");
    }
  });

  it("4. 10〜29投では確からしさが最大「中」", () => {
    for (const n of [10, 20, 29]) {
      expect(
        calculateConfidence({ sampleSize: n, corroboratingConditions: 5 })
      ).toBe("medium");
    }
    // 30投以上でも、1条件だけの観測では自動的に「高」にしない
    expect(
      calculateConfidence({
        sampleSize: MIN_HIGH_CONFIDENCE_SAMPLE,
        corroboratingConditions: 1,
      })
    ).toBe("medium");
    expect(
      calculateConfidence({
        sampleSize: MIN_HIGH_CONFIDENCE_SAMPLE,
        corroboratingConditions: 2,
      })
    ).toBe("high");
  });

  it("5. 分母0を0%として扱わない", () => {
    expect(rateOf(0, 0)).toBeUndefined();
    expect(rateOf(0, 5)).toBe(0);
    // 基準が0のときの相対差も定義できないためN/A
    expect(relativeDiff(0.2, 0)).toBeUndefined();
    // 標準偏差もサンプル2未満では算出しない
    expect(sampleStdDev([])).toBeUndefined();
    expect(sampleStdDev([0.1])).toBeUndefined();
  });

  it("8. 中断セッションでは完了率を考慮して確からしさを1段階下げる", () => {
    const full = calculateConfidence({
      sampleSize: 40,
      corroboratingConditions: 2,
      completionRatio: 1,
    });
    const aborted = calculateConfidence({
      sampleSize: 40,
      corroboratingConditions: 2,
      completionRatio: 0.4,
    });
    expect(full).toBe("high");
    expect(aborted).toBe(downgrade(full));
    expect(aborted).toBe("medium");
    // 実セッションでも完了率が反映される
    const session = makeSession({ plannedThrowCount: 200, status: "aborted" });
    const throws = buildThrows(lateralSpreadSpecs(20), 200);
    const report = analyzeLocalCoach({ session, stats: statsOf(session, throws), throws });
    expect(report.generatedFrom.completionRatio).toBeCloseTo(60 / 200, 10);
    expect(report.issueFindings[0]?.confidence).toBe("low");
  });
});

describe("ローカルコーチ分析（入力精度の区別）", () => {
  it("7. 詳細座標・簡易入力・混在・位置なしを区別する", () => {
    const base = { coordinateInputCount: 0, approximateInputCount: 0 } as SessionStatistics;
    expect(precisionProfileOf({ ...base, coordinateInputCount: 10 })).toBe("coordinate");
    expect(precisionProfileOf({ ...base, approximateInputCount: 10 })).toBe("simple");
    expect(
      precisionProfileOf({ ...base, coordinateInputCount: 5, approximateInputCount: 5 })
    ).toBe("mixed");
    expect(precisionProfileOf(base)).toBe("none");
  });

  it("6. 詳細座標と簡易入力を同じ精度で比較しない（比較対象から除外し、座標ルールは概算を使わない）", () => {
    const session = makeSession();
    const coordinateThrows = buildThrows(lateralSpreadSpecs(20), 60);
    const coordinateStats = statsOf(session, coordinateThrows);
    // 簡易入力だけのセッション
    const simpleSpecs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
      target: T20,
      landing: landingFromSegment("outer_single", STEEL_BOARD, 5),
      setId: `set-${Math.ceil((i + 1) / 3)}`,
    }));
    const simpleSession = makeSession({ id: "session-simple", startedAt: "2025-12-01T10:00:00.000Z" });
    const simpleThrows = buildThrows(simpleSpecs, 60);
    const simpleStats = statsOf(simpleSession, simpleThrows);

    expect(
      isComparableSession(
        { session, stats: coordinateStats },
        { session: simpleSession, stats: simpleStats }
      )
    ).toBe(false);

    // 簡易入力のみのセッションでは、座標ベースの偏り所見を出さない
    const simpleReport = analyzeLocalCoach({
      session: simpleSession,
      stats: simpleStats,
      throws: simpleThrows,
    });
    expect(
      simpleReport.issueFindings.some((f) => f.id.startsWith("axis_"))
    ).toBe(false);
    // 詳細座標の投擲が不足している旨が分析不能理由として出る
    expect(simpleReport.unavailableReasons.join("\n")).toContain("詳細座標の投擲が0投");
  });

  it("6b. 座標ベースの根拠には概算入力の投擲を含めない", () => {
    // 詳細座標30投 + 簡易入力30投の混在セッション
    const specs: FixtureThrowSpec[] = [];
    for (let i = 0; i < 60; i += 1) {
      const setId = `set-${Math.ceil((i + 1) / 3)}`;
      specs.push(
        i < 30
          ? {
              target: T20,
              landing: landingFromCoordinate(REP.x + 0.2, REP.y, STEEL_BOARD),
              setId,
            }
          : {
              target: T20,
              landing: landingFromSegment("outer_single", STEEL_BOARD, 5),
              setId,
            }
      );
    }
    const session = makeSession();
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws);
    const report = analyzeLocalCoach({ session, stats, throws });
    const axis = report.issueFindings.find((f) => f.id.startsWith("axis_"));
    if (axis) {
      for (const evidence of axis.evidence) {
        // 分母は詳細座標30投を超えない（簡易入力を混ぜていない）
        expect(evidence.sampleSize).toBeLessThanOrEqual(stats.coordinateInputCount);
        expect(evidence.note).toContain("詳細座標のみ");
      }
    }
  });
});

describe("ローカルコーチ分析（分母と前投関係）", () => {
  it("9. 投順別分析では各投順の分母を根拠に含める", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const report = analyzeLocalCoach({ session, stats, throws });
    const finding = report.issueFindings.find((f) =>
      f.id.startsWith("dart_order_lateral_spread")
    );
    expect(finding).toBeDefined();
    const orderEvidence = finding!.evidence.filter((e) =>
      /^[123]投目の横方向ばらつき/.test(e.metric)
    );
    expect(orderEvidence).toHaveLength(3);
    for (const evidence of orderEvidence) {
      expect(evidence.sampleSize).toBe(20);
      expect(evidence.sampleSize).toBeGreaterThanOrEqual(MIN_ANALYZABLE_SAMPLE);
    }
  });

  it("10. セットの1投目を前投命中後・ミス後分析へ含めない", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    // フィクスチャの派生値: セットの1投目は前投関係が undefined
    const firstDarts = throws.filter((t) => t.dartInSet === 1);
    expect(firstDarts.length).toBeGreaterThan(0);
    for (const t of firstDarts) {
      expect(t.derived.sameSetAsPrevious).toBe(false);
      expect(t.derived.previousThrowWasHitInSameSet).toBeUndefined();
    }
    const report = analyzeLocalCoach({ session, stats, throws });
    const finding = report.issueFindings.find((f) =>
      f.id.startsWith("previous_throw_hit_effect")
    );
    if (finding) {
      const total = finding.evidence.reduce((sum, e) => sum + e.sampleSize, 0);
      // 分母の合計はセットの1投目(20投)を除いた40投を超えない
      expect(total).toBeLessThanOrEqual(40);
    }
  });

  it("11. ターゲット切替サンプルが0件なら分析不能とする", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const report = analyzeLocalCoach({ session, stats, throws });
    expect(
      throws.filter((t) => t.derived.targetChangedFromPrevious === true)
    ).toHaveLength(0);
    expect(report.unavailableReasons.join("\n")).toContain(
      "セット内でターゲットが切り替わった投擲が0件"
    );
    expect(
      report.issueFindings.some((f) => f.id.startsWith("target_switch_hit_rate"))
    ).toBe(false);
  });

  it("11b. 切替サンプルがあり分母が足りる場合だけ切替直後を比較する", () => {
    // 1セット3投を T20 → T20 → D16 とし、2投目=同一ターゲット継続、
    // 3投目=セット内切替直後になるようにする。着弾は常にT20の代表点なので、
    // 継続側は命中・切替側はミスになる。
    const specs: FixtureThrowSpec[] = [];
    for (let set = 0; set < 20; set += 1) {
      const setId = `set-${set + 1}`;
      const landing = landingFromCoordinate(REP.x, REP.y, STEEL_BOARD);
      specs.push({ target: T20, landing, setId });
      specs.push({ target: T20, landing, setId });
      specs.push({ target: D16, landing, setId });
    }
    const session = makeSession({
      plannedTargets: Array.from({ length: 20 }, () => [T20, T20, D16]),
    });
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws);
    const report = analyzeLocalCoach({ session, stats, throws });
    // 切替サンプルがあるので「未測定・分析不能」にはしない
    expect(report.unavailableReasons.join("\n")).not.toContain(
      "セット内でターゲットが切り替わった投擲が0件"
    );
    // 出力件数の上限で隠れないよう、ルールを直接呼んで比較の成立を検証する
    const findings = detectTargetSwitch({
      session,
      stats,
      throws,
      scopeKey: "session",
      scopeLabel: "セッション全体",
      multiScope: false,
      completionRatio: 1,
      allowGroupingStats: true,
      allowBaselineComparison: true,
    });
    const finding = findings.find((f) => f.id.startsWith("target_switch_hit_rate"));
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("statistical_trend");
    for (const evidence of finding!.evidence) {
      expect(evidence.sampleSize).toBeGreaterThanOrEqual(MIN_ANALYZABLE_SAMPLE);
    }
    // セットの1投目(20投)は集計へ含めない
    expect(
      finding!.evidence.reduce((sum, e) => sum + e.sampleSize, 0)
    ).toBeLessThanOrEqual(40);
  });

  it("12. 自己評価の未回答値を測定値として扱わない（自己評価は分析入力に使わない）", () => {
    const { throws, stats } = lateralSpreadScenario();
    const withDefaults = makeSession({
      assessments: [
        {
          timing: "before",
          recordedAt: "2026-01-01T09:59:00.000Z",
          fatigue: 5,
          concentration: 5,
          pain: 0,
          confidence: 5,
          untouchedScales: ["fatigue", "concentration", "pain", "confidence"],
        },
      ],
    });
    const withAnswers = makeSession({
      assessments: [
        {
          timing: "before",
          recordedAt: "2026-01-01T09:59:00.000Z",
          fatigue: 9,
          concentration: 1,
          pain: 8,
          confidence: 1,
        },
      ],
    });
    const a = analyzeLocalCoach({ session: withDefaults, stats, throws });
    const b = analyzeLocalCoach({ session: withAnswers, stats, throws });
    expect(a).toEqual(b);
    const text = JSON.stringify(a);
    expect(text).not.toContain("疲労度5");
    expect(text).not.toContain("自信度");
  });
});

describe("ローカルコーチ分析（出力件数と推奨メニュー）", () => {
  it("13/14/15. 良かった点1件・課題2件・推奨メニュー1件を超えない", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const report = analyzeLocalCoach({ session, stats, throws });
    expect(MAX_POSITIVE_FINDINGS).toBe(1);
    expect(MAX_ISSUE_FINDINGS).toBe(2);
    expect(report.issueFindings.length).toBeLessThanOrEqual(MAX_ISSUE_FINDINGS);
    expect(report.positiveFinding == null || typeof report.positiveFinding === "object").toBe(true);
    // recommendedAction は単数フィールドのため構造上1件を超えない
    expect(Array.isArray(report.recommendedAction)).toBe(false);
  });

  it("16. 推奨メニューと成功判定が最優先の課題へ対応する", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const report = analyzeLocalCoach({ session, stats, throws });
    const top = report.issueFindings[0];
    const action = report.recommendedAction;
    expect(top).toBeDefined();
    expect(action).toBeDefined();
    expect(action!.targetFindingId).toBe(top!.id);
    // 成功判定に、その課題の判定へ実際に使った指標名が含まれる
    const metric = top!.primaryMetric ?? top!.evidence[0]!.metric;
    expect(action!.successCriteria.join("\n")).toContain(metric);
    expect(action!.successCriteria.length).toBeLessThanOrEqual(3);
    // 必須項目がすべて揃っている
    expect(action!.purpose.length).toBeGreaterThan(0);
    expect(action!.method.length).toBeGreaterThan(0);
    expect(action!.throwCount).toBeGreaterThan(0);
    expect(action!.focus.length).toBeGreaterThan(0);
    expect(action!.avoid.length).toBeGreaterThan(0);
    expect(action!.recordItems.length).toBeGreaterThan(0);
    expect(action!.stopOrChangeCriteria.length).toBeGreaterThan(0);
  });

  it("16b. すべてのルールの actionTemplateId に対応するメニューが存在する", () => {
    for (const templateId of ACTION_TEMPLATE_IDS) {
      const action = buildAction({
        id: "test",
        kind: "statistical_trend",
        priority: 1,
        title: "t",
        summary: "s",
        confidence: "medium",
        evidence: [{ metric: "テスト指標", sampleSize: 10 }],
        limitations: [],
        actionTemplateId: templateId,
      });
      expect(action, templateId).toBeDefined();
      // 1つの実験で複数のフォーム要素を同時に変えさせない
      expect(action!.avoid).toContain("同時に変更しない");
    }
  });

  it("課題が0件のときは推奨メニューを生成しない", () => {
    // 中心へ正確に集まる60投（判定基準を超える差が出ない）
    const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
      target: T20,
      landing: landingFromCoordinate(
        REP.x + ((i % 3) - 1) * 0.001,
        REP.y + ((i % 2) - 0.5) * 0.001,
        STEEL_BOARD
      ),
      setId: `set-${Math.ceil((i + 1) / 3)}`,
    }));
    const session = makeSession();
    const throws = buildThrows(specs, 60);
    const report = analyzeLocalCoach({ session, stats: statsOf(session, throws), throws });
    expect(report.issueFindings).toHaveLength(0);
    expect(report.recommendedAction).toBeUndefined();
  });
});

describe("ローカルコーチ分析（断定の禁止）", () => {
  const FORBIDDEN_ASSERTIONS = [
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
    "うつ",
  ];

  it("17/18. 医学的・心理的・性格的な断定と身体動作の直接原因を出力しない", () => {
    const scenarios = [
      lateralSpreadScenario(),
      (() => {
        // 右へ大きく偏るセッション
        const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
          target: T20,
          landing: landingFromCoordinate(
            REP.x + 0.15 + ((i % 3) - 1) * 0.01,
            REP.y,
            STEEL_BOARD
          ),
          setId: `set-${Math.ceil((i + 1) / 3)}`,
        }));
        const session = makeSession();
        const throws = buildThrows(specs, 60);
        return { session, throws, stats: statsOf(session, throws) };
      })(),
    ];
    for (const scenario of scenarios) {
      const report = analyzeLocalCoach(scenario);
      for (const text of assertiveTexts(report)) {
        for (const word of FORBIDDEN_ASSERTIONS) {
          expect(text, `"${text}" が禁止語「${word}」を含む`).not.toContain(word);
        }
      }
    }
  });
});

describe("ローカルコーチ分析（比較対象の選定と根拠の一致）", () => {
  /** 比較用の過去セッション（同条件・詳細座標）を作る。 */
  function pastSession(id: string, startedAt: string, offset: number) {
    const session = makeSession({ id, startedAt });
    const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
      target: T20,
      landing: landingFromCoordinate(REP.x + offset, REP.y, STEEL_BOARD),
      setId: `${id}-set-${Math.ceil((i + 1) / 3)}`,
    }));
    const throws = buildThrows(specs, 60);
    return { session, stats: statsOf(session, throws) };
  }

  it("20. 比較不能な過去セッションを除外する", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const base = { session, stats };
    const sameConditions = pastSession("past-ok", "2025-12-20T10:00:00.000Z", 0.01);
    const otherMode = pastSession("past-mode", "2025-12-21T10:00:00.000Z", 0.01);
    otherMode.session = { ...otherMode.session, trainingMode: "cricket" };
    const otherBoard = pastSession("past-board", "2025-12-22T10:00:00.000Z", 0.01);
    otherBoard.session = { ...otherBoard.session, boardType: "soft" };
    const otherScoring = pastSession("past-scoring", "2025-12-23T10:00:00.000Z", 0.01);
    otherScoring.session = { ...otherScoring.session, scoringStyle: "steel" };
    const tooFew = pastSession("past-few", "2025-12-24T10:00:00.000Z", 0.01);
    tooFew.stats = { ...tooFew.stats, completedThrows: 5 };
    const stillActive = pastSession("past-active", "2025-12-25T10:00:00.000Z", 0.01);
    stillActive.session = { ...stillActive.session, status: "active" };

    expect(isComparableSession(base, sameConditions)).toBe(true);
    for (const bad of [otherMode, otherBoard, otherScoring, tooFew, stillActive]) {
      expect(isComparableSession(base, bad), bad.session.id).toBe(false);
    }
    const selected = selectComparableSessions({
      session,
      stats,
      throws,
      comparisons: [otherMode, otherBoard, otherScoring, tooFew, stillActive, sameConditions],
    });
    expect(selected.map((x) => x.session.id)).toEqual(["past-ok"]);
  });

  it("20b. 条件を満たす過去セッションは直近最大5件まで採用する", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const past = Array.from({ length: 8 }, (_, i) =>
      pastSession(`past-${i}`, `2025-12-0${i + 1}T10:00:00.000Z`, 0.01)
    );
    const selected = selectComparableSessions({ session, stats, throws, recentSessions: past });
    expect(selected).toHaveLength(5);
    // 新しい順（開始日時の降順）
    expect(selected.map((x) => x.session.id)).toEqual([
      "past-7",
      "past-6",
      "past-5",
      "past-4",
      "past-3",
    ]);
  });

  it("比較可能な過去セッションがない場合は本人平均との差を生成しない", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    const report = analyzeLocalCoach({ session, stats, throws });
    expect(report.generatedFrom.comparisonSessionCount).toBe(0);
    expect(report.unavailableReasons).toContain(NO_COMPARABLE_SESSION_REASON);
    const all = [...report.issueFindings, ...(report.positiveFinding ? [report.positiveFinding] : [])];
    expect(all.some((f) => f.id.startsWith("baseline_"))).toBe(false);
    expect(all.some((f) => f.id.startsWith("grouping_vs_baseline"))).toBe(false);
  });

  it("19. 根拠数値が元統計と一致する", () => {
    const { session, stats, throws } = lateralSpreadScenario();
    // 誤差の大きい過去セッションを1件だけ比較対象にする
    const past = pastSession("past-worse", "2025-12-20T10:00:00.000Z", 0.4);
    const report = analyzeLocalCoach({
      session,
      stats,
      throws,
      comparisons: [past],
    });
    const baseline = buildBaseline([past]);
    expect(baseline?.coordinateErrorMean).toBe(
      past.stats.coordinateError.averageErrorDistance
    );

    // 出力件数の上限で隠れないよう、基準線ルールを直接呼んで根拠値を検証する
    const findings = detectBaselineDiff({
      session,
      stats,
      throws,
      scopeKey: "session",
      scopeLabel: "セッション全体",
      multiScope: false,
      completionRatio: 1,
      baseline,
      allowGroupingStats: true,
      allowBaselineComparison: true,
    });
    const errorFinding = findings.find((f) =>
      f.id.startsWith("baseline_error_distance")
    );
    expect(errorFinding).toBeDefined();
    const current = errorFinding!.evidence.find((e) => e.metric === "今回の平均誤差距離");
    expect(current?.current).toBe(stats.coordinateError.averageErrorDistance);
    expect(current?.sampleSize).toBe(stats.coordinateError.sampleCount);
    const past_ = errorFinding!.evidence.find((e) =>
      e.metric.includes("比較可能な過去セッションの平均")
    );
    expect(past_?.current).toBe(past.stats.coordinateError.averageErrorDistance);
    expect(past_?.sampleSize).toBe(past.stats.coordinateError.sampleCount);
    // 差は生の統計値から再現できる（丸めた値を根拠にしていない）
    const relative = errorFinding!.evidence.find((e) => e.metric === "相対差");
    expect(relative?.difference).toBeCloseTo(
      (stats.coordinateError.averageErrorDistance! -
        past.stats.coordinateError.averageErrorDistance!) /
        past.stats.coordinateError.averageErrorDistance!,
      12
    );
    // 参照した report 自体にも比較対象の出所が残る
    expect(report.generatedFrom.comparisonSources.map((x) => x.sessionId)).toEqual([
      "past-worse",
    ]);

    // 投順別の分母は SessionStatistics の命中判定対象数と一致する
    const orderFinding = report.issueFindings.find((f) =>
      f.id.startsWith("dart_order_lateral_spread")
    );
    if (orderFinding) {
      const third = orderFinding.evidence.find((e) =>
        e.metric.startsWith("3投目の横方向ばらつき")
      );
      expect(third?.sampleSize).toBe(stats.byDartInSet["3"].throwCount);
    }
  });

  it("スキル診断はラウンドをまたいで合算せず、セッション単位の平均比較も行わない", () => {
    const groupingTarget = {
      ...T20,
      id: "r1",
      label: "R1",
      evaluationKind: "grouping_only" as const,
      roundId: "r1",
      roundKind: "grouping" as const,
    };
    const scoringTarget = {
      ...T20,
      id: "r2",
      label: "R2",
      evaluationKind: "exact_hit" as const,
      roundId: "r2",
      roundKind: "scoring" as const,
    };
    const specs: FixtureThrowSpec[] = [];
    for (let i = 0; i < 30; i += 1) {
      specs.push({
        target: groupingTarget,
        landing: landingFromCoordinate(REP.x + (i % 3) * 0.02, REP.y, STEEL_BOARD),
        setId: `r1-set-${Math.ceil((i + 1) / 3)}`,
      });
    }
    for (let i = 0; i < 30; i += 1) {
      specs.push({
        target: scoringTarget,
        landing: landingFromCoordinate(REP.x + 0.2, REP.y, STEEL_BOARD),
        setId: `r2-set-${Math.ceil((i + 1) / 3)}`,
      });
    }
    const session = makeSession({ trainingMode: "skill_check" });
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws);
    const past = pastSession("past-skill", "2025-12-20T10:00:00.000Z", 0.01);
    past.session = { ...past.session, trainingMode: "skill_check" };
    const report = analyzeLocalCoach({ session, stats, throws, comparisons: [past] });
    // ラウンドごとにスコープが分かれる
    expect(report.generatedFrom.scopes.map((s) => s.key).sort()).toEqual(["r1", "r2"]);
    // セッション単位の平均比較は行わない
    const all = [...report.issueFindings, ...(report.positiveFinding ? [report.positiveFinding] : [])];
    expect(all.some((f) => f.id.startsWith("baseline_"))).toBe(false);
  });

  it("バウンスアウトのみの投擲では位置に基づく所見を出さない", () => {
    const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
      target: T20,
      landing: landingBounceOut(),
      setId: `set-${Math.ceil((i + 1) / 3)}`,
    }));
    const session = makeSession();
    const throws = buildThrows(specs, 60);
    const stats = statsOf(session, throws);
    expect(precisionProfileOf(stats)).toBe("none");
    const report = analyzeLocalCoach({ session, stats, throws });
    const all = [...report.issueFindings, ...(report.positiveFinding ? [report.positiveFinding] : [])];
    expect(all.some((f) => f.id.startsWith("axis_"))).toBe(false);
    expect(all.some((f) => f.id.startsWith("dart_order_lateral_spread"))).toBe(false);
  });
});
