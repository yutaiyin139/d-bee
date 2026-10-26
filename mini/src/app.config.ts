export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/login/login',
    'pages/onboarding/onboarding',
    'pages/checkin/checkin',
    'pages/scan/scan',
    'pages/profile/profile',
    'pages/invite/invite',
    'pages/report/report',
    'pages/coach/coach',
    'pages/paywall/paywall',
    'pages/legal/legal',
    'pages/leaderboard/leaderboard',
    'pages/recipes/recipes'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fbf8f1',
    navigationBarTitleText: '自律蜜蜂',
    navigationBarTextStyle: 'black'
  },
  // wx.request 默认超时 60s：LLM 长回答（教练问答网关侧 llmTimeoutMs=120s）
  // 会被掐死，与 iOS V1.7.0「问问小蜜」超时同病 → 显式放宽到 180s
  networkTimeout: {
    request: 180000,
    connectSocket: 15000,
    uploadFile: 180000,
    downloadFile: 60000
  }
})
