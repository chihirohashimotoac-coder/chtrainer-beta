import { describe, expect, it } from "vitest";
import {
  DEFAULT_Z,
  excludesZero,
  logSdRatioInterval,
  meanDiffInterval,
  meanInterval,
  meanWithStandardError,
  monotonicDirection,
  normalizedEffect,
  proportionDiffInterval,
  wilsonInterval,
} from "./statistics";

describe("区間推定（比率）", () => {
  it("分母0では区間を定義せず undefined を返す（0%として扱わない）", () => {
    expect(wilsonInterval(0, 0)).toBeUndefined();
    expect(proportionDiffInterval(0, 0, 1, 10)).toBeUndefined();
    expect(proportionDiffInterval(1, 10, 0, 0)).toBeUndefined();
  });

  it("Wilson区間は[0,1]をはみ出さない（0%・100%でも破綻しない）", () => {
    for (const [successes, total] of [
      [0, 10],
      [10, 10],
      [0, 1],
      [1, 1],
      [3, 7],
    ] as const) {
      const interval = wilsonInterval(successes, total)!;
      expect(interval.low, `${successes}/${total}`).toBeGreaterThanOrEqual(0);
      expect(interval.high, `${successes}/${total}`).toBeLessThanOrEqual(1);
      expect(interval.low).toBeLessThanOrEqual(interval.high);
    }
  });

  it("既知の値と一致する（50/100 の95%Wilson区間は約40.4%〜59.6%）", () => {
    const interval = wilsonInterval(50, 100, DEFAULT_Z)!;
    expect(interval.low).toBeCloseTo(0.4038, 3);
    expect(interval.high).toBeCloseTo(0.5962, 3);
  });

  it("分母が増えるほど区間が狭くなる（推定の確からしさが上がる）", () => {
    const small = wilsonInterval(5, 10)!;
    const large = wilsonInterval(50, 100)!;
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("同じ差でも分母が小さいと区間が0をまたぐ", () => {
    // どちらも「30ポイント差」だが、10投ずつでは向きが確定しない
    const few = proportionDiffInterval(7, 10, 4, 10);
    const many = proportionDiffInterval(70, 100, 40, 100);
    expect(excludesZero(few)).toBe(false);
    expect(excludesZero(many)).toBe(true);
  });
});

describe("区間推定（平均）", () => {
  it("2件未満では算出できない", () => {
    expect(meanWithStandardError([])).toBeUndefined();
    expect(meanWithStandardError([1])).toBeUndefined();
    expect(meanInterval([1])).toBeUndefined();
    expect(meanDiffInterval([1], [1, 2])).toBeUndefined();
  });

  it("平均と標準誤差が定義どおりに算出される", () => {
    const summary = meanWithStandardError([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(summary.mean).toBe(5);
    expect(summary.count).toBe(8);
    // 不偏分散 = 32/7、標準誤差 = sqrt(32/7/8)
    expect(summary.standardError).toBeCloseTo(Math.sqrt(32 / 7 / 8), 12);
  });

  it("ばらつきが同じなら、件数が多いほど平均差の区間が狭い", () => {
    const a = Array.from({ length: 10 }, (_, i) => i % 2);
    const b = Array.from({ length: 10 }, (_, i) => (i % 2) + 1);
    const bigA = Array.from({ length: 100 }, (_, i) => i % 2);
    const bigB = Array.from({ length: 100 }, (_, i) => (i % 2) + 1);
    const small = meanDiffInterval(a, b)!;
    const large = meanDiffInterval(bigA, bigB)!;
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });
});

describe("区間推定（ばらつきの比）", () => {
  it("標準偏差が0または件数不足なら算出しない", () => {
    expect(logSdRatioInterval(0, 10, 0.1, 10)).toBeUndefined();
    expect(logSdRatioInterval(0.1, 1, 0.1, 10)).toBeUndefined();
    expect(logSdRatioInterval(undefined, 10, 0.1, 10)).toBeUndefined();
  });

  it("同じ標準偏差なら区間は0(比1.0)を含む", () => {
    const interval = logSdRatioInterval(0.1, 30, 0.1, 30)!;
    expect(excludesZero(interval)).toBe(false);
    expect((interval.low + interval.high) / 2).toBeCloseTo(0, 12);
  });

  it("大きく違う標準偏差を十分な件数で見れば区間は0を含まない", () => {
    expect(excludesZero(logSdRatioInterval(0.3, 40, 0.1, 40))).toBe(true);
    // 件数が少なければ同じ比でも向きが確定しない
    expect(excludesZero(logSdRatioInterval(0.3, 3, 0.1, 3))).toBe(false);
  });
});

describe("効果量と単調性", () => {
  it("効果量は0〜1へ丸められ、基準以上なら1になる", () => {
    expect(normalizedEffect(0.15, 0.3)).toBeCloseTo(0.5, 12);
    expect(normalizedEffect(-0.15, 0.3)).toBeCloseTo(0.5, 12);
    expect(normalizedEffect(0.9, 0.3)).toBe(1);
    expect(normalizedEffect(undefined, 0.3)).toBe(0);
    expect(normalizedEffect(0.1, 0)).toBe(0);
  });

  it("単調な方向は、すべての区間で同じ向きのときだけ返す", () => {
    expect(monotonicDirection([1, 2, 3, 4])).toBe("increasing");
    expect(monotonicDirection([4, 3, 2, 1])).toBe("decreasing");
    expect(monotonicDirection([1, 3, 2, 4])).toBeUndefined();
    // 等しい値を含む場合は単調と見なさない
    expect(monotonicDirection([1, 2, 2, 3])).toBeUndefined();
    // 3点未満では方向を語らない
    expect(monotonicDirection([1, 2])).toBeUndefined();
  });
});
