import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import AuthGate from './AuthGate'
// Load shared styles before accessibility overrides even when auth screens are lazy.
import './AuthGate.css'
import './App.css'
import './QuizHistory.css'
import './MasteryAnalyticsPanel.css'
import './accessibility.css'

createRoot(
  document.getElementById('root')!,
).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
