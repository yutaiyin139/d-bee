/**
 * @dbee/shared —— D-Bee 多端共享业务规则真相源。
 *
 * 设计约束（务必遵守）：
 *  - 只放「无环境依赖」的纯逻辑：纯函数、常量、文案、纯类型。
 *  - 禁止 import React / DOM / Capacitor / wx / my / tt / fetch 封装。
 *  - 任何端如需差异实现（如支付、健康、拍照），在各自工程里做，接口定义可放这里。
 */

export * from './constants'
export * from './rules'
export * from './types'
