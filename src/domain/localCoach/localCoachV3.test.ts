/**
 * ローカルコーチ v3 のテスト。
 *  - 基本回帰（安定・投順・前後半・偏り・分散・複合・小標本・入力精度）
 *  - 個人基準
 *  - 反証可能な原因仮説
 *  - 1変数実験
 * 外部AI・ネットワークへ依存しない決定論的テスト。
 */
import { describe, expect, it } from "vitest";
import { analyzeLocalCoach } from "./analyzeLocalCoach";
import { buildPersonalBaseline, unavailableBaseline } from "./personalBaseline";
import { EXPERIMENT_DESIGNS, isValidDesign, reproductionDesign } from "./experiments";
import { buildHypotheses, type HypothesisContext } from "./hypotheses";
import {
  MAX_HYPOTHESES_PER_CANDIDATE,
  MIN_ANALYZABLE_SAMPLE,
  MIN_PERSONAL_BASELINE_SESSIONS,
} from "./config";
import {
  adversarialFixture,
  approximateFixture,
  compositeFixture,
  conflictingHistoryFixture,
  dispersionFixture,
  insufficientFixture,
  mixedInputFixture,
  noPositionFixture,
  rightBiasFixture,
  secondHalfFixture,
  stableFixture,
  thirdDartFixture,
  weakEffectFixture,
  withHistoryFixture,
  type LocalCoachFixture,
} from "./fixtures";
import type { LocalCoachReport } from "./types";

function analyze(fixture: LocalCoachFixture): LocalCoachReport {
  return analyzeLocalCoach({
    session: fixture.current.session,
    stats: fixture.current.stats,
    throws: fixture.current.throws,
    comparisons: fixture.history.map((h) => ({
      session: h.session,
      stats: h.stats,
    })),
    recentSessions: fixture.history.map((h) => ({
      session: h.session,
      stats: h.stats,
    })),
  });
}

/** レポート全体から、コーチが主張している文だけを集める。 */
function assertiveText(report: LocalCoachReport): string {
  const findings = [
    ...(report.positiveFinding ? [report.positiveFinding] : []),
    ...report.issueFindings,
  ];
  return findings
    .flatMap((f) => [f.title, f.summary, ...(f.hypotheses ?? []).map((h) => h.statement)])
    .join("\n");
}

const NEUTRAL_CONTEXT: HypothesisContext = {
  firedSubjects: new Set(),
  hasHalfChange: false,
  hasTempoChange: false,
  hasOverCorrection: false,
  hasTargetSwitchSamples: true,
  coordinateCount: 60,
  approximateCount: 0,
  selfAssessment: {
    fatigueMeasured: true,
    fatigueChanged: false,
    concentrationMeasured: true,
    concentrationChanged: false,
  },
};

describe("v3 基本回帰", () => {
  it("1. 安定60投でFalse Positiveを出さない", () => {
    const report = analyze(stableFixture());
    expect(report.analyzable).toBe(true);
    expect(report.issueFindings).toHaveLength(0);
    expect(report.allCandidates).toHaveLength(0);
    expect(report.recommendedAction).toBeUndefined();
    // 課題なしのときは安定範囲を示す
    expect(report.stableRange?.length ?? 0).toBeGreaterThan(0);
  });

  it("2. 3投目のみ悪化を投順の問題として検出する", () => {
    const report = analyze(thirdDartFixture());
    const top = report.issueFindings[0];
    expect(top).toBeDefined();
    expect(top!.subject).toContain("dart_order_3");
    expect(top!.title).toContain("3投目");
    // 主題の実測値が最初の観測事実に来る
    expect(top!.evidence[0]!.metric).toContain("3投目");
  });

  it("3. 後半のみ悪化を時間区間の問題として検出する", () => {
    const report = analyze(secondHalfFixture());
    const subjects = report.allCandidates.map((c) => c.subject ?? "");
    expect(subjects.some((s) => s.startsWith("half_"))).toBe(true);
  });

  it("4. 小分散の右偏りを系統偏りとして検出する（分散増大と混同しない）", () => {
    const report = analyze(rightBiasFixture());
    const ids = report.allCandidates.map((c) => c.id);
    expect(ids.some((id) => id.startsWith("axis_bias_x"))).toBe(true);
    expect(ids.some((id) => id.startsWith("axis_dispersion_x"))).toBe(false);
    expect(assertiveText(report)).toContain("右");
  });

  it("5/6. 平均0・大SDを分散増大として検出し、偏りと混同しない", () => {
    const report = analyze(dispersionFixture());
    const ids = report.allCandidates.map((c) => c.id);
    expect(ids.some((id) => id.startsWith("axis_dispersion_x"))).toBe(true);
    expect(ids.some((id) => id.startsWith("axis_bias_x"))).toBe(false);
    expect(assertiveText(report)).not.toContain("側へ寄っています");
  });

  it("7. 複合問題で上位候補と未掲載候補の両方を保持する", () => {
    const report = analyze(compositeFixture());
    expect(report.allCandidates.length).toBeGreaterThanOrEqual(3);
    expect(report.issueFindings.length).toBeLessThanOrEqual(2);
    // 上位に入らなかった候補も存在自体は保持される
    expect(report.unrankedCandidates.length).toBeGreaterThan(0);
    for (const candidate of report.unrankedCandidates) {
      expect(candidate.hiddenReason).toContain("表示上限");
      expect(candidate.rank).toBeGreaterThan(report.issueFindings.length);
    }
    // 全候補は優先度順で欠番がない
    expect(report.allCandidates.map((c) => c.rank)).toEqual(
      report.allCandidates.map((_, index) => index + 1)
    );
  });

  it("8. 9投以下では原因仮説も実験も生成しない", () => {
    const report = analyze(insufficientFixture());
    expect(report.analyzable).toBe(false);
    expect(report.issueFindings).toHaveLength(0);
    expect(report.recommendedAction).toBeUndefined();
    expect(report.allCandidates).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain("仮説");
  });

  it("9. 簡易入力では座標由来の標準偏差やmm値を生成しない", () => {
    const report = analyze(approximateFixture());
    // JSONのキー名("summary"等)を誤検知しないよう、表示される文字列だけを見る
    const shown = [
      ...report.issueFindings.flatMap((f) => [
        f.title,
        f.summary,
        ...f.evidence.map((e) => `${e.metric}${e.note ?? ""}`),
      ]),
      ...(report.recommendedAction
        ? [report.recommendedAction.method, report.recommendedAction.purpose]
        : []),
    ].join("\n");
    expect(shown).not.toContain("標準偏差");
    expect(shown).not.toContain("mm");
    // 方向頻度としては扱う
    expect(report.allCandidates.some((c) => c.id.startsWith("direction_bias"))).toBe(
      true
    );
  });

  it("10. Mixed入力を同一座標母集団として混合しない", () => {
    const fixture = mixedInputFixture();
    const report = analyze(fixture);
    const coordinateCount = fixture.current.stats.coordinateInputCount;
    for (const finding of report.issueFindings) {
      for (const fact of finding.observedFacts ?? []) {
        if (fact.precision === "coordinate") {
          // 座標由来の指標の分母は詳細座標の投擲数を超えない
          expect(fact.sampleSize).toBeLessThanOrEqual(coordinateCount);
        }
      }
    }
  });

  it("11. 比較履歴がなければ個人基準を捏造しない", () => {
    const report = analyze(thirdDartFixture());
    expect(report.generatedFrom.comparisonSessionCount).toBe(0);
    for (const finding of report.issueFindings) {
      if (finding.personalBaseline) {
        expect(finding.personalBaseline.pattern).toBe("unavailable");
        expect(finding.personalBaseline.median).toBeUndefined();
      }
    }
  });

  it("位置なし(全バウンスアウト)では位置に基づく所見を出さない", () => {
    const report = analyze(noPositionFixture());
    const ids = report.allCandidates.map((c) => c.id);
    expect(ids.some((id) => id.startsWith("axis_"))).toBe(false);
    expect(ids.some((id) => id.includes("_spread_"))).toBe(false);
  });

  it("閾値付近の弱い効果では確からしさを「高」にしない", () => {
    const report = analyze(weakEffectFixture());
    for (const candidate of report.allCandidates) {
      if (candidate.id.includes("_spread_")) {
        expect(candidate.confidence).not.toBe("high");
      }
    }
  });

  it("adversarial: 投順とターゲット難度が交絡している場合、投順固有と断定しない", () => {
    const report = analyze(adversarialFixture());
    const text = assertiveText(report);
    expect(text).not.toContain("投順そのものが原因");
    expect(text).not.toContain("3投目の投げ方が原因");
    // 仮説として提示する場合も、必ず反証条件を持つ
    for (const finding of report.issueFindings) {
      for (const hypothesis of finding.hypotheses ?? []) {
        expect(hypothesis.ifFalse.length).toBeGreaterThan(0);
      }
    }
  });

  it("同じ入力から常に同じ結果を返す（決定論性）", () => {
    for (const factory of [thirdDartFixture, compositeFixture, withHistoryFixture]) {
      const fixture = factory();
      const first = analyze(fixture);
      const second = analyzeLocalCoach({
        session: fixture.current.session,
        stats: fixture.current.stats,
        throws: fixture.current.throws.slice().reverse(),
        comparisons: fixture.history.map((h) => ({
          session: h.session,
          stats: h.stats,
        })),
        recentSessions: fixture.history.map((h) => ({
          session: h.session,
          stats: h.stats,
        })),
      });
      expect(JSON.stringify(second), fixture.key).toBe(JSON.stringify(first));
    }
  });
});

describe("v3 個人基準", () => {
  it("1/2. 比較可能な履歴だけを採用し、比較不能なモード・精度は除外する", () => {
    const fixture = withHistoryFixture();
    const report = analyze(fixture);
    expect(report.generatedFrom.comparisonSessionCount).toBe(
      fixture.history.length
    );
    // モードが違う履歴は採用されない
    const otherMode = analyzeLocalCoach({
      session: fixture.current.session,
      stats: fixture.current.stats,
      throws: fixture.current.throws,
      comparisons: fixture.history.map((h) => ({
        session: { ...h.session, trainingMode: "cricket" as const },
        stats: h.stats,
      })),
    });
    expect(otherMode.generatedFrom.comparisonSessionCount).toBe(0);
  });

  it("3/4. 過去中央値・変動幅・今回との差を正しく計算する", () => {
    const baseline = buildPersonalBaseline({
      metric: "テスト指標",
      currentValue: 0.2,
      history: [0.1, 0.12, 0.08],
      lowerIsBetter: true,
    });
    expect(baseline.median).toBeCloseTo(0.1, 12);
    expect(baseline.range).toEqual({ low: 0.08, high: 0.12 });
    expect(baseline.differenceFromMedian).toBeCloseTo(1.0, 12);
    expect(baseline.sessionCount).toBe(3);
  });

  it("5. 履歴不足ならN/Aとし、理由を残す（捏造しない）", () => {
    const baseline = buildPersonalBaseline({
      metric: "テスト指標",
      currentValue: 0.2,
      history: [0.1, 0.12],
      lowerIsBetter: true,
    });
    expect(baseline.pattern).toBe("unavailable");
    expect(baseline.median).toBeUndefined();
    expect(baseline.range).toBeUndefined();
    expect(baseline.unavailableReason).toContain(
      `${MIN_PERSONAL_BASELINE_SESSIONS}件`
    );
    // 今回値が未測定の場合も同様
    expect(
      buildPersonalBaseline({
        metric: "テスト指標",
        history: [0.1, 0.12, 0.08],
        lowerIsBetter: true,
      }).pattern
    ).toBe("unavailable");
  });

  it("6. 単発悪化と継続悪化を区別する", () => {
    // 変動幅の内側 → 通常のばらつき
    expect(
      buildPersonalBaseline({
        metric: "m",
        currentValue: 0.1,
        history: [0.08, 0.1, 0.12],
        lowerIsBetter: true,
      }).pattern
    ).toBe("within_variation");
    // 変動幅の外だが方向が続いていない → 単発変動
    expect(
      buildPersonalBaseline({
        metric: "m",
        currentValue: 0.3,
        history: [0.12, 0.08, 0.1],
        lowerIsBetter: true,
      }).pattern
    ).toBe("single_deviation");
    // 変動幅の外で単調に悪化し続けている → 継続傾向
    expect(
      buildPersonalBaseline({
        metric: "m",
        currentValue: 0.3,
        history: [0.08, 0.1, 0.12],
        lowerIsBetter: true,
      }).pattern
    ).toBe("continuing_trend");
  });

  it("7. エンジンVersionを基準へ明示的に持つ", () => {
    const baseline = buildPersonalBaseline({
      metric: "m",
      currentValue: 0.2,
      history: [0.1, 0.12, 0.08],
      lowerIsBetter: true,
    });
    expect(baseline.engineVersion).toMatch(/^local-coach-v/);
    expect(unavailableBaseline("m", 0, "理由").engineVersion).toMatch(
      /^local-coach-v/
    );
  });

  it("履歴と当日傾向が矛盾する場合も、両方を保持して断定しない", () => {
    const report = analyze(conflictingHistoryFixture());
    expect(report.generatedFrom.comparisonSessionCount).toBe(3);
    // 当日内の投順悪化は検出される
    expect(
      report.allCandidates.some((c) => (c.subject ?? "").startsWith("dart_order_3"))
    ).toBe(true);
  });
});

describe("v3 原因仮説", () => {
  const report = analyze(thirdDartFixture());
  const top = report.issueFindings[0]!;

  it("1. 観測事実と仮説が別フィールドに分かれている", () => {
    expect(top.observedFacts?.length ?? 0).toBeGreaterThan(0);
    expect(top.hypotheses?.length ?? 0).toBeGreaterThan(0);
    // 観測事実に仮説的な語を混ぜない
    for (const fact of top.observedFacts ?? []) {
      expect(fact.metric).not.toContain("可能性");
      expect(fact.metric).not.toContain("原因");
    }
  });

  it("2/3/4. 仮説に支持根拠・反証条件・不足データがある", () => {
    for (const hypothesis of top.hypotheses ?? []) {
      expect(hypothesis.supporting.length).toBeGreaterThan(0);
      expect(hypothesis.contradicting.length).toBeGreaterThan(0);
      expect(hypothesis.missingData.length).toBeGreaterThan(0);
      expect(hypothesis.ifTrue.length).toBeGreaterThan(0);
      expect(hypothesis.ifFalse.length).toBeGreaterThan(0);
      expect(hypothesis.distinguishedBy.length).toBeGreaterThan(0);
    }
  });

  it("仮説は1課題あたり最大2件", () => {
    for (const finding of report.issueFindings) {
      expect((finding.hypotheses ?? []).length).toBeLessThanOrEqual(
        MAX_HYPOTHESES_PER_CANDIDATE
      );
    }
  });

  it("5. 身体原因を断定せず、必ず外部確認の指定を伴う", () => {
    const BODY_TERMS = ["肘", "肩", "手首", "グリップ圧", "リリース位置", "フォロースルー"];
    for (const factory of [rightBiasFixture, dispersionFixture, secondHalfFixture]) {
      const r = analyze(factory());
      for (const finding of r.issueFindings) {
        for (const hypothesis of finding.hypotheses ?? []) {
          const mentionsBody = BODY_TERMS.some((term) =>
            `${hypothesis.statement}${hypothesis.label}`.includes(term)
          );
          if (mentionsBody) {
            expect(hypothesis.requiresExternalCheck, hypothesis.id).toBeDefined();
          }
          // 断定形にせず、必ず不確実性を含む表現にする
          expect(hypothesis.statement, hypothesis.id).toMatch(
            /(可能性|未確認|かもしれ)/
          );
        }
        // 観測事実の見出しへ身体原因を混ぜない
        for (const term of BODY_TERMS) {
          expect(finding.title, term).not.toContain(term);
        }
      }
    }
  });

  it("6. 自己評価とデータの矛盾を保持する（疲労を原因と断定しない）", () => {
    // 疲労・集中が「回答済みかつ変化なし」のとき、矛盾として明示される
    const hypotheses = buildHypotheses("half_hit_rate_down_session", "後半の命中率", {
      ...NEUTRAL_CONTEXT,
      hasHalfChange: true,
    });
    const throwCount = hypotheses.find((h) => h.id === "half_throw_count")!;
    expect(throwCount.contradicting.join("\n")).toContain("自己評価");
    expect(throwCount.contradicting.join("\n")).toContain("断定できません");
    expect(throwCount.requiresExternalCheck).toBeDefined();
  });

  it("6b. 未回答の自己評価は測定値として扱わず、未測定として示す", () => {
    const hypotheses = buildHypotheses("half_hit_rate_down_session", "後半の命中率", {
      ...NEUTRAL_CONTEXT,
      selfAssessment: {
        fatigueMeasured: false,
        fatigueChanged: false,
        concentrationMeasured: false,
        concentrationChanged: false,
      },
    });
    const throwCount = hypotheses.find((h) => h.id === "half_throw_count")!;
    // 未回答は「変化なし」として矛盾に使わない
    expect(throwCount.contradicting.join("\n")).not.toContain("変化していません");
    // 代わりに不足データとして明示する
    expect(throwCount.missingData.join("\n")).toContain("未回答");
  });

  it("7. 同一データで区別できない仮説は順位を断定しない", () => {
    const report2 = analyze(adversarialFixture());
    const switchFinding = report2.issueFindings.find((f) =>
      (f.subject ?? "").startsWith("target_switch")
    );
    const target = switchFinding ?? report2.issueFindings[0];
    if (target && (target.hypotheses ?? []).length >= 2) {
      const text = (target.hypotheses ?? [])
        .flatMap((h) => h.contradicting)
        .join("\n");
      // 区別不能な組なら、その旨が矛盾側へ明示される
      const distinguishers = new Set(
        (target.hypotheses ?? []).map((h) => h.distinguishedBy)
      );
      if (distinguishers.size < (target.hypotheses ?? []).length) {
        expect(text).toContain("区別できません");
      }
    }
  });
});

describe("v3 1変数実験", () => {
  it("すべての実験設計が必須要素と最小分母を満たす", () => {
    for (const [key, design] of Object.entries(EXPERIMENT_DESIGNS)) {
      expect(isValidDesign(design), key).toBe(true);
      // 1. 変更要因が1つ（「かどうか」または単一項目として表現される）
      expect(design.changedFactor, key).not.toContain("および");
      // 2. 対照条件と介入条件が存在
      expect(design.control.label, key).toMatch(/^A/);
      expect(design.intervention.label, key).toMatch(/^B/);
      // 3. 各条件の必要分母を満たす
      expect(design.control.throwCount, key).toBeGreaterThanOrEqual(
        MIN_ANALYZABLE_SAMPLE
      );
      expect(design.intervention.throwCount, key).toBeGreaterThanOrEqual(
        MIN_ANALYZABLE_SAMPLE
      );
      // 6. 仮説否定条件が存在
      expect(design.falsificationCriteria.length, key).toBeGreaterThan(0);
      // ガードレールと次の分岐
      expect(design.guardrailMetrics.length, key).toBeGreaterThan(0);
      expect(design.nextBranch.length, key).toBeGreaterThan(0);
    }
  });

  it("4/5/6/7. 生成された実験が所見と対応し、成功・否定・中止基準を持つ", () => {
    const report = analyze(thirdDartFixture());
    const action = report.recommendedAction!;
    const top = report.issueFindings[0]!;
    expect(action.targetFindingId).toBe(top.id);
    // 主要指標が所見の主指標と一致
    expect(action.primaryMetric).toBe(top.primaryMetric);
    // 成功条件が数値化されている
    expect(action.successCriteria.join("")).toMatch(/\d/);
    expect(action.falsificationCriteria?.length ?? 0).toBeGreaterThan(0);
    expect(action.stopOrChangeCriteria.length).toBeGreaterThan(0);
    expect(action.nextBranch?.length ?? 0).toBeGreaterThan(0);
    // 合計投擲数は両条件の合計
    expect(action.throwCount).toBe(
      action.control!.throwCount + action.intervention!.throwCount
    );
  });

  it("8. 複数のフォーム変更を同時に勧めない", () => {
    for (const factory of [thirdDartFixture, rightBiasFixture, dispersionFixture]) {
      const action = analyze(factory()).recommendedAction;
      if (!action) continue;
      expect(action.avoid, action.id).toContain("同時に変更しない");
      // 介入条件の説明に「かつ」で複数要因を並べない
      expect(action.intervention!.description).not.toContain("かつ");
    }
  });

  it("9. ターゲット切替の実験は難度を揃えて交絡を分離する", () => {
    const design = EXPERIMENT_DESIGNS.target_switch_hit_rate_down!;
    expect(design.changedFactor).toContain("難度は揃える");
    expect(
      `${design.intervention.label}${design.intervention.description}`
    ).toContain("同一難度");
    expect(design.falsificationCriteria.join("\n")).toContain("難度");
  });

  it("系統偏りの実験は散らばりを、分散増大の実験は平均位置をガードレールにする", () => {
    expect(EXPERIMENT_DESIGNS.axis_bias!.guardrailMetrics.join("\n")).toContain(
      "標準偏差"
    );
    expect(
      EXPERIMENT_DESIGNS.axis_dispersion!.guardrailMetrics.join("\n")
    ).toContain("平均誤差");
    // 分散増大では平均位置の補正を主目的にしない
    expect(EXPERIMENT_DESIGNS.axis_dispersion!.changedFactor).not.toContain("狙点の位置");
  });

  it("専用設計がないテンプレートは再現確認へ落とし、断定的な実験にしない", () => {
    const design = reproductionDesign("テスト指標");
    expect(isValidDesign(design)).toBe(true);
    expect(design.changedFactor).toContain("なし");
    expect(design.falsificationCriteria.join("\n")).toContain("再現しなかった");
  });
});
