import { createRoot } from 'react-dom/client'
import '../styles/app.css'
import '../lib/theme'
import { initStore } from '../lib/store'
import { App } from './App'

void initStore()
createRoot(document.getElementById('root')!).render(<App />)
