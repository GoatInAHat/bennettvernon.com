import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// ponytail: no StrictMode — double-mounting races two WebGPU engines on one canvas
createRoot(document.getElementById('root')!).render(<App />)
