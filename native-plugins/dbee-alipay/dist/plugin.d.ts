export interface DbeeAlipayPlugin {
  pay(options: { orderStr: string }): Promise<{ resultStatus: string; result: string; memo: string }>
  getVersion(): Promise<{ version: string; reason?: string }>
}

export declare const DbeeAlipay: DbeeAlipayPlugin
