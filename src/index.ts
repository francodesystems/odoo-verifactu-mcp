#!/usr/bin/env node
/**
 * odoo-verifactu-mcp: read-only MCP server for Spanish tax compliance in Odoo.
 * Veri*Factu and SII status per invoice, AEAT errors grouped, QR and CSV, and a VAT summary.
 * Maintained by Francodesystems (https://francodesystems.com).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { OdooClient, type Protocol } from "./odoo.js";
import { SII_STATES, Spain, VF_STATES, currentQuarter, type Period } from "./spain.js";

const VERSION = "0.1.0";

const env = process.env;
const url = env.ODOO_URL;
const apiKey = env.ODOO_API_KEY ?? env.ODOO_PASSWORD;
if (!url || !apiKey) {
	console.error(
		"odoo-verifactu-mcp: set ODOO_URL and ODOO_API_KEY (Odoo → Preferences → Account Security → New API Key). " +
			"For Odoo 16-18 also set ODOO_DB and ODOO_USERNAME.",
	);
	process.exit(1);
}
const protocol = (env.ODOO_PROTOCOL as Protocol | "auto" | undefined) ?? "auto";

const odoo = new OdooClient({ url, apiKey, db: env.ODOO_DB, username: env.ODOO_USERNAME, protocol });
const spain = new Spain(odoo);

const server = new McpServer({ name: "odoo-verifactu-mcp", version: VERSION });

const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.optional();
const periodShape = {
	date_from: date.describe("First day (YYYY-MM-DD). Defaults to the start of the current quarter."),
	date_to: date.describe("Last day (YYYY-MM-DD). Defaults to the end of the current quarter."),
	company: z.union([z.string(), z.number()]).optional().describe("Company id or part of its name. All companies the user can see by default."),
};

function period(a: { date_from?: string; date_to?: string }): Period {
	const q = currentQuarter();
	return { date_from: a.date_from ?? q.date_from, date_to: a.date_to ?? q.date_to };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

async function run(fn: () => Promise<unknown>) {
	try {
		const result = await fn();
		return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
	} catch (err) {
		return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
	}
}

server.registerTool(
	"compliance_overview",
	{
		title: "Spanish compliance overview",
		description:
			"Start here. Which Spanish modules are installed (Odoo S.A. or OCA), how each company is configured for Veri*Factu and SII (test or production), the AEAT certificates and how many days they have left, and how many invoices of the period are pending, accepted, accepted with errors, rejected or cancelled.",
		inputSchema: periodShape,
		annotations: READ_ONLY,
	},
	async (a) => run(() => spain.overview(period(a), a.company)),
);

server.registerTool(
	"verifactu_invoices",
	{
		title: "Veri*Factu invoices",
		description:
			"Customer invoices and refunds with their Veri*Factu state: pending (not sent yet), accepted, accepted_with_errors, rejected, invalid (could not be generated or sent) or cancelled. Each row has the AEAT CSV and the last error text. Filter by state, dates, company and customer.",
		inputSchema: {
			state: z.enum(VF_STATES).optional().describe("Only invoices in this normalized state."),
			...periodShape,
			partner: z.string().optional().describe("Customer name or VAT number (partial match)."),
			limit: z.number().int().min(1).max(500).default(50),
		},
		annotations: READ_ONLY,
	},
	async (a) => run(() => spain.vfInvoices({ state: a.state, period: period(a), company: a.company, partner: a.partner, limit: a.limit })),
);

server.registerTool(
	"verifactu_errors",
	{
		title: "Veri*Factu errors grouped",
		description:
			"Why the AEAT rejected or flagged invoices in the period: each distinct error message with how many invoices have it and up to 10 invoice numbers. Covers rejected, accepted_with_errors and invalid.",
		inputSchema: periodShape,
		annotations: READ_ONLY,
	},
	async (a) => run(() => spain.vfErrors(period(a), a.company)),
);

server.registerTool(
	"sii_invoices",
	{
		title: "SII invoices",
		description:
			"Issued and received invoices with their SII (Suministro Inmediato de Información) state: pending, accepted, accepted_with_errors, modified_not_sent (OCA: changed after sending) or cancelled, with the AEAT CSV and the last error.",
		inputSchema: {
			state: z.enum(SII_STATES).optional(),
			direction: z.enum(["issued", "received"]).optional().describe("issued = customer invoices, received = vendor bills. Both by default."),
			...periodShape,
			partner: z.string().optional().describe("Customer or vendor name or VAT number (partial match)."),
			limit: z.number().int().min(1).max(500).default(50),
		},
		annotations: READ_ONLY,
	},
	async (a) => run(() => spain.siiInvoices({ state: a.state, direction: a.direction, period: period(a), company: a.company, partner: a.partner, limit: a.limit })),
);

server.registerTool(
	"invoice_aeat_detail",
	{
		title: "One invoice at the AEAT",
		description:
			"Everything about one invoice and the AEAT: Veri*Factu state, QR URL, CSV, chain index or hash, the full submission history with each error, the invoice it substitutes, and its SII state and responses.",
		inputSchema: {
			invoice: z.union([z.string(), z.number()]).describe("Invoice number (e.g. INV/2026/00012), vendor reference, or numeric id."),
			company: periodShape.company,
		},
		annotations: READ_ONLY,
	},
	async (a) => run(() => spain.invoiceDetail(a.invoice, a.company)),
);

server.registerTool(
	"vat_summary",
	{
		title: "VAT summary by tax",
		description:
			"Output VAT (repercutido) and input VAT (soportado) of posted entries in the period, by tax, with base, rate and number of lines, and the difference. A working aid to check form 303 before filing; it is not the official form.",
		inputSchema: periodShape,
		annotations: READ_ONLY,
	},
	async (a) => run(() => spain.vatSummary(period(a), a.company)),
);

async function main(): Promise<void> {
	await server.connect(new StdioServerTransport());
	console.error(`odoo-verifactu-mcp ${VERSION} ready (${url})`);
}

main().catch((err) => {
	console.error("odoo-verifactu-mcp fatal:", err);
	process.exit(1);
});
