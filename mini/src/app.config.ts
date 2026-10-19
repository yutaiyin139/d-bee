export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/login/login',
    'pages/onboarding/onboarding',
    'pages/checkin/checkin',
    'pages/scan/scan',
    'pages/profile/profile',
    'pages/invite/invite',
    'pages/report/report'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fbf8f1',
    navigationBarTitleText: '自律蜜蜂',
    navigationBarTextStyle: 'black'
  }
})
