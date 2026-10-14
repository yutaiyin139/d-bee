/**
 * 最小 Service Worker：只注册 fetch 事件以满足「添加到主屏幕」的可安装条件，
 * 不做离线缓存——数据全部走云端，缓存反而会带来「改了看不见」的更新问题。
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {
  // 透传：所有请求按默认网络行为处理
})
