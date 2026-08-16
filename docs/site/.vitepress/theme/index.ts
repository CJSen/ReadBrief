import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './style.css'
import FloatPreview from './components/FloatPreview.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('FloatPreview', FloatPreview)
  },
} satisfies Theme
