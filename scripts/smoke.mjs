// Smoke test: starts the server over stdio and calls every tool. Needs ODOO_* in the environment.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const calls = [
  ["compliance_overview", {}],
  ["verifactu_invoices", { limit: 20 }],
  ["verifactu_invoices", { state: "rejected" }],
  ["verifactu_errors", {}],
  ["sii_invoices", { direction: "issued", limit: 5 }],
  ["sii_invoices", { state: "accepted_with_errors" }],
  ["invoice_aeat_detail", { invoice: process.env.SMOKE_INVOICE ?? "INV/2026/00005" }],
  ["vat_summary", {}],
];
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env }, stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("TOOLS", tools.map((t) => t.name).join(", "));
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? " ERROR" : ""}\n${r.content[0].text.slice(0, Number(process.env.SMOKE_CHARS ?? 1500))}`);
}
await client.close();
