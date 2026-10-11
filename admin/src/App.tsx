import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { FeedbackProvider } from './components/feedback';
import { AuthProvider } from './lib/auth';
import { hasViteSupabaseEnv } from './lib/settings';
import { SetupRequired } from './pages/SetupRequired';
import { AppScopeProvider } from './lib/apps';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { CampaignDetail } from './pages/CampaignDetail';
import { CampaignNew } from './pages/CampaignNew';
import { Campaigns } from './pages/Campaigns';
import { CreatorDetail } from './pages/CreatorDetail';
import { CreatorEdit } from './pages/CreatorEdit';
import { Creators } from './pages/Creators';
import { Dashboard } from './pages/Dashboard';
import { Discover } from './pages/Discover';
import { Login } from './pages/Login';
import { EmailTemplates } from './pages/EmailTemplates';
import { Settings } from './pages/Settings';
import { Connectors } from './pages/Connectors';
import { Audiences } from './pages/Audiences';

export default function App() {
  if (!hasViteSupabaseEnv()) {
    return <SetupRequired />;
  }
  return (
    <AuthProvider>
      <AppScopeProvider>
      <BrowserRouter>
      <FeedbackProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="campaigns" element={<Campaigns />} />
              <Route path="campaigns/new" element={<CampaignNew />} />
              <Route path="campaigns/:id" element={<CampaignDetail />} />
              <Route path="discover" element={<Discover />} />
              <Route path="creators" element={<Creators />} />
              <Route path="crm" element={<Creators />} />
              <Route path="creators/new" element={<CreatorEdit />} />
              <Route path="creators/:id" element={<CreatorDetail />} />
              <Route path="creators/:id/edit" element={<CreatorEdit />} />
              <Route path="audiences" element={<Audiences />} />
              <Route path="templates" element={<EmailTemplates />} />
              <Route path="connectors" element={<Connectors />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </FeedbackProvider>
      </BrowserRouter>
      </AppScopeProvider>
    </AuthProvider>
  );
}
