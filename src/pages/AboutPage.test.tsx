import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AboutPage from "./AboutPage";
import HomePage from "./HomePage";
import { AppProvider } from "../state/AppContext";
import { SetupProvider } from "../state/SetupContext";
import {
  APP_VERSION,
  BETA_BADGE_LABEL,
  BETA_NOTICE,
} from "../config/constants";
import { VERSION_HISTORY } from "../config/versionHistory";

/**
 * バージョン履歴のサマリには previous_throw_was_hit_in_same_set や fat_bull などの
 * 折り返し位置を持たない長い識別子が含まれる。折り返し指定がないと flex 行の
 * min-width:auto と相まって狭幅画面で横スクロールが発生するため、
 * サマリ要素に overflow-wrap と min-width:0 が設定されていることを保証する。
 */
describe("AboutPage (バージョン履歴の折り返し)", () => {
  it("長い識別子を含むサマリが横はみ出ししないよう折り返し指定を持つ", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );

    // 長い英数字トークンを含む代表的なサマリのテキストノードを探す
    const longEntry = VERSION_HISTORY.find((e) =>
      e.summary.includes("previous_throw_was_hit_in_same_set")
    );
    expect(longEntry).toBeDefined();

    const summarySpans = Array.from(
      container.querySelectorAll<HTMLElement>("span.small")
    ).filter((el) => el.textContent === longEntry!.summary);
    expect(summarySpans.length).toBe(1);

    const style = summarySpans[0]!.style;
    // 長いトークンを分割可能にし、flex 収縮を許可する
    expect(style.overflowWrap).toBe("anywhere");
    expect(["0", "0px"]).toContain(style.minWidth);
  });
});

/**
 * ベータ版であることの識別表示。
 * 本番版と誤認されると、別々の保存領域に記録されたデータを同一のものと
 * 誤解するおそれがあるため、情報画面での明示は必須要件として固定する。
 */
describe("AboutPage (ベータ版の識別表示)", () => {
  it("βバッジ・ベータ版表記・バージョン・注意書きを表示する", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );
    const text = container.textContent ?? "";
    expect(text).toContain(BETA_BADGE_LABEL);
    expect(text).toContain("ベータ版");
    expect(text).toContain(APP_VERSION);
    expect(APP_VERSION).toMatch(/^2\.7\.0-beta\.\d+$/);
    // 注意書きは3文すべてが読める形で表示される
    for (const line of BETA_NOTICE.split("\n")) {
      expect(text, line).toContain(line);
    }
    // 注意書きは改行を保持したまま折り返す(狭幅で横スクロールしない)
    const notice = container.querySelector<HTMLElement>("p.beta-notice");
    expect(notice).not.toBeNull();
  });

  it("バッジは折り返し可能な行に置き、見出しを押し出さない", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );
    const badge = container.querySelector(".badge.beta");
    expect(badge).not.toBeNull();
    // 320px幅でも横スクロールしないよう、flex-wrap を持つ .title-row の中に置く
    expect(badge!.parentElement?.className).toContain("title-row");
    expect(badge!.textContent).toBe(BETA_BADGE_LABEL);
  });
});

describe("HomePage (ベータ版の識別表示)", () => {
  it("アプリ名の近くにβバッジを表示する", async () => {
    const { container, findByText } = render(
      <MemoryRouter>
        <AppProvider>
          <SetupProvider>
            <HomePage />
          </SetupProvider>
        </AppProvider>
      </MemoryRouter>
    );
    await findByText("CH Darts Training Analyzer");
    const hero = container.querySelector(".home-hero");
    expect(hero).not.toBeNull();
    const badge = hero!.querySelector(".badge.beta");
    expect(badge).not.toBeNull();
    expect(badge!.parentElement?.className).toContain("title-row");
  });
});
