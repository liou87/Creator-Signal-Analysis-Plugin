import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { analyze, identifyActiveTab, type Identity } from '../pipeline';
import type { Report } from '../types';
import { ReportView } from './ReportView';
import { Settings } from './Settings';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; text: string }
  | { kind: 'done'; report: Report; llmError?: string }
  | { kind: 'error'; message: string };

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const refresh = useCallback(() => {
    identifyActiveTab().then(setIdentity, () => setIdentity(null));
  }, []);

  // 用户切换标签页或在空间页内跳转时，重新识别当前创作者
  useEffect(() => {
    refresh();
    const onUpdated = (_id: number, info: { status?: string; url?: string }) => {
      if (info.status === 'complete' || info.url) refresh();
    };
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refresh]);

  const start = async () => {
    if (!identity) return;
    setPhase({ kind: 'running', text: '开始' });
    try {
      const result = await analyze(identity.tabId, (text) => setPhase({ kind: 'running', text }));
      setPhase({ kind: 'done', ...result });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const running = phase.kind === 'running';
  const report = phase.kind === 'done' ? phase.report : null;
  // 报告属于发起分析时的创作者。用户之后切到别人的页面，要明确提示
  const stale = report && identity && identity.mid !== report.creator.mid;

  return (
    <main>
      <header className="top">
        <h1>创作者信号分析</h1>
        <p className="sub">商业化程度指数 · B 站</p>
      </header>

      <section className="card target">
        {identity ? (
          <>
            <div>
              <div className="label">当前页面的创作者</div>
              <div className="name">{identity.name ?? '（昵称待读取）'}</div>
              <div className="muted">UID {identity.mid}</div>
            </div>
            <button className="primary" onClick={start} disabled={running}>
              {running ? '分析中…' : report && !stale ? '重新分析' : '开始分析'}
            </button>
          </>
        ) : (
          <div className="muted">
            请在 B 站 UP 主空间页（space.bilibili.com/…）打开本面板。
            <button className="link" onClick={refresh}>
              重新检测
            </button>
          </div>
        )}
      </section>

      {running && (
        <section className="card progress" role="status">
          <div className="spinner" aria-hidden />
          {phase.text}
        </section>
      )}

      {phase.kind === 'error' && (
        <section className="card error" role="alert">
          <strong>分析没有完成：</strong>
          {phase.message}
          <div className="muted">可以刷新空间页后重试。</div>
        </section>
      )}

      {stale && (
        <section className="card notice">
          下面的报告属于 <strong>{report.creator.name}</strong>，不是当前页面的创作者。点「开始分析」分析当前页面。
        </section>
      )}

      {phase.kind === 'done' && <ReportView report={phase.report} llmError={phase.llmError} />}

      <Settings />
    </main>
  );
}
