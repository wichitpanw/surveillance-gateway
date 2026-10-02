import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './components/SessionApp.jsx'
import { LanguageProvider } from './lib/i18n.jsx'

// Surveillance Gateway Edge — โปรแกรมของเครื่อง edge (แอดกล้อง) backend เสิร์ฟหน้านี้เมื่อ GATEWAY_ROLE=edge
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LanguageProvider>
      <App role="edge" />
    </LanguageProvider>
  </StrictMode>,
)
