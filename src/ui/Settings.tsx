import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { LlmConfig } from '../classify/llm';
import { loadLlmConfig, saveLlmConfig } from '../pipeline';

const EMPTY: LlmConfig = { baseUrl: '', apiKey: '', model: '' };

export function Settings() {
  const [cfg, setCfg] = useState<LlmConfig>(EMPTY);
  const [status, setStatus] = useState('');

  useEffect(() => {
    loadLlmConfig().then((c) => c && setCfg(c));
  }, []);

  const save = async () => {
    const trimmed: LlmConfig = {
      baseUrl: cfg.baseUrl.trim(),
      apiKey: cfg.apiKey.trim(),
      model: cfg.model.trim(),
    };
    if (!trimmed.baseUrl && !trimmed.apiKey && !trimmed.model) {
      await saveLlmConfig(undefined);
      setStatus('已清除，疑似软广将只用关键词识别。');
      return;
    }
    let origin: string;
    try {
      origin = new URL(trimmed.baseUrl).origin + '/*';
    } catch {
      setStatus('接口地址不是合法的网址。');
      return;
    }
    if (!trimmed.apiKey || !trimmed.model) {
      setStatus('三项都要填。');
      return;
    }
    // 只为用户填写的这一个地址申请访问权限
    const granted = await browser.permissions.request({ origins: [origin] });
    if (!granted) {
      setStatus('没有授予访问该地址的权限，未保存。');
      return;
    }
    await saveLlmConfig(trimmed);
    setStatus('已保存。');
  };

  const field = (key: keyof LlmConfig, label: string, placeholder: string, type = 'text') => (
    <label>
      {label}
      <input
        type={type}
        value={cfg[key]}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <section className="card">
      <details>
        <summary>模型设置（可选）</summary>
        <p className="muted">
          不填也能用。填了之后，「疑似软广」一档改由模型判定；明确披露和直接变现始终只由规则判定，分数始终由公式算出。
        </p>
        <p className="muted">
          会发送给模型的只有视频的公开文本（标题、简介、标签、置顶评论）。Key 只保存在本机浏览器里。
        </p>
        {field('baseUrl', '接口地址（OpenAI 兼容）', 'https://…/v1')}
        {field('apiKey', 'API Key', '', 'password')}
        {field('model', '模型名称', '')}
        <button onClick={save}>保存</button>
        {status && (
          <span className="muted" role="status">
            {' '}
            {status}
          </span>
        )}
      </details>
    </section>
  );
}
