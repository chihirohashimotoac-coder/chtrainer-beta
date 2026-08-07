// @ts-expect-error The browser app intentionally excludes Node types; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../config/constants";

/**
 * Service Worker の更新バナー(updatefound)がリリースごとに発火するには、
 * sw.js のキャッシュ名がバージョンで変わる必要がある。
 * public/sw.js はプレースホルダ __APP_VERSION__ を使い、ビルド時に
 * vite.config.ts の inject-sw-version プラグインが実バージョンへ置換する。
 *
 * ここでは仕組みが失われていないこと(=固定文字列へ戻っていないこと)と、
 * アプリのバージョン表記が package.json と一致していることを保証する。
 */
describe("Service Worker のキャッシュ版数がリリースで更新される", () => {
  const sw = readFileSync("public/sw.js", "utf8") as string;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };

  it("public/sw.js は __APP_VERSION__ プレースホルダでキャッシュ名を定義する", () => {
    expect(sw).toMatch(/CACHE_VERSION\s*=\s*"dta-beta-v__APP_VERSION__"/);
  });

  it("public/sw.js にバージョン固定のキャッシュ名が残っていない", () => {
    // 例: "dta-beta-v2.7.0-beta.1" のような固定値へ戻っていないこと
    expect(sw).not.toMatch(/CACHE_VERSION\s*=\s*"dta-beta-v\d/);
  });

  it("APP_VERSION は package.json の version と一致する", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });
});
