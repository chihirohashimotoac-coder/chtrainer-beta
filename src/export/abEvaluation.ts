/**
 * A/B評価用のPrompt生成。
 *
 * 同一データに対して次の2種類を決定論的に生成する。
 *  - production: 本番版(2.6.0)相当。ローカルコーチの2節を含まない依頼文。
 *  - beta:       ベータ版。ローカルコーチ節と扱いの節を含む依頼文。
 *
 * production は「ベータ版の出力から、追加した2節だけを取り除いたもの」として
 * 作る。本番版のMarkdown生成はローカルコーチ節の挿入以外を変更していないため、
 * この方法で本番版と同一の依頼文になる（差分が2節だけであることは
 * samples/ の突き合わせで確認できる）。
 *
 * 注意: Dataset名やGround Truthを依頼文へ混入させないこと。
 * この関数が返すのは依頼文と実測サイズだけで、期待値は含めない。
 */
import type { MarkdownInput } from "./markdown";
import { buildAnalysisMarkdown } from "./markdown";
import {
  LOCAL_COACH_HANDLING_HEADING,
  LOCAL_COACH_SECTION_HEADING,
} from "./localCoachMarkdown";

export interface PromptVariant {
  markdown: string;
  chars: number;
  /** 概算トークン数。既存UIと同じ「4文字=1トークン」の目安を使う。 */
  estimatedTokens: number;
}

export interface PromptPair {
  production: PromptVariant;
  beta: PromptVariant;
  /** ローカルコーチ節（見出しから次の "## " まで）の文字数 */
  localCoachChars: number;
  /** 文字数の増加率（production比） */
  charIncreaseRatio: number;
  /** 概算トークンの増加率（production比） */
  tokenIncreaseRatio: number;
}

function variantOf(markdown: string): PromptVariant {
  return {
    markdown,
    chars: markdown.length,
    estimatedTokens: Math.ceil(markdown.length / 4),
  };
}

/** 見出しから次の "## " 直前までを切り出す。見つからなければ空文字。 */
export function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const rest = markdown.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return heading + (end === -1 ? rest : rest.slice(0, end));
}

/**
 * ベータ版の依頼文から、追加した2節を取り除いて本番版相当を作る。
 * 取り除いた後に空行が3つ以上続かないよう整える（本番版と同じ体裁にする）。
 */
export function stripLocalCoachSections(markdown: string): string {
  let out = markdown;
  for (const heading of [
    LOCAL_COACH_SECTION_HEADING,
    LOCAL_COACH_HANDLING_HEADING,
  ]) {
    const section = extractSection(out, heading);
    if (section) out = out.replace(section, "");
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

/** 同一データから production / beta の依頼文ペアを生成する。 */
export function buildPromptPair(input: MarkdownInput): PromptPair {
  const beta = buildAnalysisMarkdown(input);
  const production = stripLocalCoachSections(beta);
  const localCoachChars = extractSection(
    beta,
    LOCAL_COACH_SECTION_HEADING
  ).length;
  const betaVariant = variantOf(beta);
  const productionVariant = variantOf(production);
  return {
    production: productionVariant,
    beta: betaVariant,
    localCoachChars,
    charIncreaseRatio:
      productionVariant.chars > 0
        ? (betaVariant.chars - productionVariant.chars) / productionVariant.chars
        : 0,
    tokenIncreaseRatio:
      productionVariant.estimatedTokens > 0
        ? (betaVariant.estimatedTokens - productionVariant.estimatedTokens) /
          productionVariant.estimatedTokens
        : 0,
  };
}
