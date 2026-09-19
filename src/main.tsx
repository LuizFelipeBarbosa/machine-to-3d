import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexReactClient } from 'convex/react'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { convexUrl } from './data/mode'
import './styles/tokens.css'
import './styles/layout.css'
import './styles/app.css'
import './styles/jobs.css'
import App from './App.tsx'

const client = convexUrl ? new ConvexReactClient(convexUrl) : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {client ? <ConvexAuthProvider client={client}><App /></ConvexAuthProvider> : <App />}
  </StrictMode>,
)
