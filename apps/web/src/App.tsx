import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { fetchAuthConfig, handleRedirectCallback, type AuthConfig, ensureFreshToken, scheduleRefresh, hasSilentAttempted, startLogin } from './auth/oidc';
import { Login } from './pages/Login';
import { useUI } from './store';
import { useI18n } from './i18n';
import { Sidebar } from './components/Sidebar';
import { Home } from './pages/Home';
import { TaskView } from './pages/TaskView';
import { Skills } from './pages/Skills';
import { Admin } from './pages/Admin';
import { Members } from './pages/Members';
import { Files } from './pages/Files';
import { Knowledge } from './pages/Knowledge';
import { Automation } from './pages/Automation';
import { Connectors } from './pages/Connectors';

export function App() {
  const { workspaceId, setWorkspaceId } = useUI();
  const { t } = useI18n();
  const [authCfg, setAuthCfg] = useState<AuthConfig | null>(null);
  const [authed, setAuthed] = useState(false);
  const [authErr, setAuthErr] = useState<string | undefined>();

  // 启动：读认证模式；oidc 模式下处理回调 / 判断是否已有令牌
  useEffect(() => {
    (async () => {
      try {
        const cfg = await fetchAuthConfig();
        setAuthCfg(cfg);
        if (cfg.mode === 'dev') {
          setAuthed(true);
          return;
        }
        const cb = await handleRedirectCallback(cfg);
        if (cb === 'ok') {
          setAuthed(true);
          return;
        }
        if (cb === 'login_required') {
          setAuthed(false); // 静默登录发现 IdP 没有会话：展示登录页
          return;
        }
        if (await ensureFreshToken()) {
          scheduleRefresh(); // 刷新页面：令牌还在（或刚续上），不重新登录
          setAuthed(true);
          return;
        }
        // 新标签页没有令牌：SSO 会话可能仍有效，先带 prompt=none 静默跳一次，不行再展示登录页
        if (!hasSilentAttempted()) {
          await startLogin(cfg, { silent: true });
          return;
        }
        setAuthed(false);
      } catch (e) {
        setAuthErr((e as Error).message);
        setAuthCfg({ mode: 'oidc' });
      }
    })();
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener('apolla:unauthorized', onUnauthorized);
    return () => window.removeEventListener('apolla:unauthorized', onUnauthorized);
  }, []);

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: api.workspaces,
    enabled: authed,
  });

  // 选定工作空间：localStorage 里的 id 可能已失效（被删、被移出成员、或换了后端环境）。
  // 只判空会让失效 id 永久卡住 —— 界面停在空列表、发任务静默失败且无任何提示，
  // 用户除了手工清站点数据没有出路。故这里同时校验它是否仍在可访问列表中。
  useEffect(() => {
    if (!workspaces?.length) return;
    const usable = workspaceId && workspaces.some((w) => w.id === workspaceId);
    if (!usable) setWorkspaceId(workspaces[0].id);
  }, [workspaces, workspaceId, setWorkspaceId]);

  if (!authCfg) {
    return (
      <div className="h-full flex items-center justify-center text-ink-faint text-[13px]">
        {t('common.loading')}
      </div>
    );
  }
  if (!authed) return <Login config={authCfg} error={authErr} />;

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-hidden bg-canvas">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/task/:id" element={<TaskView />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/connectors" element={<Connectors />} />
          <Route path="/files" element={<Files />} />
          <Route path="/library" element={<Knowledge />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/members" element={<Members />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
