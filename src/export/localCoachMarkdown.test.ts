import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { STEEL_BOARD } from "../config/boardProfiles";
import { MAX_EMBEDDED_MARKDOWN_CHARS } from "../config/constants";
import { landingFromCoordinate } from "../domain/landing";
import { calculateStatistics } from "../domain/stats";
import { MAX_LOCAL_COACH_SECTION_CHARS, ENGINE_VERSION } from "../domain/localCoach/config";
import { buildThrows, fixtureSession, T20 } from "../test/fixtures";
import type { FixtureThrowSpec } from "../test/fixtures";
import type { SessionStatistics, TrainingSession } from "../types/models";
import { buildSessionCsv } from "./csv";
import {
  ANALYSIS_INSTRUCTIONS,
  OUTPUT_FORMAT_INSTRUCTIONS,
  buildAnalysisMarkdown,
  inputPrecisionSection,
  inputPrecisionModeOf,
} from "./markdown";
import {
  LOCAL_COACH_HANDLING_HEADING,
  LOCAL_COACH_HANDLING_INSTRUCTIONS,
  LOCAL_COACH_SECTION_HEADING,
  buildLocalCoachMarkdown,
  fmtRelativeDiff,
} from "./localCoachMarkdown";
import { buildAnalysisZip } from "./zip";

const REP = T20.representativePoint;
const CALCULATED_AT = "2026-01-01T11:00:00.000Z";

function scenario(setCount: number) {
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
  const session: TrainingSession = fixtureSession({
    setCount,
    plannedThrowCount: setCount * 3,
    plannedTargets: Array.from({ length: setCount }, () => [T20, T20, T20]),
    status: setCount >= 20 ? "completed" : "aborted",
  });
  const throws = buildThrows(specs, setCount * 3);
  const stats: SessionStatistics = calculateStatistics(
    session.id,
    session.plannedThrowCount,
    throws,
    session.trainingMode,
    CALCULATED_AT
  );
  return { session, throws, stats };
}

const setNumberOf = (setId: string) => Number(setId.replace("set-", ""));

function markdownOf(
  data: ReturnType<typeof scenario>,
  embedAllThrows: boolean
): string {
  return buildAnalysisMarkdown({
    session: data.session,
    player: undefined,
    equipment: undefined,
    stats: data.stats,
    throws: data.throws,
    setNumberOf,
    comparisons: [],
    embedAllThrows,
  });
}

/** ローカルコーチ節（見出しから次の "## " まで）を切り出す。 */
function localCoachSection(markdown: string): string {
  const start = markdown.indexOf(LOCAL_COACH_SECTION_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + LOCAL_COACH_SECTION_HEADING.length);
  const end = rest.indexOf("\n## ");
  return LOCAL_COACH_SECTION_HEADING + (end === -1 ? rest : rest.slice(0, end));
}

describe("AI依頼文へのローカルコーチ分析の埋め込み", () => {
  const rich = scenario(20);

  it("ローカルコーチの見出しが1回だけ出力される", () => {
    for (const embed of [true, false]) {
      const md = markdownOf(rich, embed);
      const occurrences = md.split(LOCAL_COACH_SECTION_HEADING).length - 1;
      expect(occurrences, `embedAllThrows=${embed}`).toBe(1);
      const handling = md.split(LOCAL_COACH_HANDLING_HEADING).length - 1;
      expect(handling, `embedAllThrows=${embed}`).toBe(1);
    }
  });

  it("生成AIではない旨とエンジンバージョンが表示される", () => {
    const section = localCoachSection(markdownOf(rich, true));
    expect(section).toContain("この分析は、アプリ内の決定ルールと統計計算による事前評価です。");
    expect(section).toContain("生成AIによる回答ではありません。");
    expect(section).toContain(`- 分析エンジン: ${ENGINE_VERSION}`);
    expect(ENGINE_VERSION).toBe("local-coach-v2.0");
  });

  it("外部AIへ独立検証を要求する指示が含まれる", () => {
    const md = markdownOf(rich, true);
    expect(md).toContain(LOCAL_COACH_HANDLING_INSTRUCTIONS);
    expect(md).toContain(
      "ローカルコーチの結論を無条件に採用せず、後続の統計値と全投擲データから独立して検証してください。"
    );
    expect(md).toContain(
      "一致しない場合は、ローカルコーチ分析のどの判定または前提に問題があるかを明示してください。"
    );
    expect(md).toContain("ローカルコーチが検出していない重要な傾向も探索してください。");
  });

  it("embedAllThrows=true と false の両方で同じローカルコーチ分析が出力される", () => {
    const embedded = localCoachSection(markdownOf(rich, true));
    const attached = localCoachSection(markdownOf(rich, false));
    expect(attached).toBe(embedded);
    expect(embedded.length).toBeGreaterThan(0);
  });

  it("ZIP内のanalysis-request.mdと単独生成Markdownが一致する", async () => {
    const md = markdownOf(rich, false);
    const csv = buildSessionCsv(rich.session, rich.throws, setNumberOf);
    const blob = await buildAnalysisZip(md, csv, rich.session);
    // jsdom の Blob には arrayBuffer() がないため FileReader を使う（既存テストと同じ方式）
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = await JSZip.loadAsync(bytes);
    const inZip = await zip.file("analysis-request.md")!.async("string");
    expect(inZip).toBe(md);
    expect(localCoachSection(inZip)).toBe(localCoachSection(md));
  });

  it("文字数プレビューに使う生成結果へも反映される（生成が純粋関数で一致する）", () => {
    const a = markdownOf(rich, true);
    const b = markdownOf(rich, true);
    expect(b).toBe(a);
    expect(a.length).toBeGreaterThan(MAX_EMBEDDED_MARKDOWN_CHARS);
  });

  it("ローカルコーチ節は1,800文字を超えない", () => {
    for (const data of [rich, scenario(3), scenario(40)]) {
      for (const embed of [true, false]) {
        const section = localCoachSection(markdownOf(data, embed));
        expect(section.length).toBeLessThanOrEqual(MAX_LOCAL_COACH_SECTION_CHARS);
      }
    }
  });

  it("配置がセッション概要・統計・比較のあと、データ利用上の注意と出力フォーマット指定の前になる", () => {
    const md = markdownOf(rich, true);
    const order = [
      "## セッション概要",
      "## アプリ算出の基本統計",
      "## 過去セッションとの比較",
      LOCAL_COACH_SECTION_HEADING,
      LOCAL_COACH_HANDLING_HEADING,
      "## データ利用上の注意",
      "## 回答のフォーマットとトーン",
    ].map((heading) => md.indexOf(heading));
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i], `${i}番目の見出しの順序`).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("既存のAI分析指示・入力精度別指示・診断禁止ルールを削除していない", () => {
    const md = markdownOf(rich, true);
    expect(md).toContain(ANALYSIS_INSTRUCTIONS);
    expect(md).toContain(OUTPUT_FORMAT_INSTRUCTIONS);
    expect(md).toContain(
      inputPrecisionSection(inputPrecisionModeOf(rich.stats), rich.stats, rich.session)
    );
    expect(md).toContain("### 入力精度に応じた分析指示");
    expect(md).toContain("医学的診断、心理的診断、性格診断は禁止です。");
    expect(md).toContain(
      "このデータは個人のトレーニング記録です。分析は運動学習の参考情報であり、医学的診断を行わないでください。"
    );
  });

  it("数値の丸め規則が既存フォーマットと一致する", () => {
    const section = localCoachSection(markdownOf(rich, true));
    // 正規化座標は小数3桁 (fmtNum)
    expect(section).toMatch(/ばらつき\(標準偏差\): \d+\.\d{3} /);
    // 率は小数1桁の% (fmtRate)、相対差は "pt" ではなく "%"
    expect(fmtRelativeDiff(0.1234)).toBe("+12.3%");
    expect(fmtRelativeDiff(-0.1234)).toBe("-12.3%");
    expect(fmtRelativeDiff(undefined)).toBe("N/A");
    // 分母が必ず併記される
    expect(section).toMatch(/分母\d+/);
  });

  it("身体動作・医学・心理の断定を含む見出しを出力しない", () => {
    const section = localCoachSection(markdownOf(rich, true));
    // 「判断できないこと」として列挙するのは可。断定形の文言がないことを確認する。
    for (const phrase of [
      "肘が下がっています",
      "肩が開いています",
      "手首を使いすぎています",
      "グリップが強くなっています",
      "リリースが早い",
      "メンタルが弱い",
      "集中力がない",
      "イップス",
    ]) {
      expect(section, phrase).not.toContain(phrase);
    }
  });
});

describe("データ不足時のローカルコーチ表示", () => {
  const scarce = scenario(2); // 6投

  it("架空の分析を生成せず、分析不能として理由を示す", () => {
    const section = localCoachSection(markdownOf(scarce, true));
    expect(section).toContain("- 分析可能性: 不足");
    expect(section).toContain("### 分析結果");
    expect(section).toContain("主要な傾向は判定できません。");
    expect(section).toContain("理由:");
    expect(section).toContain("完了投擲数が最低分析数10投を下回っています");
    expect(section).toContain(
      "比較可能な過去セッションがないため、本人平均との差は分析できません。"
    );
    expect(section).toContain(
      "今回はフォームや技術上の結論を出さず、記録の継続を推奨します。"
    );
    // 課題・推奨メニューは出さない
    expect(section).not.toContain("### 最優先の課題");
    expect(section).not.toContain("### 次回の推奨メニュー");
  });

  it("分析不能でも外部AIへの独立検証指示は維持される", () => {
    const md = markdownOf(scarce, true);
    expect(md).toContain(LOCAL_COACH_HANDLING_INSTRUCTIONS);
  });
});

describe("ローカルコーチMarkdownの整形（単体）", () => {
  it("分母0はN/Aとして表示し、0%として扱わない", () => {
    const section = buildLocalCoachMarkdown({
      engineVersion: ENGINE_VERSION,
      generatedFrom: {
        completedThrows: 30,
        plannedThrowCount: 30,
        completionRatio: 1,
        coordinateInputCount: 30,
        approximateInputCount: 0,
        comparisonSessionCount: 0,
        comparisonSources: [],
        scopes: [],
      },
      analyzable: true,
      issueFindings: [
        {
          id: "x",
          kind: "statistical_trend",
          priority: 1,
          effect: 0.5,
          severity: 0.35,
          title: "t",
          summary: "s",
          confidence: "medium",
          evidence: [{ metric: "未測定の指標", sampleSize: 0, unit: "rate" }],
          limitations: [],
        },
      ],
      unavailableReasons: [],
    });
    expect(section).toContain("- 未測定の指標: N/A / 分母0(N/A)");
    expect(section).not.toContain("0.0%");
  });

  it("良かった点・課題・推奨メニューの見出しが上限件数どおりに並ぶ", () => {
    const section = localCoachSection(markdownOf(scenario(20), true));
    expect(section.split("### 良かった点").length - 1).toBeLessThanOrEqual(1);
    expect(section.split("### 最優先の課題").length - 1).toBeLessThanOrEqual(1);
    expect(section.split("### 次に優先する課題").length - 1).toBeLessThanOrEqual(1);
    expect(section.split("### 次回の推奨メニュー").length - 1).toBeLessThanOrEqual(1);
  });

  it("相対差の根拠行は、指標名の直後に実測値を置く（%を指標値と読み違えない）", () => {
    const section = buildLocalCoachMarkdown({
      engineVersion: ENGINE_VERSION,
      generatedFrom: {
        completedThrows: 60,
        plannedThrowCount: 60,
        completionRatio: 1,
        coordinateInputCount: 60,
        approximateInputCount: 0,
        comparisonSessionCount: 0,
        comparisonSources: [],
        scopes: [],
      },
      analyzable: true,
      issueFindings: [
        {
          id: "x",
          kind: "statistical_trend",
          priority: 1,
          effect: 0.5,
          severity: 0.35,
          title: "t",
          summary: "s",
          confidence: "medium",
          evidence: [
            {
              metric: "後半の平均誤差距離",
              current: 0.182,
              baseline: 0.083,
              difference: 1.2,
              sampleSize: 40,
              unit: "ratio",
            },
          ],
          limitations: [],
        },
      ],
      unavailableReasons: [],
    });
    expect(section).toContain(
      "- 後半の平均誤差距離: 0.182 / 基準比 +120.0% (基準 0.083) / 分母40"
    );
  });

  it("率の根拠には95%区間を併記し、有意性の主張はしない", () => {
    const section = buildLocalCoachMarkdown({
      engineVersion: ENGINE_VERSION,
      generatedFrom: {
        completedThrows: 60,
        plannedThrowCount: 60,
        completionRatio: 1,
        coordinateInputCount: 60,
        approximateInputCount: 0,
        comparisonSessionCount: 0,
        comparisonSources: [],
        scopes: [],
      },
      analyzable: true,
      issueFindings: [
        {
          id: "x",
          kind: "statistical_trend",
          priority: 1,
          effect: 0.5,
          severity: 0.35,
          title: "t",
          summary: "s",
          confidence: "medium",
          evidence: [
            {
              metric: "3投目の命中率",
              current: 0.5,
              sampleSize: 100,
              unit: "rate",
              interval: { low: 0.4038, high: 0.5962 },
            },
          ],
          limitations: [],
        },
      ],
      unavailableReasons: [],
    });
    expect(section).toContain(
      "- 3投目の命中率: 50.0% / 分母100 / 95%区間 40.4%〜59.6%"
    );
    // 区間の読み方を1行で説明し、「有意」とは述べない
    expect(section).toContain("95%区間」は推定のぶれ幅の目安です");
    expect(section).not.toContain("有意差");
    expect(section).not.toContain("統計的に有意");
  });

  it("推奨メニューに目的・実施方法・投擲数・意識すること・記録項目・成功判定が含まれる", () => {
    const section = localCoachSection(markdownOf(scenario(20), true));
    for (const label of [
      "目的:",
      "実施方法:",
      "意識すること:",
      "意識してはいけないこと:",
      "記録する項目:",
      "成功判定:",
    ]) {
      expect(section, label).toContain(label);
    }
    expect(section).toMatch(/合計\d+投/);
  });
});
