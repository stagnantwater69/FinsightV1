import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import './index.css'
import App from './App.tsx'
import { installNavigationGuardPopstateHandler } from './lib/navigationGuards.ts'
import { startErrorReporting } from './lib/errorReporting.ts'

// A Supabase Site URL saved with a trailing slash makes the email link `{{ .SiteURL }}/verify-email` arrive as `//verify-email`, which no route matches.
if (window.location.pathname.startsWith('//')) {
  const { pathname, search, hash } = window.location
  window.history.replaceState(window.history.state, '', pathname.replace(/^\/+/, '/') + search + hash)
}

installNavigationGuardPopstateHandler()
startErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* One stroke weight for every Lucide icon, matching the hand-drawn set in components/icons.tsx. */}
    <LucideProvider strokeWidth={1.8}>
      <App />
    </LucideProvider>
  </StrictMode>,
)
