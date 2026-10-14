/**
 * Open Food Facts 商品查询（条码 → 营养）。
 *
 * 只做一件事：把条码换成「每 100g 营养」。中国包装食品在该库覆盖很薄（实测国产零食
 * 多数返回 not found），因此调用方必须准备降级方案（拍照识别包装，见 lib/ai.ts）。
 * 接口无需 key，且返回 Access-Control-Allow-Origin: *，可直接在前端调用。
 */

const ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product'
const FIELDS = [
  'code',
  'product_name',
  'product_name_zh',
  'generic_name',
  'brands',
  'quantity',
  'serving_size',
  'serving_quantity',
  'image_front_small_url',
  'nutriments',
].join(',')

export interface PackagedFood {
  barcode: string
  name: string
  brand: string
  /** 每 100g（或 100ml）营养 */
  per100g: { kcal: number; protein: number; carb: number; fat: number }
  /** 一条常见份量（来自商品的 serving_size / serving_quantity） */
  servingG: number
  servingLabel: string
  imageUrl: string | null
}

export type BarcodeLookup =
  | { status: 'found'; product: PackagedFood }
  | { status: 'not_found' }
  | { status: 'network_error'; message: string }

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

export async function lookupBarcode(barcode: string, signal?: AbortSignal): Promise<BarcodeLookup> {
  const code = barcode.replace(/\D/g, '')
  if (!code) return { status: 'not_found' }

  let payload: Record<string, unknown>
  try {
    const res = await fetch(`${ENDPOINT}/${code}.json?fields=${FIELDS}`, {
      signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      // 404 也走 not_found，避免把「这个库里没有」当成故障
      if (res.status === 404) return { status: 'not_found' }
      return { status: 'network_error', message: `商品库返回 ${res.status}` }
    }
    payload = (await res.json()) as Record<string, unknown>
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return { status: 'network_error', message: '无法连接商品库，请检查网络' }
  }

  const status = num(payload.status)
  const product = payload.product as Record<string, unknown> | undefined
  if (status !== 1 || !product) return { status: 'not_found' }

  const n = (product.nutriments ?? {}) as Record<string, unknown>
  let kcal = num(n['energy-kcal_100g'])
  if (!kcal) {
    // 只有千焦时换算，1 kcal = 4.184 kJ
    const kj = num(n.energy_100g)
    if (kj) kcal = kj / 4.184
  }
  const protein = num(n.proteins_100g)
  const carb = num(n.carbohydrates_100g)
  const fat = num(n.fat_100g)

  const name = String(product.product_name_zh || product.product_name || product.generic_name || '').trim()
  if (!name && !kcal) return { status: 'not_found' }
  // 有名字但完全没有营养数据，对记账没意义，交给 AI 兜底
  if (!kcal && !protein && !carb && !fat) return { status: 'not_found' }

  const servingQty = num(product.serving_quantity)
  const servingSize = String(product.serving_size || '').trim()
  const servingG = servingQty > 0 ? Math.round(servingQty) : 100

  return {
    status: 'found',
    product: {
      barcode: code,
      name: name || `条码 ${code}`,
      brand: String(product.brands || '').trim(),
      per100g: {
        kcal: Math.round(kcal),
        protein: Math.round(protein * 10) / 10,
        carb: Math.round(carb * 10) / 10,
        fat: Math.round(fat * 10) / 10,
      },
      servingG,
      servingLabel: servingSize || (servingQty > 0 ? `${Math.round(servingQty)} 克` : '100 克'),
      imageUrl: (product.image_front_small_url as string) || null,
    },
  }
}
