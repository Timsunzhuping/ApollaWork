import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useUI } from './store';
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
  const { data: workspaces } = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });

  useEffect(() => {
    if (!workspaceId && workspaces?.length) setWorkspaceId(workspaces[0].id);
  }, [workspaces, workspaceId, setWorkspaceId]);

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
