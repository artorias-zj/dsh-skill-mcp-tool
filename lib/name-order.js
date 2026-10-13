/**
 * dsh-skill-mcp-tool —— 统一排序规则。
 *
 * 需求是「按首字母排序」。直接用 `localeCompare` 会遇到两个坑：
 *   1. 大小写决定顺序 —— `REA` 会排到 `chrome-devtools` 前面，与人的直觉不符；
 *   2. 未固定区域时结果跟随系统区域，同一份配置在不同机器上顺序可能不同。
 *
 * 因此规则固定为：**先按小写串比较，仅当小写相同才用原串打破平局**（保证全序
 * 稳定），区域固定 `en`。技能名与 MCP 服务器名都被约束为纯 ASCII，所以这里
 * 不需要考虑汉字/重音字符的排序语义。
 *
 * @module dsh-skill-mcp-tool/name-order
 */

/**
 * 名称比较器（大小写不敏感的首字母序）。
 * @param {unknown} a 左值
 * @param {unknown} b 右值
 * @returns {number} 负数 / 0 / 正数
 */
export function compareName(a, b) {
	const left = String(a ?? "");
	const right = String(b ?? "");
	const byLower = left.toLowerCase().localeCompare(right.toLowerCase(), "en");
	return byLower !== 0 ? byLower : left.localeCompare(right, "en");
}

/**
 * 就地排序一个对象数组的便捷封装（返回新数组，不改原数组）。
 * @template T
 * @param {T[]} items 待排序数组
 * @param {(item: T) => unknown} pick 取名字段
 * @returns {T[]} 排序后的新数组
 */
export function sortByName(items, pick) {
	return Array.isArray(items) ? [...items].sort((a, b) => compareName(pick(a), pick(b))) : [];
}
