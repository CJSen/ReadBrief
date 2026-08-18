import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './style.css'
import FloatPreview from './components/FloatPreview.vue'
import DownloadCards from './components/DownloadCards.vue'
import ChangelogList from './components/ChangelogList.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('FloatPreview', FloatPreview)
    app.component('DownloadCards', DownloadCards)
    app.component('ChangelogList', ChangelogList)
  },
} satisfies Theme
