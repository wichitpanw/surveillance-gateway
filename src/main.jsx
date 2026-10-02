import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './components/SessionApp.jsx'
import { LanguageProvider } from './lib/i18n.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LanguageProvider>
      <App role="central" />
    </LanguageProvider>
  </StrictMode>,
)
