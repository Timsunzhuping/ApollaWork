import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { fetchAuthConfig, getToken, handleRedirectCallback, type AuthConfig } from './auth/oidc';
import { Login } from './pages/Login';
import { useUI } from './store';
import { useI18n } from './i18n';
import { Sidebar } from './components/Sidebar';
import { Home } from './pages/Home';
import { TaskView } from './pages/TaskView';
import { Skills } from './pages/Skills';
import { Admin } from './pages/Admin';
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
        if (await handleRedirectCallback(cfg)) {
          setAuthed(true);
          return;
        }
        setAuthed(!!getToken());
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

  useEffect(() => {
    if (!workspaceId && workspaces?.length) setWorkspaceId(workspaces[0].id);
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
