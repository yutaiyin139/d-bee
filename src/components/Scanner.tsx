import { useEffect, useRef, useState } from 'react'
import { decodeFromImage, startScan, warmUpDecoder, type ScanSession } from '../lib/scan'
import { pickFileFromInput, PHOTO_INPUT_PROPS } from '../lib/capture'
import { IconScan } from './Icons'

interface ScannerProps {
  /** 解码成功后回调，父组件负责查库与入库 */
  onDetected: (code: string) => void
  /** 正在查商品库：暂停取景提示，避免重复触发 */
  busy?: boolean
}

/**
 * 条码取景框。
 * 优先调用摄像头实时解码；没有摄像头权限时，退化为「上传条码照片」由前端解码，
 * 保证任何设备都有可用的入口。
 */
export function Scanner({ onDetected, busy = false }: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<ScanSession | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)
  const [decodingFile, setDecodingFile] = useState(false)

  useEffect(() => {
    let alive = true

    void (async () => {
      const el = videoRef.current
      if (!el) return
      try {
        // 先把解码器准备好，再开摄像头，避免第一帧还没法解
        await warmUpDecoder()
        if (!alive) return
        const session = await startScan({
          video: el,
          onCode: (code) => {
            if (alive) onDetected(code)
          },
          onError: (msg) => {
            if (alive) setError(msg)
          },
        })
        if (!alive) {
          session.stop()
          return
        }
        sessionRef.current = session
        setStarting(false)
      } catch (e) {
        if (!alive) return
        setStarting(false)
        setError(e instanceof Error ? e.message : '扫码启动失败')
      }
    })()

    return () => {
      alive = false
      sessionRef.current?.stop()
      sessionRef.current = null
    }
    // onDetected 每次都可能是新函数，但重开摄像头代价很高，这里只在挂载时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFile(file: File) {
    setError('')
    setDecodingFile(true)
    try {
      const code = await decodeFromImage(file)
      if (!code) {
        setError('这张图里没找到条码，尽量让条码清晰、平整、不反光。')
        return
      }
      // 图片解码走的是独立通道，与摄像头会话隔离，识别成功后停掉取景
      sessionRef.current?.stop()
      sessionRef.current = null
      onDetected(code)
    } catch {
      setError('图片解码失败，换一张更清晰的条码照片试试。')
    } finally {
      setDecodingFile(false)
    }
  }

  return (
    <>
      <div className="scan-stage">
        <video ref={videoRef} className="scan-video" muted playsInline />
        <div className="scan-frame" aria-hidden="true">
          <span className="scan-beam" />
        </div>
        <div className="scan-hint">
          {busy ? (
            <>
              <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.35)' }} />
              正在查商品库…
            </>
          ) : starting ? (
            '正在打开摄像头…'
          ) : (
            '把商品条码对准取景框'
          )}
        </div>
      </div>

      {error && <div className="notice err" style={{ marginTop: 12 }}>{error}</div>}

      <label className="btn btn-ghost" style={{ marginTop: 12, display: 'block', textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, justifyContent: 'center' }}>
          <IconScan />
          {decodingFile ? '正在解析图片…' : '上传条码照片'}
        </span>
        <input
          {...PHOTO_INPUT_PROPS}
          onChange={(e) => {
            const f = pickFileFromInput(e)
            if (f) void handleFile(f)
          }}
        />
      </label>
    </>
  )
}
