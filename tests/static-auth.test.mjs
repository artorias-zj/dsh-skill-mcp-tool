/**
 * 回归测试：静态 Authorization 头的识别。
 *
 * 这一条曾经有过一个真实 bug：listMcp 拿脱敏视图 `patchRowToView` 的
 * `view.headers` 去判断，而那个视图只回 `headerKeys`、从不回值，于是
 * `staticAuthorization` 恒为 false —— 已经配好静态 token 的服务器在面板上
 * 一律显示「未授权」，用户以为要重新授权，其实连接一直正常。
 *
 * 用 `node --test tests/` 运行。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { hasStaticAuthorization, patchRowToView } from "../lib/mcp-model.js";

test("识别普通字符串形式的静态 Authorization 头", () => {
	assert.equal(hasStaticAuthorization({ Authorization: "Bearer ghp_example" }), true);
});

test("识别 !!js 表达式形式的静态 Authorization 头", () => {
	assert.equal(hasStaticAuthorization({ Authorization: { __jsExpr: "`Bearer ${process.env.GITHUB_TOKEN}`" } }), true);
});

test("空字符串不算已配置", () => {
	assert.equal(hasStaticAuthorization({ Authorization: "" }), false);
});

test("没有 Authorization 键不算已配置", () => {
	assert.equal(hasStaticAuthorization({ "X-Api-Key": "abc" }), false);
});

test("headers 缺失或形状不对时安全返回 false", () => {
	for (const value of [undefined, null, "Bearer x", 42, [], [{ Authorization: "Bearer x" }]]) {
		assert.equal(hasStaticAuthorization(value), false);
	}
});

test("脱敏视图不含 headers 的值 —— 这正是原 bug 的根源", () => {
	// 构造一行 streamable-http 受管行，带静态 token。
	const row = {
		id: "smt-mcp-github",
		name: "@deepseek-ai/dsh-mcp-client",
		config: {
			serverName: "github",
			transport: "streamable-http",
			url: "https://api.githubcopilot.com/mcp/",
			headers: { Authorization: "Bearer ghp_example" }
		}
	};
	const view = patchRowToView(row);
	// 视图暴露了键名……
	assert.deepEqual(view.headerKeys, ["Authorization"]);
	// ……但绝不暴露值，所以不能用 view.headers 判断是否已配置。
	assert.equal(view.headers, undefined);
	assert.equal(hasStaticAuthorization(view.headers), false);
	// 正确做法是从原始行判断。
	assert.equal(hasStaticAuthorization(row.config.headers), true);
});
