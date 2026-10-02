import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './components/SessionApp.jsx'
import { LanguageProvider } from './lib/i18n.jsx'

// Regional รวม Edge จังหวัดและให้ Client ในภาคต่อโดยตรง
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LanguageProvider>
      <App role="regional" />
    </LanguageProvider>
  </StrictMode>,
)
