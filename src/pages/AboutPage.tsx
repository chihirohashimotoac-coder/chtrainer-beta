import {
  APP_CHANNEL,
  APP_DISPLAY_NAME,
  APP_VERSION,
  BETA_NOTICE,
} from "../config/constants";
import { VERSION_HISTORY } from "../config/versionHistory";
import { BetaBadge } from "../components/BetaBadge";
import { t } from "../i18n/ja";

export default function AboutPage() {
  const s = t();
  return (
    <div>
      <div className="title-row">
        <h1 style={{ margin: 0 }}>{s.about.title}</h1>
        <BetaBadge />
      </div>
      <div className="card">
        <div className="list-row">
          <span className="muted">{s.appName}</span>
          <strong>{APP_DISPLAY_NAME}</strong>
        </div>
        {APP_CHANNEL === "beta" && (
          <div className="list-row">
            <span className="muted">{s.about.channel}</span>
            <strong>{s.about.channelBeta}</strong>
          </div>
        )}
        <div className="list-row">
          <span className="muted">{s.about.version}</span>
          <strong>{APP_VERSION}</strong>
        </div>
      </div>
      {APP_CHANNEL === "beta" && (
        <div className="card">
          <h2>{s.about.betaTitle}</h2>
          {/* 保存領域が本番版と分離されていることを明示する。誤って本番版と
              同じデータが入っていると誤認させないための必須表示。 */}
          <p className="beta-notice">{BETA_NOTICE}</p>
          <p className="muted small beta-notice">{s.about.betaStorageNote}</p>
        </div>
      )}
      <div className="card">
        <p>{s.about.disclaimer1}</p>
        <p>{s.about.disclaimer2}</p>
        <p>{s.about.disclaimer3}</p>
        <p>{s.about.disclaimer4}</p>
      </div>
      <div className="card">
        <h2>{s.about.versionHistory}</h2>
        {VERSION_HISTORY.map((entry) => (
          /*
           * 版数と本文を横並びにすると、版数側の white-space:nowrap が
           * 幅を固定してしまい、スマホ幅では本文が数文字ずつの細長い列になる。
           * 縦に積んで、本文へ行の全幅を使わせる。
           */
          <div className="version-entry" key={entry.version}>
            <div className="version-entry-head">
              <strong>v{entry.version}</strong>
              <span className="muted small">({entry.date})</span>
            </div>
            <span
              className="small version-entry-summary"
              style={{ minWidth: 0, overflowWrap: "anywhere" }}
            >
              {entry.summary}
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>{s.about.license}</h2>
        <p className="muted">{s.about.licenseBody}</p>
      </div>
      <p className="muted" style={{ textAlign: "center", margin: "1.2rem 0 0.5rem" }}>
        {s.about.copyright}
      </p>
    </div>
  );
}
