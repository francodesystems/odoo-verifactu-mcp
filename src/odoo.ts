/**
 * Minimal Odoo client with two transports:
 *  - JSON-2 (`/json/2/<model>/<method>`, Odoo 19+): API key as bearer token.
 *  - JSON-RPC (`/jsonrpc`, Odoo 16-18, still available in 19 and 20): login + API key or password.
 * Both take named arguments, so the rest of the server never cares which one is in use.
 */

export type Protocol = "json2" | "jsonrpc";

export interface OdooConfig {
	url: string;
	apiKey: string;
	db?: string;
	username?: string;
	protocol?: Protocol | "auto";
	timeoutMs?: number;
}

export class OdooError extends Error {
	constructor(
		message: string,
		readonly detail?: string,
	) {
		super(message);
		this.name = "OdooError";
	}
}

type Kw = Record<string, unknown>;

export class OdooClient {
	private readonly url: string;
	private protocol?: Protocol;
	private uid?: number;
	private version?: string;
	private rpcId = 0;

	constructor(private readonly cfg: OdooConfig) {
		this.url = cfg.url.replace(/\/+$/, "");
		if (cfg.protocol && cfg.protocol !== "auto") this.protocol = cfg.protocol;
	}

	/** Server version string, e.g. "18.0+e". */
	async serverVersion(): Promise<string> {
		if (this.version) return this.version;
		const res = await this.post("/web/webclient/version_info", { jsonrpc: "2.0", method: "call", params: {} });
		const info = (res as { result?: { server_version?: string } }).result;
		this.version = info?.server_version ?? "unknown";
		return this.version;
	}

	async activeProtocol(): Promise<Protocol> {
		if (this.protocol) return this.protocol;
		if (!this.cfg.username) {
			this.protocol = "json2";
			return this.protocol;
		}
		const major = Number.parseInt((await this.serverVersion()).replace(/^saas~/, ""), 10);
		this.protocol = Number.isFinite(major) && major >= 19 ? "json2" : "jsonrpc";
		return this.protocol;
	}

	/** Calls `model.method` with named arguments. `ids` goes in the body for record methods. */
	async call<T = unknown>(model: string, method: string, kw: Kw = {}): Promise<T> {
		return (await this.activeProtocol()) === "json2" ? this.callJson2<T>(model, method, kw) : this.callJsonRpc<T>(model, method, kw);
	}

	searchRead<T = Record<string, unknown>>(model: string, domain: unknown[], fields: string[], opts: { limit?: number; order?: string } = {}): Promise<T[]> {
		return this.call<T[]>(model, "search_read", { domain, fields, ...opts });
	}

	searchCount(model: string, domain: unknown[]): Promise<number> {
		return this.call<number>(model, "search_count", { domain });
	}

	/** Field names of a model (empty set if the model does not exist or is not readable). */
	async fieldNames(model: string): Promise<Set<string>> {
		try {
			const fields = await this.call<Record<string, unknown>>(model, "fields_get", { attributes: ["type"] });
			return new Set(Object.keys(fields));
		} catch {
			return new Set();
		}
	}

	private async callJson2<T>(model: string, method: string, kw: Kw): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `bearer ${this.cfg.apiKey}`,
			"Content-Type": "application/json; charset=utf-8",
		};
		if (this.cfg.db) headers["X-Odoo-Database"] = this.cfg.db;
		const res = await this.fetchJson(`/json/2/${model}/${method}`, kw, headers);
		if (!res.ok) {
			const body = res.body as { message?: string; name?: string; debug?: string } | undefined;
			if (res.status === 401) throw new OdooError("Odoo rejected the API key (401). Check ODOO_API_KEY and, if there are several databases, ODOO_DB.");
			if (res.status === 404 && !body?.message) throw new OdooError(`Odoo returned 404 for ${model}.${method}. Is this Odoo 19 or later? For older versions set ODOO_USERNAME and ODOO_DB.`);
			throw new OdooError(body?.message ?? `Odoo error ${res.status} on ${model}.${method}`, body?.name);
		}
		return res.body as T;
	}

	private async callJsonRpc<T>(model: string, method: string, kw: Kw): Promise<T> {
		const { db, username, apiKey } = this.cfg;
		if (!db || !username) throw new OdooError("JSON-RPC needs ODOO_DB and ODOO_USERNAME.");
		if (this.uid === undefined) {
			const uid = await this.rpc("common", "authenticate", [db, username, apiKey, {}]);
			if (!uid) throw new OdooError("Odoo login failed: check ODOO_DB, ODOO_USERNAME and ODOO_API_KEY.");
			this.uid = uid as number;
		}
		const { ids, ...rest } = kw;
		const args = ids === undefined ? [] : [ids];
		return (await this.rpc("object", "execute_kw", [db, this.uid, apiKey, model, method, args, rest])) as T;
	}

	private async rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
		const res = await this.post("/jsonrpc", { jsonrpc: "2.0", method: "call", id: ++this.rpcId, params: { service, method, args } });
		const r = res as { result?: unknown; error?: { message?: string; data?: { message?: string; name?: string } } };
		if (r.error) throw new OdooError(r.error.data?.message ?? r.error.message ?? "Odoo JSON-RPC error", r.error.data?.name);
		return r.result;
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const res = await this.fetchJson(path, body, { "Content-Type": "application/json" });
		if (!res.ok) throw new OdooError(`Odoo returned HTTP ${res.status} on ${path}`);
		return res.body;
	}

	private async fetchJson(path: string, body: unknown, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown }> {
		let res: Response;
		try {
			res = await fetch(`${this.url}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
			});
		} catch (err) {
			throw new OdooError(`Cannot reach Odoo at ${this.url}: ${(err as Error).message}`);
		}
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		return { ok: res.ok, status: res.status, body: parsed };
	}
}
