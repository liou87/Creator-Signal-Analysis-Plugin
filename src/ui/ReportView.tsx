import { DEFAULT_CONFIG } from '../scoring/config';
import type { Band, Confidence, MonetizationType, Report, TextField, Tier, Tri } from '../types';

const cfg = DEFAULT_CONFIG;

const BAND_LABEL: Record<Band, string> = { low: '低', mid: '中', high: '高' };
const BAND_MEANING: Record<Band, string> = {
  low: '公开内容中几乎看不到变现行为，或只有零星痕迹。',
  mid: '有稳定的变现行为，但不是内容的主体，或渠道较单一。',
  high: '变现是这个账号公开活动的重要部分：商业内容频繁，且搭建了多种渠道。',
};
const CONF_LABEL: Record<Confidence, string> = { low: '低', mid: '中', high: '高' };
const TIER_LABEL: Record<Tier, string> = { A: '明确披露', B: '带货转化', C: '疑似软广' };
const TYPE_LABEL: Record<MonetizationType, string> = {
  brand: '品牌合作',
  self: '自营带货',
  knowledge: '知识付费',
  fan: '粉丝付费',
};
const FIELD_LABEL: Record<TextField, string> = {
  title: '标题',
  desc: '简介',
  tags: '标签',
  pinnedComment: '置顶评论',
  bio: '个人简介',
};
const TRI_LABEL: Record<Tri, string> = { yes: '有', no: '无', unknown: '未能检查' };

const r0 = (n: number) => Math.round(n);
const r2 = (n: number) => n.toFixed(2);
const day = (unixSec: number) => new Date(unixSec * 1000).toLocaleDateString('zh-CN');

function RangeBar({ low, point, high }: { low: number; point: number; high: number }) {
  return (
    <div className="range" aria-hidden>
      <div className="range-track">
        <div className="tick" style={{ left: `${cfg.bands.mid}%` }} />
        <div className="tick" style={{ left: `${cfg.bands.high}%` }} />
        <div className="range-span" style={{ left: `${low}%`, width: `${Math.max(high - low, 0.5)}%` }} />
        <div className="range-point" style={{ left: `${point}%` }} />
      </div>
      <div className="range-scale">
        <span>0 低</span>
        <span style={{ left: `${cfg.bands.mid}%` }}>{cfg.bands.mid} 中</span>
        <span style={{ left: `${cfg.bands.high}%` }}>{cfg.bands.high} 高</span>
        <span style={{ left: '100%' }}>100</span>
      </div>
    </div>
  );
}

export function ReportView({ report, llmError }: { report: Report; llmError?: string }) {
  const { total, content, account } = report;
  const hits = report.verdicts.filter((v) => v.tier !== null);
  const types = (Object.keys(report.typeCounts) as MonetizationType[]).filter(
    (t) => report.typeCounts[t] > 0,
  );
  const wC = cfg.content.tierWeight.C;

  return (
    <>
      <section className="card score">
        <div className="label">
          {report.creator.name} · UID {report.creator.mid}
        </div>
        <div className="muted">分析于 {new Date(report.analyzedAt).toLocaleString('zh-CN')}</div>

        <div className="score-row">
          <div className="big">{r0(total.point)}</div>
          <div>
            <div className={`band band-${report.band}`}>商业化程度：{BAND_LABEL[report.band]}</div>
            <div className="muted">
              区间 {r0(total.low)} – {r0(total.high)}
            </div>
          </div>
        </div>
        <RangeBar low={total.low} point={total.point} high={total.high} />
        <p>{BAND_MEANING[report.band]}</p>
        <p className="muted">
          区间下界只算确证的证据（明确披露、带货转化），上界把疑似软广全部算上。
          {total.high - total.low < 1 ? '本次没有疑似证据，区间收缩为一个点。' : ''}
        </p>

        <div className="subs">
          <div>
            <div className="label">内容层</div>
            <div className="sub-score">
              {r0(content.point)} <span>/ {content.max}</span>
            </div>
            <div className="muted">多频繁地在内容里做商业</div>
          </div>
          <div>
            <div className="label">账号层</div>
            <div className="sub-score">
              {account.score} <span>/ {account.max}</span>
            </div>
            <div className="muted">搭建了多少变现渠道</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>这个分数是什么</h2>
        <p>
          衡量该创作者<strong>公开内容中可观察到的变现行为的强度与广度</strong>
          ，用于判断此人是否在认真做生意。它不是收入估计，不是内容质量评价，也不是违规判定。
        </p>
      </section>

      <section className="card">
        <h2>怎么算的</h2>
        <h3>内容层</h3>
        <p>
          取最近 {cfg.window.maxVideos} 条且 {cfg.window.maxAgeMonths} 个月内的视频，本次样本{' '}
          <strong>{content.sampleSize}</strong> 条
          {content.span ? `（${day(content.span.from)} 至 ${day(content.span.to)}）` : ''}。其中确证{' '}
          <strong>{content.certainCount}</strong> 条，疑似 <strong>{content.suspectedCount}</strong> 条。
        </p>
        <pre className="formula">
          {`占比 = (${content.certainCount} + ${content.suspectedCount} × ${wC}) ÷ (${content.sampleSize} + ${cfg.content.shrinkage}) = ${r2(content.ratio)}
内容层 = ${content.max} × min(1, ${r2(content.ratio)} ÷ ${cfg.content.ratioCap}) = ${r0(content.point)}`}
        </pre>
        <ul className="notes">
          <li>
            分母加 {cfg.content.shrinkage}：样本少时把占比往 0 拉，避免「只发 3 条、2 条是广告」直接满分。
          </li>
          <li>
            疑似软广按 {wC} 计：它需要判断，所以打折；区间用 0 和 1 给出两端。
          </li>
          <li>占比达到 {cfg.content.ratioCap} 即内容层满分。</li>
        </ul>

        <h3>账号层</h3>
        <table>
          <tbody>
            {account.items.map((i) => (
              <tr key={i.id} className={`tri-${i.state}`}>
                <td>{i.label}</td>
                <td>{TRI_LABEL[i.state]}</td>
                <td className="num">
                  {i.earned} / {i.points}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {account.items
          .filter((i) => i.basis)
          .map((i) => (
            <div className="basis" key={i.id}>
              {i.label}：{i.basis}
            </div>
          ))}
        <p className="muted">「未能检查」不扣分，只降低置信度。</p>

        <h3>总分</h3>
        <pre className="formula">{`${r0(content.point)} + ${account.score} = ${r0(total.point)}`}</pre>
      </section>

      <section className="card">
        <h2>主要依据</h2>
        {types.length > 0 && (
          <p className="chips">
            {types.map((t) => (
              <span className="chip" key={t}>
                {TYPE_LABEL[t]} {report.typeCounts[t]}
              </span>
            ))}
          </p>
        )}
        {hits.length === 0 ? (
          <p className="muted">样本视频中没有发现商业内容的证据。</p>
        ) : (
          <ul className="evidence">
            {hits.map((v) => (
              <li key={v.video.bvid}>
                <a href={v.video.url} target="_blank" rel="noreferrer">
                  {v.video.title || v.video.bvid}
                </a>
                {v.evidence.slice(0, 2).map((e, i) => (
                  <div className="quote" key={i}>
                    <span className={`tier tier-${e.tier}`}>{TIER_LABEL[e.tier]}</span>
                    <span className="muted">
                      {TYPE_LABEL[e.type]} · {FIELD_LABEL[e.field]} · {e.source === 'rule' ? '规则' : '模型'}{' '}
                      {e.reason}
                    </span>
                    <blockquote>{e.quote}</blockquote>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">每条引用都逐字摘自原文，点标题可回到原视频核对。</p>
      </section>

      <section className="card">
        <h2>置信度：{CONF_LABEL[report.confidence.level]}</h2>
        {report.confidence.reasons.length > 0 ? (
          <ul className="notes">
            {report.confidence.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">样本充足，各项都检查到了。</p>
        )}
        {llmError && <p className="warn">模型调用失败（{llmError}），本次疑似软广改用关键词识别。</p>}

        <h3>局限</h3>
        <ul className="notes">
          <li>没有披露、也没有链接的合作看不到，所以分数是下界。</li>
          <li>只读标题、简介、标签、置顶评论，不看画面和口播。</li>
          <li>没有按分区做归一化，测评类创作者天然偏高。</li>
          <li>权重是先验设定，不是数据拟合的结果。</li>
        </ul>
      </section>

      <section className="card">
        <details>
          <summary>数据来源自检</summary>
          <table>
            <tbody>
              {report.sources.map((s, i) => (
                <tr key={i} className={s.ok ? '' : 'tri-unknown'}>
                  <td>{s.item}</td>
                  <td>{s.path}</td>
                  <td>
                    {s.ok ? '成功' : '失败'}
                    {s.detail ? `：${s.detail}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </>
  );
}
