/**
 * dsh-skill-mcp-tool —— 需要 OAuth 的 MCP 服务器支持。
 *
 * ## 为什么必须由本插件自己跑 OAuth
 *
 * DSH 的 `@deepseek-ai/dsh-mcp-client` 构造 Streamable HTTP 传输时只做：
 *
 *     new StreamableHTTPClientTransport(url, { requestInit: { headers } })
 *
 * 它的配置 schema 只有 `url` 和 `headers`，**没有 `authProvider` 字段**，
 * 也没有任何地方把 `UnauthorizedError` 暴露出来。所以插件无法向 DSH 注入
 * OAuth 提供者 —— 无论 MCP SDK 本身支持得多完整（它确实导出了
 * `OAuthClientProvider`、`withOAuth`、`exchangeAuthorization` 等）。
 *
 * 唯一能走通的路：**插件自己完成授权码流程，把 access token 写进该 MCP 行的
 * `Authorization` 头**。DSH 把它当普通静态头发出去，服务器认这个 bearer。
 * token 过期由本插件负责刷新 —— 所以我们自己保管 refresh token。
 *
 * ## 安全边界
 *
 *   - token 永不回传浏览器：界面只拿到「有没有 token、何时过期」。
 *   - 授权码流程用 PKCE（S256），不依赖 client secret —— 这样公共客户端
 *     也安全，且不需要用户去服务商后台申请密钥。
 *   - 回调监听只绑 `127.0.0.1`，随机端口；state 参数一次性校验。
 *   - 写入 `cordis.patch.yml` 的只有 access token；refresh token 留在
 *     `<dshHome>/skill-mcp-tool/oauth.json`（权限 600）。
 *
 * @module dsh-skill-mcp-tool/oauth
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

/** 授权码流程的最长等待时间：用户要去浏览器里登录，给足 5 分钟。 */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
/** token 请求超时。 */
const HTTP_TIMEOUT_MS = 20000;
/** 提前多少毫秒视为过期（避免「刚好在调用时过期」）。 */
const EXPIRY_SKEW_MS = 60 * 1000;

/** OAuth 状态文件（含 refresh token，权限 600）。 */
export function oauthFile(dshHome) {
	return join(dshHome, "skill-mcp-tool", "oauth.json");
}

// ── 存储 ─────────────────────────────────────────────────────────────────────

/** 读取全部 OAuth 记录；文件缺失或损坏时返回空对象。 */
export async function loadOAuth(dshHome) {
	try {
		const raw = await readFile(oauthFile(dshHome), "utf8");
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** 写回全部记录。文件含 refresh token，因此收紧到 600。 */
export async function saveOAuth(dshHome, records) {
	const file = oauthFile(dshHome);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(records, null, 1)}\n`, "utf8");
	// Windows 上 chmod 基本无效，但 POSIX 上这一步是必要的。
	await chmod(file, 0o600).catch(() => {});
}

/**
 * 单个服务器的 OAuth 记录。
 * @returns `{ accessToken, refreshToken, expiresAt, tokenType, scope, ... }` 或 undefined
 */
export async function readOAuthRecord(dshHome, serverName) {
	const records = await loadOAuth(dshHome);
	const record = records[serverName];
	return record !== null && typeof record === "object" ? record : undefined;
}

/** 删除某服务器的 OAuth 记录（断开授权）。 */
export async function forgetOAuthRecord(dshHome, serverName) {
	const records = await loadOAuth(dshHome);
	if (!(serverName in records)) return false;
	delete records[serverName];
	await saveOAuth(dshHome, records);
	return true;
}

/** token 是否仍然可用（留出 skew）。 */
export function tokenUsable(record) {
	if (record === undefined) return false;
	if (typeof record.accessToken !== "string" || record.accessToken === "") return false;
	if (typeof record.expiresAt !== "number") return true; // 无过期信息：当作长期有效
	return record.expiresAt - EXPIRY_SKEW_MS > Date.now();
}

/** 回给浏览器的视图：**不含任何 token**。 */
export function oauthView(record) {
	if (record === undefined) return { authorized: false };
	return {
		authorized: typeof record.accessToken === "string" && record.accessToken !== "",
		expiresAt: typeof record.expiresAt === "number" ? new Date(record.expiresAt).toISOString() : null,
		expired: typeof record.expiresAt === "number" ? record.expiresAt <= Date.now() : false,
		scope: typeof record.scope === "string" ? record.scope : null,
		tokenType: typeof record.tokenType === "string" ? record.tokenType : "Bearer",
		hasRefreshToken: typeof record.refreshToken === "string" && record.refreshToken !== "",
		authorizedAt: typeof record.authorizedAt === "string" ? record.authorizedAt : null,
		issuer: typeof record.issuer === "string" ? record.issuer : null
	};
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

/** RFC 7636 的 code_verifier：43–128 个 unreserved 字符。 */
function createVerifier() {
	return randomBytes(48).toString("base64url");
}

function challengeOf(verifier) {
	return createHash("sha256").update(verifier).digest("base64url");
}

// ── 端点发现 ─────────────────────────────────────────────────────────────────

/**
 * 探测受保护资源元数据（RFC 9728），拿到授权服务器地址。
 *
 * MCP 规范要求服务器在 401 响应的 `WWW-Authenticate` 里给出
 * `resource_metadata` 链接；拿不到时退回约定的 well-known 路径。
 *
 * @returns `{ resourceMetadataUrl, authorizationServer }`，失败时为 undefined
 */
async function discoverResourceMetadata(serverUrl, fetchImpl) {
	const url = new URL(serverUrl);
	const candidates = [];
	// 先按 401 响应里的提示找（最准确）。
	try {
		const probe = await fetchImpl(url, { method: "GET", headers: { accept: "application/json, text/event-stream" }, redirect: "manual" });
		const header = probe.headers.get("www-authenticate") ?? "";
		const match = /resource_metadata="([^"]+)"/i.exec(header);
		if (match !== null) candidates.push(match[1]);
	} catch {
		// 探测失败不影响后面的猜测路径。
	}
	// 再按 well-known 约定猜：路径前缀 + 根。
	const path = url.pathname.replace(/\/+$/, "");
	candidates.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
	candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);

	for (const candidate of candidates) {
		try {
			const response = await fetchImpl(candidate, { headers: { accept: "application/json" } });
			if (!response.ok) continue;
			const body = await response.json();
			const server = Array.isArray(body?.authorization_servers) ? body.authorization_servers[0] : undefined;
			if (typeof server === "string" && server !== "") {
				return { resourceMetadataUrl: candidate, authorizationServer: server };
			}
		} catch {
			// 换下一个候选。
		}
	}
	return undefined;
}

/** 探测授权服务器元数据（RFC 8414 / OIDC discovery）。 */
async function discoverAuthorizationServer(issuer, fetchImpl) {
	const base = issuer.replace(/\/+$/, "");
	for (const suffix of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
		try {
			const response = await fetchImpl(`${base}${suffix}`, { headers: { accept: "application/json" } });
			if (!response.ok) continue;
			const body = await response.json();
			if (typeof body?.authorization_endpoint === "string" && typeof body?.token_endpoint === "string") {
				return {
					issuer: typeof body.issuer === "string" ? body.issuer : issuer,
					authorizationEndpoint: body.authorization_endpoint,
					tokenEndpoint: body.token_endpoint,
					registrationEndpoint: typeof body.registration_endpoint === "string" ? body.registration_endpoint : undefined,
					scopesSupported: Array.isArray(body.scopes_supported) ? body.scopes_supported : undefined
				};
			}
		} catch {
			// 换下一个候选。
		}
	}
	return undefined;
}

/**
 * 动态客户端注册（RFC 7591）。
 * 支持它的服务器可以让用户完全不填 client id；不支持时退回手动填写。
 */
async function registerClient(metadata, redirectUri, fetchImpl) {
	if (metadata.registrationEndpoint === undefined) return undefined;
	try {
		const response = await fetchImpl(metadata.registrationEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				client_name: "dsh-skill-mcp-tool",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				application_type: "native"
			})
		});
		if (!response.ok) return undefined;
		const body = await response.json();
		return typeof body?.client_id === "string" ? { clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined } : undefined;
	} catch {
		return undefined;
	}
}

// ── 授权码流程 ───────────────────────────────────────────────────────────────

/** 把 token 响应归一成存储记录。refresh_token 缺省时沿用上一次的。 */
function recordFromTokenResponse(body, previous) {
	const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
	if (accessToken === "") throw new Error("token 响应里没有 access_token");
	const expiresIn = Number(body?.expires_in);
	return {
		accessToken,
		refreshToken: typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : previous?.refreshToken,
		tokenType: typeof body?.token_type === "string" ? body.token_type : "Bearer",
		scope: typeof body?.scope === "string" ? body.scope : previous?.scope,
		expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
	};
}

/** POST 到 token 端点（表单编码），失败时抛出带服务端原因的错。 */
async function postToken(endpoint, form, fetchImpl) {
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString()
	});
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		const detail = typeof body?.error === "string" ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}` : text.slice(0, 200);
		throw new Error(`token 端点返回 ${response.status}：${detail}`);
	}
	if (body === undefined) throw new Error("token 端点返回的不是 JSON");
	return body;
}

/** 内部：先监听拿端口 → 拼 redirect_uri → 换 token。 */
export async function runAuthorization(options) {
	const { serverUrl, serverName, dshHome, openUrl } = options;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new Error("当前运行时没有 fetch，无法完成 OAuth");

	const resource = await discoverResourceMetadata(serverUrl, fetchImpl);
	if (resource === undefined) {
		throw new Error("该服务器没有提供 OAuth 元数据（.well-known/oauth-protected-resource），无法自动发现授权端点");
	}
	const metadata = await discoverAuthorizationServer(resource.authorizationServer, fetchImpl);
	if (metadata === undefined) {
		throw new Error(`授权服务器 ${resource.authorizationServer} 没有提供可用的 OAuth 元数据`);
	}

	const state = randomBytes(24).toString("base64url");
	const verifier = createVerifier();

	// 先监听，拿到真实端口后才能拼出与注册时一致的 redirect_uri。
	let settle;
	const done = new Promise((resolve) => {
		settle = resolve;
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/oauth/callback") {
			response.writeHead(404).end();
			return;
		}
		const gotState = url.searchParams.get("state") ?? "";
		const code = url.searchParams.get("code") ?? "";
		const error = url.searchParams.get("error") ?? "";
		const stateOk = gotState.length === state.length && timingSafeEqual(Buffer.from(gotState), Buffer.from(state));
		if (!stateOk) {
			response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("state mismatch");
			settle({ ok: false, error: "state 校验失败，请重试授权" });
			return;
		}
		if (error !== "") {
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Authorization failed. You can close this tab.");
			settle({ ok: false, error: `授权被拒绝：${error}` });
			return;
		}
		if (code === "") {
			response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("missing code");
			settle({ ok: false, error: "回调里没有授权码" });
			return;
		}
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Authorization complete. You can close this tab and return to DSH.");
		settle({ ok: true, code });
	});
	const port = await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
	const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
	const timer = setTimeout(() => settle({ ok: false, error: "等待授权超时（5 分钟），请重新发起" }), AUTH_TIMEOUT_MS);

	let registration;
	try {
		registration = options.clientId !== undefined && options.clientId !== ""
			? { clientId: options.clientId, clientSecret: options.clientSecret }
			: await registerClient(metadata, redirectUri, fetchImpl);
		if (registration === undefined) {
			await new Promise((resolve) => server.close(resolve));
			clearTimeout(timer);
			throw new Error("该授权服务器不支持动态客户端注册，请在表单里填写 client id");
		}

		const authorizationUrl = new URL(metadata.authorizationEndpoint);
		authorizationUrl.searchParams.set("response_type", "code");
		authorizationUrl.searchParams.set("client_id", registration.clientId);
		authorizationUrl.searchParams.set("redirect_uri", redirectUri);
		authorizationUrl.searchParams.set("state", state);
		authorizationUrl.searchParams.set("code_challenge", challengeOf(verifier));
		authorizationUrl.searchParams.set("code_challenge_method", "S256");
		const scope = options.scope ?? (metadata.scopesSupported ?? []).join(" ");
		if (scope !== "") authorizationUrl.searchParams.set("scope", scope);
		// RFC 8707：把资源标识带上，服务器据此签发针对该 MCP 服务器的 token。
		authorizationUrl.searchParams.set("resource", serverUrl);

		if (typeof openUrl === "function") await openUrl(authorizationUrl.toString());

		const result = await done;
		if (result.ok !== true) throw new Error(result.error);

		const form = {
			grant_type: "authorization_code",
			code: result.code,
			redirect_uri: redirectUri,
			client_id: registration.clientId,
			code_verifier: verifier
		};
		if (registration.clientSecret !== undefined) form.client_secret = registration.clientSecret;

		const body = await postToken(metadata.tokenEndpoint, form, fetchImpl);
		const record = {
			...recordFromTokenResponse(body, undefined),
			issuer: metadata.issuer,
			clientId: registration.clientId,
			clientSecret: registration.clientSecret,
			resource: serverUrl,
			tokenEndpoint: metadata.tokenEndpoint
		};
		const records = await loadOAuth(dshHome);
		records[serverName] = record;
		await saveOAuth(dshHome, records);
		return { record, authorizationUrl: authorizationUrl.toString() };
	} finally {
		clearTimeout(timer);
		await new Promise((resolve) => server.close(resolve));
	}
}

/**
 * 用 refresh token 换新的 access token。
 *
 * @returns 新记录；没有 refresh token 或刷新失败时抛错（调用方据此提示重新授权）
 */
export async function refreshServer(dshHome, serverName, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const records = await loadOAuth(dshHome);
	const previous = records[serverName];
	if (previous === undefined) throw new Error(`"${serverName}" 还没有授权记录`);
	if (typeof previous.refreshToken !== "string" || previous.refreshToken === "") {
		throw new Error(`"${serverName}" 的授权没有 refresh token，请重新授权`);
	}
	if (typeof previous.tokenEndpoint !== "string" || previous.tokenEndpoint === "") {
		throw new Error(`"${serverName}" 的授权记录缺少 token 端点，请重新授权`);
	}

	const form = {
		grant_type: "refresh_token",
		refresh_token: previous.refreshToken,
		client_id: previous.clientId ?? ""
	};
	if (typeof previous.clientSecret === "string") form.client_secret = previous.clientSecret;

	const body = await postToken(previous.tokenEndpoint, form, fetchImpl);
	const record = { ...recordFromTokenResponse(body, previous), issuer: previous.issuer, clientId: previous.clientId, clientSecret: previous.clientSecret, resource: previous.resource, tokenEndpoint: previous.tokenEndpoint };
	records[serverName] = record;
	await saveOAuth(dshHome, records);
	return record;
}

/**
 * 取一个可用的 access token：快过期就先刷新。
 * @returns token 字符串；拿不到时抛错
 */
export async function accessTokenFor(dshHome, serverName, options = {}) {
	const record = await readOAuthRecord(dshHome, serverName);
	if (record === undefined) throw new Error(`"${serverName}" 还没有授权`);
	if (tokenUsable(record)) return record.accessToken;
	const refreshed = await refreshServer(dshHome, serverName, options);
	return refreshed.accessToken;
}

/** 把 token 拼成 Authorization 头的值。 */
export function authorizationHeader(record) {
	const type = typeof record?.tokenType === "string" && record.tokenType !== "" ? record.tokenType : "Bearer";
	return `${type} ${record.accessToken}`;
}
