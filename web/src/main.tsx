import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import './index.css'
import App from './App.tsx'
import { installNavigationGuardPopstateHandler } from './lib/navigationGuards.ts'
import { startErrorReporting } from './lib/errorReporting.ts'

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
