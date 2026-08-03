import { describe, expect, it } from "vitest";
import {
  fixtureSession,
  handComputedThrows,
  mixedPrecisionThrows,
} from "../test/fixtures";
import { calculateStatistics } from "./stats";
import {
  compareStatistics,
  comparisonMismatches,
  isDissimilarComparison,
  rankComparisonCandidates,
  rankDissimilarCandidates,
} from "./compare";

describe("比較候補のスコアリング形式対応", () => {
  const base = fixtureSession({
    id: "base",
    trainingMode: "skill_check",
    scoringStyle: "fat_bull",
    startedAt: "2026-07-01T10:00:00.000Z",
  });
  const sameStyle = fixtureSession({
    id: "same-style",
    trainingMode: "skill_check",
    scoringStyle: "fat_bull",
    startedAt: "2026-06-01T10:00:00.000Z",
  });
  const otherStyle = fixtureSession({
    id: "other-style",
    trainingMode: "skill_check",
    scoringStyle: "steel",
    startedAt: "2026-06-30T10:00:00.000Z",
  });

  it("同じスコアリング形式のセッションを優先する", () => {
    const ranked = rankComparisonCandidates(base, [otherStyle, sameStyle]);
    expect(ranked[0]?.session.id).toBe("same-style");
    expect(ranked[0]?.reasons).toContain("同じスコアリング形式");
    expect(ranked[1]?.reasons).not.toContain("同じスコアリング形式");
  });

  it("形式未記録の旧セッションには形式ボーナスを与えない", () => {
    const legacy = fixtureSession({
      id: "legacy",
      trainingMode: "skill_check",
      startedAt: "2026-06-01T10:00:00.000Z",
    });
    const ranked = rankComparisonCandidates(base, [legacy]);
    expect(ranked[0]?.reasons).not.toContain("同じスコアリング形式");
  });

  it("形式が異なる比較は「条件が大きく異なる」と判定する", () => {
    expect(isDissimilarComparison(base, otherStyle)).toBe(true);
    expect(isDissimilarComparison(base, sameStyle)).toBe(false);
    // 片方が未記録(旧データ)の場合は形式差では非類似としない
    const legacy = fixtureSession({
      id: "legacy",
      trainingMode: "skill_check",
    });
    expect(isDissimilarComparison(base, legacy)).toBe(false);
  });
});

describe("比較候補のモード互換性", () => {
  const base = fixtureSession({
    id: "base-skill",
    trainingMode: "skill_check",
    startedAt: "2026-07-01T10:00:00.000Z",
  });
  const zeroOne = fixtureSession({
    id: "other-01",
    trainingMode: "zero_one",
    startedAt: "2026-06-30T10:00:00.000Z",
  });
  const sameMode = fixtureSession({
    id: "same-skill",
    trainingMode: "skill_check",
    startedAt: "2026-06-01T10:00:00.000Z",
  });

  it("モードが異なるセッションはおすすめ候補に含めない", () => {
    const ranked = rankComparisonCandidates(base, [zeroOne, sameMode]);
    expect(ranked.map((r) => r.session.id)).toEqual(["same-skill"]);
  });

  it("同モードが無ければおすすめ候補は空になる", () => {
    expect(rankComparisonCandidates(base, [zeroOne])).toHaveLength(0);
  });

  it("異モードは明示用の別リスト(rankDissimilarCandidates)に出る", () => {
    const dissimilar = rankDissimilarCandidates(base, [zeroOne, sameMode]);
    expect(dissimilar.map((r) => r.session.id)).toEqual(["other-01"]);
  });
});

describe("比較条件の差分判定(警告理由の正確化)", () => {
  const base = fixtureSession({
    id: "cmp-base",
    trainingMode: "skill_check",
    boardType: "soft",
    inputMethod: "coordinate",
    scoringStyle: "fat_bull",
  });

  it("同モード・同ボード・同入力で形式だけ異なる場合、形式差だけを検出する", () => {
    const other = fixtureSession({
      id: "cmp-scoring",
      trainingMode: "skill_check",
      boardType: "soft",
      inputMethod: "coordinate",
      scoringStyle: "separate_bull",
    });
    const m = comparisonMismatches(base, other);
    expect(m).toEqual({ mode: false, board: false, input: false, scoring: true });
    expect(isDissimilarComparison(base, other)).toBe(true);
  });

  it("モード差・ボード差・入力方式差を個別に検出する", () => {
    expect(
      comparisonMismatches(
        base,
        fixtureSession({ trainingMode: "zero_one", boardType: "soft", inputMethod: "coordinate", scoringStyle: "fat_bull" })
      )
    ).toEqual({ mode: true, board: false, input: false, scoring: false });
    expect(
      comparisonMismatches(
        base,
        fixtureSession({ trainingMode: "skill_check", boardType: "steel", inputMethod: "coordinate", scoringStyle: "fat_bull" })
      )
    ).toEqual({ mode: false, board: true, input: false, scoring: false });
    expect(
      comparisonMismatches(
        base,
        fixtureSession({ trainingMode: "skill_check", boardType: "soft", inputMethod: "simple", scoringStyle: "fat_bull" })
      )
    ).toEqual({ mode: false, board: false, input: true, scoring: false });
  });

  it("複数条件の差分を同時に列挙する", () => {
    const other = fixtureSession({
      trainingMode: "zero_one",
      boardType: "steel",
      inputMethod: "simple",
      scoringStyle: "steel",
    });
    expect(comparisonMismatches(base, other)).toEqual({
      mode: true,
      board: true,
      input: true,
      scoring: true,
    });
  });

  it("完全同条件では不一致を出さない", () => {
    const same = fixtureSession({
      id: "cmp-same",
      trainingMode: "skill_check",
      boardType: "soft",
      inputMethod: "coordinate",
      scoringStyle: "fat_bull",
    });
    expect(comparisonMismatches(base, same)).toEqual({
      mode: false,
      board: false,
      input: false,
      scoring: false,
    });
    expect(isDissimilarComparison(base, same)).toBe(false);
  });

  it("片方が形式未記録(旧データ)なら形式差では非類似としない", () => {
    const legacy = fixtureSession({
      trainingMode: "skill_check",
      boardType: "soft",
      inputMethod: "coordinate",
    });
    expect(comparisonMismatches(base, legacy).scoring).toBe(false);
  });
});

describe("N/A統計の比較", () => {
  it("片方がN/A(分母0)なら差もN/Aになる", () => {
    // R1グルーピング相当: 命中判定対象0 → 率はundefined
    const naStats = calculateStatistics("na", 60, []);
    const normal = calculateStatistics("normal", 6, handComputedThrows());
    const c = compareStatistics(naStats, normal);
    expect(normal.exactHitRate).toBeCloseTo(1 / 6);
    expect(c.hitRate.base).toBeUndefined();
    expect(c.hitRate.other).toBeCloseTo(1 / 6);
    expect(c.hitRate.diff).toBeUndefined();
    expect(c.byDartInSet["2"].hitRate.diff).toBeUndefined();
    expect(c.firstHalfHitRate.diff).toBeUndefined();
  });

  it("両方に分母があれば0.0%側も通常どおり差を計算する", () => {
    const normal = calculateStatistics("normal", 6, handComputedThrows());
    const c = compareStatistics(normal, normal);
    expect(c.hitRate.diff).toBeCloseTo(0);
  });
});

describe("比較の分母・サンプル数・入力精度", () => {
  const coordinateStats = calculateStatistics("coord", 6, handComputedThrows());
  const approximateStats = calculateStatistics(
    "approx",
    6,
    mixedPrecisionThrows()
  );

  it("率には命中判定対象数、平均誤差にはサンプル数を分母として添える", () => {
    const c = compareStatistics(coordinateStats, coordinateStats);
    // 命中率の分母 = 命中判定対象数(総投擲数ではない)
    expect(c.hitRate.baseSample).toBe(
      coordinateStats.scorableThrows ?? coordinateStats.completedThrows
    );
    expect(c.hitRate.otherSample).toBe(c.hitRate.baseSample);
    // 平均誤差距離の分母 = 誤差サンプル数(命中判定対象数とは別)
    expect(c.averageErrorDistance.baseSample).toBe(
      coordinateStats.combinedError.sampleCount
    );
    // 投順別・前後半・ターゲット別にもそれぞれの分母が付く
    expect(c.byDartInSet["1"].hitRate.baseSample).toBe(
      coordinateStats.byDartInSet["1"].scorableThrows ??
        coordinateStats.byDartInSet["1"].throwCount
    );
    expect(c.firstHalfHitRate.baseSample).toBe(
      coordinateStats.firstHalf.scorableThrows ??
        coordinateStats.firstHalf.throwCount
    );
    expect(c.secondHalfHitRate.baseSample).toBe(
      coordinateStats.secondHalf.scorableThrows ??
        coordinateStats.secondHalf.throwCount
    );
    const label = Object.keys(c.byTarget)[0];
    expect(label).toBeDefined();
    expect(c.byTarget[label!]!.hitRate.baseSample).toBeGreaterThan(0);
  });

  it("命中率の分母が総投擲数と異なる場合でも分母を正しく示す", () => {
    // グルーピング専用(命中判定対象0)を含めると分母 < 完了投擲数 になる
    const na = calculateStatistics("na", 60, []);
    const c = compareStatistics(na, coordinateStats);
    expect(c.hitRate.base).toBeUndefined();
    expect(c.hitRate.baseSample).toBe(0);
  });

  it("入力精度の内訳を比較結果に含め、混在を判別できる", () => {
    const c = compareStatistics(coordinateStats, approximateStats);
    expect(c.precision.base.coordinateInputCount).toBeGreaterThan(0);
    expect(c.precision.base.includesApproximation).toBe(false);
    expect(c.precision.other.approximateInputCount).toBeGreaterThan(0);
    expect(c.precision.other.includesApproximation).toBe(true);
  });
});
