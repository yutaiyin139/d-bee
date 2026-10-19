/**
 * 成就徽章定义（对齐主工程 src/lib/badge.ts）。
 * 静态清单，key 与 badges 表 badge_key 对应。
 */

export interface BadgeDef {
  key: string
  name: string
  desc: string
  category: 'checkin' | 'record' | 'health' | 'social'
}

export const BADGES: BadgeDef[] = [
  { key: 'streak_3', name: '初露锋芒', desc: '连续打卡 3 天', category: 'checkin' },
  { key: 'streak_7', name: '一周自律', desc: '连续打卡 7 天', category: 'checkin' },
  { key: 'streak_21', name: '习惯养成', desc: '连续打卡 21 天', category: 'checkin' },
  { key: 'streak_100', name: '百日蜂王', desc: '连续打卡 100 天', category: 'checkin' },
  { key: 'photo_50', name: '火眼金睛', desc: '累计拍照识别 50 次', category: 'record' },
  { key: 'scan_30', name: '扫条码达人', desc: '累计扫码 30 次', category: 'record' },
  { key: 'recipe_3', name: '食谱创作者', desc: '创建 3 个自定义食谱', category: 'record' },
  { key: 'water_10', name: '饮水达人', desc: '饮水达标 10 天', category: 'health' },
  { key: 'exercise_20', name: '运动新星', desc: '累计运动 20 次', category: 'health' },
  { key: 'lose_3kg', name: '减重 3kg', desc: '体重较起始减 3kg', category: 'health' },
  { key: 'invite_3', name: '伯乐', desc: '成功邀请 3 位有效好友', category: 'social' },
  { key: 'invite_top', name: '月度蜂主', desc: '当月有效邀请达标', category: 'social' },
]

export const STREAK_BADGES: Record<number, string> = {
  3: 'streak_3',
  7: 'streak_7',
  21: 'streak_21',
  100: 'streak_100',
}

export function badgeByKey(key: string): BadgeDef | undefined {
  return BADGES.find((b) => b.key === key)
}
