import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { runEvaluation } from './lib/evaluate'
import { runReplay } from './lib/replay'
import './styles.css'

void window.api.evaluation.config().then((config) => {
  if (config?.replay) return runReplay(config)
  if (config) return runEvaluation(config)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
