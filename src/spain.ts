/**
 * Spanish compliance layer over Odoo. Two families of modules exist and they store things differently:
 *  - Odoo S.A. (`l10n_es_edi_verifactu`, `l10n_es_edi_sii`): Veri*Factu state stored on the invoice,
 *    history in `l10n_es_edi_verifactu.document`; SII state computed from `l10n_es_edi_sii.document`.
 *  - OCA (`l10n_es_verifactu_oca`, `l10n_es_aeat_sii_oca`): one `aeat_state` on the invoice, shared by
 *    both, plus `verifactu_enabled` / `sii_enabled` to tell which one applies.
 * Everything here maps both to the same normalized states, so the tools read the same either way.
 */
import { OdooClient } from "./odoo.js";

export type Flavor = "odoo" | "oca" | "none";

export const VF_STATES = ["pending", "accepted", "accepted_with_errors", "rejected", "invalid", "cancelled"] as const;
export type VfState = (typeof VF_STATES)[number];

export const SII_STATES = ["pending", "accepted", "accepted_with_errors", "modified_not_sent", "cancelled"] as const;
export type SiiState = (typeof SII_STATES)[number];

export interface Detected {
	version: string;
	protocol: string;
	verifactu: Flavor;
	sii: Flavor;
	moveFields: Set<string>;
}

export interface Period {
	date_from: string;
	date_to: string;
}

type Row = Record<string, unknown>;

const SALES = ["out_invoice", "out_refund"];
const ALL_INVOICES = ["out_invoice", "out_refund", "in_invoice", "in_refund"];
const SII_SCAN_LIMIT = 2000;

/** Current calendar quarter (the VAT period in Spain), in Europe/Madrid. */
export function currentQuarter(now = new Date()): Period {
	const madrid = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
	const y = madrid.getFullYear();
	const q = Math.floor(madrid.getMonth() / 3);
	const pad = (n: number) => String(n).padStart(2, "0");
	const lastDay = new Date(y, q * 3 + 3, 0).getDate();
	return { date_from: `${y}-${pad(q * 3 + 1)}-01`, date_to: `${y}-${pad(q * 3 + 3)}-${pad(lastDay)}` };
}

export function htmlToText(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	return value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|li|div|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

const m2oName = (v: unknown): string | null => (Array.isArray(v) ? String(v[1]) : null);
const m2oId = (v: unknown): number | null => (Array.isArray(v) ? Number(v[0]) : null);
const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class Spain {
	private detected?: Detected;

	constructor(readonly odoo: OdooClient) {}

	async detect(): Promise<Detected> {
		if (this.detected) return this.detected;
		const [version, protocol] = await Promise.all([this.odoo.serverVersion().catch(() => "unknown"), this.odoo.activeProtocol()]);
		// Not through fieldNames(): a wrong key or missing access must surface with Odoo's own message.
		const moveFields = new Set(Object.keys(await this.odoo.call<Record<string, unknown>>("account.move", "fields_get", { attributes: ["type"] })));
		const verifactu: Flavor = moveFields.has("l10n_es_edi_verifactu_state") ? "odoo" : moveFields.has("verifactu_enabled") ? "oca" : "none";
		const sii: Flavor = moveFields.has("l10n_es_edi_sii_document_ids") ? "odoo" : moveFields.has("sii_enabled") ? "oca" : "none";
		this.detected = { version, protocol, verifactu, sii, moveFields };
		return this.detected;
	}

	/** Resolves a company given as id or (part of a) name. */
	async companyIds(company?: string | number): Promise<number[] | undefined> {
		if (company === undefined || company === "") return undefined;
		if (typeof company === "number" || /^\d+$/.test(String(company))) return [Number(company)];
		const rows = await this.odoo.searchRead<Row>("res.company", [["name", "ilike", String(company)]], ["id"], { limit: 20 });
		if (rows.length === 0) throw new Error(`No company matches "${company}".`);
		return rows.map((r) => Number(r.id));
	}

	private async baseDomain(types: string[], period: Period, company?: string | number, partner?: string): Promise<unknown[]> {
		const d: unknown[] = [
			["move_type", "in", types],
			["state", "in", ["posted", "cancel"]],
			["invoice_date", ">=", period.date_from],
			["invoice_date", "<=", period.date_to],
		];
		const companies = await this.companyIds(company);
		if (companies) d.push(["company_id", "in", companies]);
		if (partner) d.push("|", ["partner_id.name", "ilike", partner], ["partner_id.vat", "ilike", partner]);
		return d;
	}

	// ------------------------------------------------------------------ Veri*Factu

	private vfDomain(flavor: Flavor, state: VfState): unknown[] {
		if (flavor === "odoo") {
			const f = "l10n_es_edi_verifactu_state";
			switch (state) {
				case "pending":
					return [[f, "=", false], ["l10n_es_edi_verifactu_required", "=", true], ["state", "=", "posted"]];
				case "accepted_with_errors":
					return [[f, "=", "registered_with_errors"]];
				default:
					return [[f, "=", state]];
			}
		}
		// OCA's search on verifactu_enabled only looks at the company; its compute also needs the journal.
		const on: unknown[] = [["verifactu_enabled", "=", true], ["journal_id.verifactu_enabled", "=", true]];
		switch (state) {
			case "pending":
				return [...on, ["aeat_state", "=", "not_sent"], ["aeat_send_failed", "=", false], ["state", "=", "posted"]];
			case "invalid":
				return [...on, ["aeat_state", "=", "not_sent"], ["aeat_send_failed", "=", true]];
			case "accepted":
				return [...on, ["aeat_state", "=", "sent"]];
			case "accepted_with_errors":
				return [...on, ["aeat_state", "=", "sent_w_errors"]];
			case "rejected":
				return [...on, ["aeat_state", "in", ["incorrect", "cancel_incorrect"]]];
			case "cancelled":
				return [...on, ["aeat_state", "in", ["cancel", "cancel_w_errors"]]];
		}
	}

	private vfNormalize(flavor: Flavor, r: Row): VfState | null {
		if (flavor === "odoo") {
			const s = r.l10n_es_edi_verifactu_state;
			if (!s) return r.state === "posted" && r.l10n_es_edi_verifactu_required ? "pending" : null;
			return s === "registered_with_errors" ? "accepted_with_errors" : (s as VfState);
		}
		if (!r.verifactu_enabled) return null;
		switch (r.aeat_state) {
			case "sent":
				return "accepted";
			case "sent_w_errors":
				return "accepted_with_errors";
			case "incorrect":
			case "cancel_incorrect":
				return "rejected";
			case "cancel":
			case "cancel_w_errors":
				return "cancelled";
			default:
				return r.aeat_send_failed ? "invalid" : r.state === "posted" ? "pending" : null;
		}
	}

	private vfFields(flavor: Flavor, available: Set<string>): string[] {
		const common = ["name", "invoice_date", "partner_id", "amount_total", "currency_id", "move_type", "state", "company_id"];
		const extra =
			flavor === "odoo"
				? ["l10n_es_edi_verifactu_state", "l10n_es_edi_verifactu_required"]
				: ["aeat_state", "aeat_send_failed", "aeat_send_error", "verifactu_enabled", "verifactu_csv", "verifactu_send_date"];
		return [...common, ...extra].filter((f) => available.has(f));
	}

	private async requireVf(): Promise<Detected & { verifactu: "odoo" | "oca" }> {
		const det = await this.detect();
		if (det.verifactu === "none")
			throw new Error(
				"No Veri*Factu module is installed in this Odoo. Install `l10n_es_edi_verifactu` (Odoo S.A., Odoo 18+) or `l10n_es_verifactu_oca` (OCA l10n-spain).",
			);
		return det as Detected & { verifactu: "odoo" | "oca" };
	}

	async vfCounts(period: Period, company?: string | number): Promise<Record<VfState, number>> {
		const det = await this.requireVf();
		const base = await this.baseDomain(SALES, period, company);
		const out = {} as Record<VfState, number>;
		await Promise.all(
			VF_STATES.map(async (s) => {
				out[s] = await this.odoo.searchCount("account.move", [...base, ...this.vfDomain(det.verifactu, s)]);
			}),
		);
		return out;
	}

	/** Most recent error text per invoice, for the Odoo S.A. module (from its document history). */
	private async odooVfErrors(moveIds: number[]): Promise<Map<number, { error: string; csv: string | null }>> {
		const out = new Map<number, { error: string; csv: string | null }>();
		if (moveIds.length === 0) return out;
		const docs = await this.odoo.searchRead<Row>(
			"l10n_es_edi_verifactu.document",
			[["move_id", "in", moveIds]],
			["move_id", "errors", "response_csv", "state", "create_date"],
			{ order: "create_date desc, id desc" },
		);
		for (const d of docs) {
			const id = m2oId(d.move_id);
			if (id === null || out.has(id)) continue;
			out.set(id, { error: htmlToText(d.errors), csv: (d.response_csv as string) || null });
		}
		return out;
	}

	async vfInvoices(opts: { state?: VfState; period: Period; company?: string | number; partner?: string; limit: number }) {
		const det = await this.requireVf();
		const domain = await this.baseDomain(SALES, opts.period, opts.company, opts.partner);
		if (opts.state) domain.push(...this.vfDomain(det.verifactu, opts.state));
		else if (det.verifactu === "oca") domain.push(["verifactu_enabled", "=", true], ["journal_id.verifactu_enabled", "=", true]);
		const fields = this.vfFields(det.verifactu, det.moveFields);
		const [rows, total] = await Promise.all([
			this.odoo.searchRead<Row>("account.move", domain, fields, { limit: opts.limit, order: "invoice_date desc, id desc" }),
			this.odoo.searchCount("account.move", domain),
		]);
		const errs = det.verifactu === "odoo" ? await this.odooVfErrors(rows.map((r) => Number(r.id))) : new Map();
		const invoices = rows.map((r) => {
			const e = errs.get(Number(r.id));
			const error = det.verifactu === "odoo" ? e?.error ?? "" : String(r.aeat_send_error || "");
			return {
				id: r.id,
				number: r.name,
				date: r.invoice_date,
				customer: m2oName(r.partner_id),
				total: r.amount_total,
				currency: m2oName(r.currency_id),
				type: r.move_type,
				company: m2oName(r.company_id),
				verifactu_state: this.vfNormalize(det.verifactu, r),
				aeat_csv: det.verifactu === "odoo" ? e?.csv ?? null : (r.verifactu_csv as string) || null,
				error: error ? clip(error, 300) : null,
			};
		});
		return { modules: det.verifactu, period: opts.period, total_matching: total, shown: invoices.length, invoices };
	}

	async vfErrors(period: Period, company?: string | number) {
		const det = await this.requireVf();
		const base = await this.baseDomain(SALES, period, company);
		const groups = new Map<string, { state: VfState; count: number; invoices: string[] }>();
		for (const state of ["rejected", "accepted_with_errors", "invalid"] as VfState[]) {
			const rows = await this.odoo.searchRead<Row>("account.move", [...base, ...this.vfDomain(det.verifactu, state)], this.vfFields(det.verifactu, det.moveFields), {
				limit: 500,
				order: "invoice_date desc",
			});
			const errs = det.verifactu === "odoo" ? await this.odooVfErrors(rows.map((r) => Number(r.id))) : new Map();
			for (const r of rows) {
				const raw = det.verifactu === "odoo" ? errs.get(Number(r.id))?.error ?? "" : String(r.aeat_send_error || "");
				const key = `${state}::${clip(raw || "(no error text stored)", 400)}`;
				const g = groups.get(key) ?? { state, count: 0, invoices: [] };
				g.count++;
				if (g.invoices.length < 10) g.invoices.push(String(r.name));
				groups.set(key, g);
			}
		}
		const errors = [...groups.entries()]
			.map(([k, g]) => ({ state: g.state, error: k.split("::").slice(1).join("::"), count: g.count, sample_invoices: g.invoices }))
			.sort((a, b) => b.count - a.count);
		return { modules: det.verifactu, period, distinct_errors: errors.length, errors };
	}

	// ------------------------------------------------------------------ SII

	private async requireSii(): Promise<Detected & { sii: "odoo" | "oca" }> {
		const det = await this.detect();
		if (det.sii === "none")
			throw new Error("No SII module is installed in this Odoo. Install `l10n_es_edi_sii` (Odoo S.A.) or `l10n_es_aeat_sii_oca` (OCA l10n-spain).");
		return det as Detected & { sii: "odoo" | "oca" };
	}

	private siiNormalizeOca(r: Row): SiiState | null {
		if (!r.sii_enabled) return null;
		switch (r.aeat_state) {
			case "sent":
				return "accepted";
			case "sent_w_errors":
				return "accepted_with_errors";
			case "sent_modified":
			case "cancelled_modified":
				return "modified_not_sent";
			case "cancelled":
				return "cancelled";
			default:
				return r.state === "posted" ? "pending" : null;
		}
	}

	/** Reads invoices with their SII state. Odoo S.A. computes that state without storing it, so it is filtered here. */
	async siiInvoices(opts: { state?: SiiState; direction?: "issued" | "received"; period: Period; company?: string | number; partner?: string; limit: number }) {
		const det = await this.requireSii();
		const types = opts.direction === "issued" ? SALES : opts.direction === "received" ? ["in_invoice", "in_refund"] : ALL_INVOICES;
		const domain = await this.baseDomain(types, opts.period, opts.company, opts.partner);
		const common = ["name", "ref", "invoice_date", "partner_id", "amount_total", "currency_id", "move_type", "state", "company_id"];
		type Out = { id: unknown; number: unknown; supplier_ref: unknown; date: unknown; partner: string | null; total: unknown; currency: string | null; type: unknown; company: string | null; sii_state: SiiState | null; aeat_csv: string | null; error: string | null };
		let invoices: Out[] = [];
		let scanned = 0;
		let truncated = false;

		const base = (r: Row) => ({
			id: r.id,
			number: r.name,
			supplier_ref: r.ref || null,
			date: r.invoice_date,
			partner: m2oName(r.partner_id),
			total: r.amount_total,
			currency: m2oName(r.currency_id),
			type: r.move_type,
			company: m2oName(r.company_id),
		});

		if (det.sii === "oca") {
			const map: Record<SiiState, unknown[]> = {
				pending: [["aeat_state", "=", "not_sent"], ["state", "=", "posted"]],
				accepted: [["aeat_state", "=", "sent"]],
				accepted_with_errors: [["aeat_state", "=", "sent_w_errors"]],
				modified_not_sent: [["aeat_state", "in", ["sent_modified", "cancelled_modified"]]],
				cancelled: [["aeat_state", "=", "cancelled"]],
			};
			domain.push(["sii_enabled", "=", true]);
			if (opts.state) domain.push(...map[opts.state]);
			const fields = [...common, "aeat_state", "aeat_send_error", "sii_csv", "sii_enabled"].filter((f) => det.moveFields.has(f));
			const rows = await this.odoo.searchRead<Row>("account.move", domain, fields, { limit: opts.limit, order: "invoice_date desc, id desc" });
			scanned = await this.odoo.searchCount("account.move", domain);
			invoices = rows.map((r) => ({ ...base(r), sii_state: this.siiNormalizeOca(r), aeat_csv: (r.sii_csv as string) || null, error: r.aeat_send_error ? clip(String(r.aeat_send_error), 300) : null }));
			return { modules: det.sii, period: opts.period, total_matching: scanned, shown: invoices.length, invoices };
		}

		const fields = [...common, "l10n_es_edi_sii_state", "l10n_es_edi_csv", "l10n_es_edi_sii_error", "l10n_es_edi_is_required"].filter((f) => det.moveFields.has(f));
		const rows = await this.odoo.searchRead<Row>("account.move", domain, fields, { limit: SII_SCAN_LIMIT, order: "invoice_date desc, id desc" });
		scanned = rows.length;
		truncated = rows.length === SII_SCAN_LIMIT;
		const required = rows.filter((r) => r.l10n_es_edi_is_required);
		const withErrors = new Set<number>();
		if (required.length) {
			const docs = await this.odoo.searchRead<Row>("l10n_es_edi_sii.document", [["move_id", "in", required.map((r) => Number(r.id))], ["state", "=", "accepted_with_errors"]], ["move_id"]);
			for (const d of docs) {
				const id = m2oId(d.move_id);
				if (id !== null) withErrors.add(id);
			}
		}
		for (const r of required) {
			const raw = r.l10n_es_edi_sii_state;
			let s: SiiState | null = raw === "sent" ? (withErrors.has(Number(r.id)) ? "accepted_with_errors" : "accepted") : raw === "cancelled" ? "cancelled" : raw === "to_send" && r.state === "posted" ? "pending" : null;
			if (s === null) continue;
			if (opts.state && s !== opts.state) continue;
			const err = htmlToText(r.l10n_es_edi_sii_error);
			invoices.push({ ...base(r), sii_state: s, aeat_csv: (r.l10n_es_edi_csv as string) || null, error: err ? clip(err, 300) : null });
		}
		const total = invoices.length;
		invoices = invoices.slice(0, opts.limit);
		return {
			modules: det.sii,
			period: opts.period,
			total_matching: total,
			shown: invoices.length,
			...(truncated ? { warning: `Only the latest ${SII_SCAN_LIMIT} invoices of the period were checked. Narrow the dates.` } : {}),
			invoices,
		};
	}

	async siiCounts(period: Period, company?: string | number): Promise<Record<string, number>> {
		const res = await this.siiInvoices({ period, company, limit: SII_SCAN_LIMIT });
		const out: Record<string, number> = Object.fromEntries(SII_STATES.map((s) => [s, 0]));
		for (const i of res.invoices) if (i.sii_state) out[i.sii_state]++;
		return out;
	}

	// ------------------------------------------------------------------ One invoice

	async findInvoice(invoice: string | number, company?: string | number): Promise<Row> {
		const domain: unknown[] = typeof invoice === "number" || /^\d+$/.test(String(invoice)) ? [["id", "=", Number(invoice)]] : ["|", ["name", "=", String(invoice)], ["ref", "=", String(invoice)]];
		const companies = await this.companyIds(company);
		if (companies) domain.push(["company_id", "in", companies]);
		const rows = await this.odoo.searchRead<Row>("account.move", [...domain, ["move_type", "in", ALL_INVOICES]], ["id", "name", "company_id", "partner_id", "invoice_date"], { limit: 10 });
		if (rows.length === 0) throw new Error(`No invoice found for "${invoice}". Use the invoice number (e.g. INV/2026/00012), the vendor reference or the id.`);
		if (rows.length > 1) {
			const list = rows.map((r) => `id ${r.id}: ${r.name}, ${m2oName(r.company_id)}, ${m2oName(r.partner_id)}, ${r.invoice_date}`).join("; ");
			throw new Error(`"${invoice}" matches ${rows.length} invoices. Pass the id or the company. Matches: ${list}`);
		}
		return rows[0];
	}

	async invoiceDetail(invoice: string | number, company?: string | number) {
		const det = await this.detect();
		const { id } = await this.findInvoice(invoice, company);
		const core = ["name", "ref", "invoice_date", "partner_id", "amount_untaxed", "amount_tax", "amount_total", "currency_id", "move_type", "state", "company_id"];
		// OCA computes some Veri*Factu fields eagerly and raises on invoices that are not Veri*Factu
		// (e.g. "tax is not mapped to VERI*FACTU" on an SII vendor bill), so first read which regime applies.
		const flags = ["verifactu_enabled", "sii_enabled", "l10n_es_edi_verifactu_required", "l10n_es_edi_is_required"].filter((f) => det.moveFields.has(f));
		const [base] = await this.odoo.call<Row[]>("account.move", "read", { ids: [id], fields: [...core, ...flags] });
		const extra: string[] = [];
		if (det.verifactu === "odoo")
			extra.push("l10n_es_edi_verifactu_state", "l10n_es_edi_verifactu_warning", "l10n_es_edi_verifactu_qr_code", "l10n_es_edi_verifactu_substituted_entry_id");
		if (det.verifactu === "oca" && base.verifactu_enabled)
			extra.push("aeat_state", "aeat_send_error", "aeat_send_failed", "verifactu_csv", "verifactu_qr_url", "verifactu_hash", "verifactu_send_date", "verifactu_registration_date", "verifactu_return");
		if (det.sii === "odoo" && base.l10n_es_edi_is_required) extra.push("l10n_es_edi_sii_state", "l10n_es_edi_csv", "l10n_es_edi_sii_error", "l10n_es_registration_date");
		if (det.sii === "oca" && base.sii_enabled) extra.push("aeat_state", "aeat_send_error", "aeat_send_failed", "sii_csv", "sii_send_date", "sii_return");
		const wanted = [...new Set(extra)].filter((f) => det.moveFields.has(f));
		let r: Row = base;
		if (wanted.length) {
			try {
				const [more] = await this.odoo.call<Row[]>("account.move", "read", { ids: [id], fields: wanted });
				r = { ...base, ...more };
			} catch {
				// One computed field failed: read them one by one and keep what Odoo can give.
				r = { ...base };
				for (const f of wanted) {
					try {
						const [one] = await this.odoo.call<Row[]>("account.move", "read", { ids: [id], fields: [f] });
						r[f] = one[f];
					} catch {
						r[f] = null;
					}
				}
			}
		}

		const out: Row = {
			id: r.id,
			number: r.name,
			reference: r.ref || null,
			date: r.invoice_date,
			partner: m2oName(r.partner_id),
			untaxed: r.amount_untaxed,
			tax: r.amount_tax,
			total: r.amount_total,
			currency: m2oName(r.currency_id),
			type: r.move_type,
			odoo_state: r.state,
			company: m2oName(r.company_id),
		};

		if (det.verifactu === "odoo") {
			const docs = await this.odoo.searchRead<Row>(
				"l10n_es_edi_verifactu.document",
				[["move_id", "=", id]],
				["document_type", "state", "errors", "response_csv", "chain_index", "create_date"],
				{ order: "create_date desc, id desc", limit: 20 },
			);
			out.verifactu = {
				modules: "odoo",
				state: this.vfNormalize("odoo", r),
				odoo_state: r.l10n_es_edi_verifactu_state || null,
				required: !!r.l10n_es_edi_verifactu_required,
				qr_url: r.l10n_es_edi_verifactu_qr_code || null,
				warning: htmlToText(r.l10n_es_edi_verifactu_warning) || null,
				substitutes: m2oName(r.l10n_es_edi_verifactu_substituted_entry_id),
				history: docs.map((d) => ({
					date: d.create_date,
					type: d.document_type,
					state: d.state === "registered_with_errors" ? "accepted_with_errors" : d.state,
					aeat_csv: d.response_csv || null,
					chain_index: d.chain_index || null,
					errors: htmlToText(d.errors) || null,
				})),
			};
		} else if (det.verifactu === "oca" && r.verifactu_enabled) {
			out.verifactu = {
				modules: "oca",
				state: this.vfNormalize("oca", r),
				oca_state: r.aeat_state,
				aeat_csv: r.verifactu_csv || null,
				qr_url: r.verifactu_qr_url || null,
				hash: r.verifactu_hash || null,
				registration_date: r.verifactu_registration_date || null,
				send_date: r.verifactu_send_date || null,
				error: r.aeat_send_error || null,
				aeat_response: r.verifactu_return ? clip(String(r.verifactu_return), 2000) : null,
			};
		}

		if (det.sii === "odoo" && r.l10n_es_edi_is_required) {
			const docs = await this.odoo.searchRead<Row>("l10n_es_edi_sii.document", [["move_id", "=", id]], ["state", "csv", "response_message", "create_date"], {
				order: "create_date desc, id desc",
				limit: 20,
			});
			out.sii = {
				modules: "odoo",
				state: r.l10n_es_edi_sii_state === "sent" ? (docs[0]?.state === "accepted_with_errors" ? "accepted_with_errors" : "accepted") : r.l10n_es_edi_sii_state === "to_send" ? "pending" : r.l10n_es_edi_sii_state,
				aeat_csv: r.l10n_es_edi_csv || null,
				registration_date: r.l10n_es_registration_date || null,
				error: htmlToText(r.l10n_es_edi_sii_error) || null,
				history: docs.map((d) => ({ date: d.create_date, state: d.state, aeat_csv: d.csv || null, message: htmlToText(d.response_message) || null })),
			};
		} else if (det.sii === "oca" && r.sii_enabled) {
			out.sii = {
				modules: "oca",
				state: this.siiNormalizeOca(r),
				oca_state: r.aeat_state,
				aeat_csv: r.sii_csv || null,
				send_date: r.sii_send_date || null,
				error: r.aeat_send_error || null,
				aeat_response: r.sii_return ? clip(String(r.sii_return), 2000) : null,
			};
		}
		if (!out.verifactu && !out.sii) out.note = "This invoice is not subject to Veri*Factu or SII in this Odoo (module not installed or not enabled for its company).";
		return out;
	}

	// ------------------------------------------------------------------ Overview and VAT

	async overview(period: Period, company?: string | number) {
		const det = await this.detect();
		const modules = await this.odoo
			.searchRead<Row>(
				"ir.module.module",
				[["name", "in", ["l10n_es", "l10n_es_edi_verifactu", "l10n_es_edi_sii", "l10n_es_edi_tbai", "l10n_es_verifactu_oca", "l10n_es_aeat_sii_oca", "l10n_es_aeat_mod303", "l10n_es_ticketbai"]]],
				["name", "state", "latest_version"],
			)
			.catch(() => []);
		const companyFields = await this.odoo.fieldNames("res.company");
		const cFields = [
			"name", "vat",
			"l10n_es_edi_verifactu_required", "l10n_es_edi_verifactu_test_environment",
			"l10n_es_sii_tax_agency", "l10n_es_sii_test_env",
			"verifactu_enabled", "verifactu_test", "verifactu_start_date", "sii_enabled", "sii_test", "sii_start_date",
		].filter((f) => companyFields.has(f));
		const companyIds = await this.companyIds(company);
		const companies = await this.odoo.searchRead<Row>("res.company", companyIds ? [["id", "in", companyIds]] : [], cFields, { limit: 50 });

		const certs = await this.certificates(companyIds);
		const result: Row = {
			odoo_version: det.version,
			protocol: det.protocol,
			verifactu_modules: det.verifactu,
			sii_modules: det.sii,
			installed: modules.filter((m) => m.state === "installed").map((m) => m.name),
			companies: companies.map((c) => {
				const o: Row = { id: c.id, name: c.name, vat: c.vat || null };
				for (const f of cFields.slice(2)) if (f in c) o[f] = c[f];
				return o;
			}),
			certificates: certs,
			period,
		};
		if (det.verifactu !== "none") result.verifactu_counts = await this.vfCounts(period, company);
		if (det.sii !== "none") result.sii_counts = await this.siiCounts(period, company);
		return result;
	}

	private async certificates(companyIds?: number[]) {
		const fields = await this.odoo.fieldNames("certificate.certificate");
		if (fields.size === 0) return undefined;
		const want = ["name", "company_id", "date_start", "date_end", "scope", "is_valid"].filter((f) => fields.has(f));
		const rows = await this.odoo
			.searchRead<Row>("certificate.certificate", companyIds ? [["company_id", "in", companyIds]] : [], want, { limit: 50, order: "date_end desc" })
			.catch(() => []);
		const today = Date.now();
		return rows.map((c) => ({
			name: c.name,
			company: m2oName(c.company_id),
			scope: c.scope || null,
			valid_until: c.date_end || null,
			days_left: c.date_end ? Math.floor((Date.parse(String(c.date_end)) - today) / 86_400_000) : null,
			is_valid: c.is_valid ?? null,
		}));
	}

	/**
	 * VAT of posted entries in the period, by tax. The base comes from the lines that carry each tax
	 * (so 0 % and exempt taxes, which create no tax line, still show their base); the amount comes from
	 * the tax lines. A working aid for form 303, not the official form.
	 */
	async vatSummary(period: Period, company?: string | number) {
		const common: unknown[] = [
			["parent_state", "=", "posted"],
			["date", ">=", period.date_from],
			["date", "<=", period.date_to],
		];
		const companies = await this.companyIds(company);
		if (companies) common.push(["company_id", "in", companies]);
		const LIMIT = 20000;
		const [taxLines, baseLines] = await Promise.all([
			this.odoo.searchRead<Row>("account.move.line", [...common, ["tax_line_id", "!=", false]], ["tax_line_id", "balance"], { limit: LIMIT }),
			this.odoo.searchRead<Row>("account.move.line", [...common, ["tax_ids", "!=", false]], ["tax_ids", "balance"], { limit: LIMIT }),
		]);
		const byTax = new Map<number, { amount: number; base: number; lines: number }>();
		const get = (id: number) => {
			let g = byTax.get(id);
			if (!g) byTax.set(id, (g = { amount: 0, base: 0, lines: 0 }));
			return g;
		};
		for (const l of taxLines) {
			const id = m2oId(l.tax_line_id);
			if (id !== null) get(id).amount += Number(l.balance) || 0;
		}
		for (const l of baseLines) {
			for (const id of (l.tax_ids as number[]) ?? []) {
				const g = get(Number(id));
				g.base += Number(l.balance) || 0;
				g.lines++;
			}
		}
		const taxIds = [...byTax.keys()];
		const taxes = taxIds.length
			? await this.odoo.call<Row[]>("account.tax", "read", { ids: taxIds, fields: ["name", "type_tax_use", "amount", "amount_type", "company_id"] })
			: [];
		const info = new Map(taxes.map((t) => [Number(t.id), t]));
		const r2 = (n: number) => Math.round(n * 100) / 100;
		const rows = taxIds.map((id) => {
			const g = byTax.get(id)!;
			const t = info.get(id);
			const isSale = t?.type_tax_use === "sale";
			const sign = isSale ? -1 : 1;
			return {
				tax: (t?.name as string) ?? String(id),
				company: m2oName(t?.company_id),
				kind: isSale ? "output (repercutido)" : t?.type_tax_use === "purchase" ? "input (soportado)" : String(t?.type_tax_use ?? "other"),
				rate: t?.amount_type === "percent" ? t.amount : null,
				base: r2(sign * g.base),
				tax_amount: r2(sign * g.amount),
				base_lines: g.lines,
			};
		});
		rows.sort((a, b) => (a.company ?? "").localeCompare(b.company ?? "") || a.kind.localeCompare(b.kind) || Math.abs(b.base) - Math.abs(a.base));
		const sum = (k: string) => r2(rows.filter((r) => r.kind.startsWith(k)).reduce((s, r) => s + r.tax_amount, 0));
		const truncated = taxLines.length === LIMIT || baseLines.length === LIMIT;
		return {
			period,
			output_vat: sum("output"),
			input_vat: sum("input"),
			difference: r2(sum("output") - sum("input")),
			note: "Posted entries by tax. Output and input VAT as positive amounts; refunds reduce them. Exempt and 0 % taxes show their base. Withholdings (IRPF) and surcharges (recargo) appear as their own taxes. If several companies are included, add them up separately. A working aid, not the official form 303.",
			...(truncated ? { warning: `Only the first ${LIMIT} lines were read. Narrow the period or the company.` } : {}),
			taxes: rows,
		};
	}
}
