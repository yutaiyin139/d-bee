interface IconProps {
  active?: boolean
}

export function IconToday({ active }: IconProps) {
  const c = active ? 'var(--honey-dark)' : 'currentColor'
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" stroke={c} strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3.1" fill={active ? c : 'none'} stroke={c} strokeWidth="1.7" />
    </svg>
  )
}

export function IconMe({ active }: IconProps) {
  const c = active ? 'var(--honey-dark)' : 'currentColor'
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.7" stroke={c} strokeWidth="1.7" />
      <path d="M4.6 20c.7-4 3.6-6.1 7.4-6.1s6.7 2.1 7.4 6.1" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function IconCamera({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <path
        d="M4 8.5h2.4l1.3-2h8.6l1.3 2H20a1 1 0 011 1v8a1 1 0 01-1 1H4a1 1 0 01-1-1v-8a1 1 0 011-1z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.5" r="3.3" stroke={color} strokeWidth="1.6" />
    </svg>
  )
}

export function IconPlus({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

export function IconChart({ active }: IconProps) {
  const c = active ? 'var(--honey-dark)' : 'currentColor'
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20V9.5M10 20V4.5M16 20v-7M22 20H2" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function IconScan({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path d="M3.5 8V5.5a2 2 0 012-2H8M16 3.5h2.5a2 2 0 012 2V8M20.5 16v2.5a2 2 0 01-2 2H16M8 20.5H5.5a2 2 0 01-2-2V16" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M6 12h1.6M9.2 9.5v5M11.6 12h1.2M11.6 9.5v5M14.8 9.5v5M16.4 12H18" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function IconWeight({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="17" height="13" rx="3" stroke={color} strokeWidth="1.7" />
      <path d="M12 12.5l3-3" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M8 7l1.6-2.6h4.8L16 7" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconWater({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M12 3.2c3.2 4.1 6 7.6 6 10.8a6 6 0 11-12 0c0-3.2 2.8-6.7 6-10.8z"
        stroke={color}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9.4 14.2a2.8 2.8 0 002.4 2.6" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function IconRun({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <circle cx="14.5" cy="4.6" r="1.9" stroke={color} strokeWidth="1.6" />
      <path
        d="M13.4 8.2l-3.4 2.3 1.8 3-2.5 4.3M13.4 8.2l3 1.2 2 2.6M13.4 8.2l.9 5.1 3.4 2M10.9 13.5l-3.7 1.4"
        stroke={color}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconFire({ color = 'currentColor', size = 16 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M12 3.5c.6 2.6 2.3 3.9 3.9 5.6 1.5 1.6 2.4 3.2 2.4 5.1A6.3 6.3 0 0112 20.5a6.3 6.3 0 01-6.3-6.3c0-2.4 1.3-4.3 2.8-5.6"
        stroke={color}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M12 20.5c-1.7-.6-2.6-1.9-2.6-3.4 0-1.8 1.6-2.9 2.6-4.6 1 1.7 2.6 2.8 2.6 4.6 0 1.5-.9 2.8-2.6 3.4z" fill={color} opacity="0.35" />
    </svg>
  )
}

export function IconChat({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M20.5 11.6c0 4-3.8 7.2-8.5 7.2-.9 0-1.9-.1-2.7-.4L4.5 20l1.2-3.4c-1.4-1.3-2.2-3-2.2-5C3.5 7.6 7.3 4.4 12 4.4s8.5 3.2 8.5 7.2z"
        stroke={color}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M8.6 11.7h.01M12 11.7h.01M15.4 11.7h.01" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function IconCrown({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M4 17.5l-1.2-9 5 3.6L12 5.5l4.2 6.6 5-3.6-1.2 9H4z"
        stroke={color}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M5 20h14" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function IconLock({ color = 'currentColor', size = 16 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke={color} strokeWidth="1.7" />
      <path d="M8.2 10.5V8a3.8 3.8 0 017.6 0v2.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function IconDownload({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M12 4v10m0 0l-3.8-3.8M12 14l3.8-3.8M5 19h14" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconTrash({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 011.5-1.5h2A1.5 1.5 0 0114.5 5v1.5M6.5 6.5l.9 12a2 2 0 002 1.9h5.2a2 2 0 002-1.9l.9-12" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 10.5v6M14 10.5v6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function IconGift({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <rect x="4" y="8.5" width="16" height="4" rx="1.2" stroke={color} strokeWidth="1.7" />
      <path d="M5.5 12.5v6.5a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5v-6.5M12 8.5V20.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 8.3C10 8.3 7.6 7.7 7.6 5.9 7.6 4.5 8.7 3.6 9.9 3.6c1.5 0 2.1 1.7 2.1 4.7zm0 0c2 0 4.4-.6 4.4-2.4 0-1.4-1.1-2.3-2.3-2.3-1.5 0-2.1 1.7-2.1 4.7z" stroke={color} strokeWidth="1.6" />
    </svg>
  )
}

export function IconFlame({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
    return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M12 3.5c.6 2.6 2.3 3.9 3.9 5.6 1.5 1.6 2.4 3.2 2.4 5.1A6.3 6.3 0 0112 20.5a6.3 6.3 0 01-6.3-6.3c0-2.4 1.3-4.3 2.8-5.6.4 1.2 1 2 1.9 2.6C10.3 9 10.9 6 12 3.5z"
        stroke={color}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 刀叉：用于「已摄入」 */
export function IconFork({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M7 3.5v6.2M4.6 3.5v3.9a2.4 2.4 0 004.8 0V3.5M7 13.7v6.8"
        stroke={color}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 3.5c-1.9 0-3.1 2.3-3.1 5.1s1.2 4.7 3.1 4.7v7.2"
        stroke={color}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 实心圆豆：用于「蛋白质」 */
export function IconPea({ color = 'currentColor', size = 13 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill={color} />
      <circle cx="9.4" cy="9.6" r="2.1" fill="#fff" opacity="0.5" />
    </svg>
  )
}

/** 实心水滴：用于「碳水化合物 / 脂肪」 */
export function IconDrop({ color = 'currentColor', size = 13 }: { color?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M12 3.2c3.2 4.1 6 7.6 6 10.8a6 6 0 11-12 0c0-3.2 2.8-6.7 6-10.8z" fill={color} />
      <path d="M9.2 14.6a2.9 2.9 0 002.4 2.7" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}
