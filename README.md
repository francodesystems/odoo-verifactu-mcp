# odoo-verifactu-mcp

MCP server for Spanish tax compliance in Odoo. Ask Claude (or any MCP client) which invoices the AEAT rejected and why, which ones are still pending, when your certificate expires, or how much output and input VAT the quarter has.

- **Veri\*Factu and SII** in one place, per invoice and per period.
- **Odoo's own modules and the OCA ones.** `l10n_es_edi_verifactu` and `l10n_es_edi_sii` (Odoo S.A.), or `l10n_es_verifactu_oca` and `l10n_es_aeat_sii_oca` (OCA l10n-spain). The server detects which ones you have and gives the same answers either way.
- **Odoo 16 to 20.** JSON-2 API on Odoo 19 and later, JSON-RPC on older versions.
- **Read-only.** It never sends, cancels or changes anything at the AEAT or in Odoo.

Maintained by [Francodesystems](https://francodesystems.com/odoo), Odoo implementation and integrations in Spain. Background on the Veri\*Factu dates and who is affected: [francodesystems.com/verifactu](https://francodesystems.com/verifactu).

## Tools

| Tool | What it answers |
|---|---|
| `compliance_overview` | Which Spanish modules are installed, how each company is set up (test or production), the AEAT certificates and days left, and how many invoices of the period are pending, accepted, accepted with errors, rejected or cancelled. Start here. |
| `verifactu_invoices` | Customer invoices with their Veri\*Factu state, AEAT CSV and last error. Filter by state, dates, company and customer. |
| `verifactu_errors` | The AEAT errors of the period grouped by message, with how many invoices have each one and some invoice numbers. |
| `sii_invoices` | Issued and received invoices with their SII state, CSV and last error. |
| `invoice_aeat_detail` | One invoice: state, QR URL, CSV, chain index or hash, every submission with its error, the invoice it substitutes, and its SII responses. |
| `vat_summary` | Output VAT (repercutido) and input VAT (soportado) by tax, with bases, including exempt and 0 % taxes. A working aid to check form 303; not the official form. |

Dates default to the current quarter (Europe/Madrid).

### Normalized states

Odoo S.A. and the OCA name states differently. The tools always return these:

| Veri\*Factu | Odoo S.A. | OCA (`aeat_state`) |
|---|---|---|
| `pending` | no state yet, Veri\*Factu required | `not_sent` |
| `accepted` | `accepted` | `sent` |
| `accepted_with_errors` | `registered_with_errors` | `sent_w_errors` |
| `rejected` | `rejected` | `incorrect`, `cancel_incorrect` |
| `invalid` | `invalid` (could not be generated) | `not_sent` with a failed send |
| `cancelled` | `cancelled` | `cancel`, `cancel_w_errors` |

SII: `pending`, `accepted`, `accepted_with_errors`, `modified_not_sent` (OCA only: changed after it was sent) and `cancelled`.

## Setup

1. In Odoo, open your user → **Preferences → Account Security → New API Key**. Use a user with read access to Accounting.
2. Add the server to your MCP client. Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odoo-verifactu": {
      "command": "npx",
      "args": ["-y", "@francodesystems-npm/odoo-verifactu-mcp"],
      "env": {
        "ODOO_URL": "https://mycompany.odoo.com",
        "ODOO_API_KEY": "your-api-key"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add odoo-verifactu -e ODOO_URL=https://mycompany.odoo.com -e ODOO_API_KEY=your-api-key -- npx -y @francodesystems-npm/odoo-verifactu-mcp
```

| Variable | Required | Notes |
|---|---|---|
| `ODOO_URL` | yes | Base URL of your Odoo. |
| `ODOO_API_KEY` | yes | API key (a password also works on JSON-RPC). |
| `ODOO_DB` | sometimes | When the server hosts several databases, and always on Odoo 16-18. |
| `ODOO_USERNAME` | Odoo 16-18 | The user's login. Leave it unset on Odoo 19+ to use JSON-2. |
| `ODOO_PROTOCOL` | no | `json2` or `jsonrpc` to force one. Default: chosen from the Odoo version. |

## Example questions

- "¿Qué facturas ha rechazado la AEAT este trimestre y por qué?"
- "Which invoices are still pending to send to Veri\*Factu?"
- "Show me everything about INV/2026/00123 at the AEAT."
- "When does our SII certificate expire?"
- "Give me output and input VAT for Q3 by tax."

## How it was tested

- **Odoo 20** with `l10n_es_edi_verifactu` and `l10n_es_edi_sii` (Odoo S.A.): every tool through a real MCP client, over JSON-2 and JSON-RPC (`scripts/smoke.mjs`). The VAT summary was checked to the cent against the journal items.
- **Odoo 18** with the OCA modules (`l10n_es_verifactu_oca` and `l10n_es_aeat_sii_oca` from l10n-spain 18.0): every tool over JSON-RPC, with one company on Veri\*Factu and one on SII and invoices in every `aeat_state`.
- Unit tests for the OCA state mapping (`npm test`).

The invoices were set to each state directly in test databases. Nothing was sent to the AEAT.

## Development

```bash
npm install
npm run build
npm test
ODOO_URL=... ODOO_API_KEY=... ODOO_DB=... node scripts/smoke.mjs
```

---

## En castellano

Servidor MCP para el cumplimiento fiscal español en Odoo. Le preguntas a Claude qué facturas ha rechazado la AEAT y por qué, cuáles faltan por enviar a Veri\*Factu o al SII, cuándo caduca el certificado o cuánto IVA repercutido y soportado tiene el trimestre.

Funciona con los módulos de Odoo S.A. y con los de la OCA, de Odoo 16 a 20, y solo lee: no envía, no anula y no cambia nada. Para configurarlo basta con la URL de tu Odoo y una clave de API (Preferencias → Seguridad de la cuenta → Nueva clave de API).

Lo mantiene [Francodesystems](https://francodesystems.com/odoo), implantación de Odoo e integraciones. Fechas y obligados de Veri\*Factu: [francodesystems.com/verifactu](https://francodesystems.com/verifactu).

## License

MIT
