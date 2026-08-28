import { useState } from 'react';
import type { AuthConfig } from '../auth/oidc';
import { startLogin } from '../auth/oidc';

/** 登录页（生产 P0）：OIDC 模式下的入口。 */
export function Login({ config, error }: { config: AuthConfig; error?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error);

  const go = async () => {
    setBusy(true);
    try {
      await startLogin(config);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-canvas">
      <div className="w-[380px] bg-surface border border-line rounded-2xl p-8 shadow-[0_2px_24px_rgba(26,36,32,0.06)]">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-white text-[16px] font-bold">
            A
          </div>
          <div>
            <div className="font-semibold text-[16px] tracking-tight">Apolla Work</div>
            <div className="text-[12px] text-ink-faint">企业 AI 智能体工作台</div>
          </div>
        </div>

        <p className="text-[13.5px] text-ink-soft mb-6 leading-relaxed">
          使用企业统一身份登录。所有任务在企业内网沙箱执行，数据不出域，全程可审计。
        </p>

        {err && (
          <div className="mb-4 text-[12.5px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</div>
        )}

        <button
          onClick={go}
          disabled={busy}
          className="w-full h-10 rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-60 text-white text-[14px] font-medium transition-colors"
        >
          {busy ? '正在跳转…' : '企业账号登录 (SSO)'}
        </button>

        <p className="text-[11.5px] text-ink-faint mt-4 text-center">
          登录即表示同意企业内部使用规范
        </p>
      </div>
    </div>
  );
}
