// OCA field mapping (l10n_es_verifactu_oca / l10n_es_aeat_sii_oca, 18.0) against a fake Odoo.
// Field names and states copied from the OCA sources: aeat_mixin.py (AEAT_STATES),
// verifactu_mixin.py (VERIFACTU_EXTRA_AEAT_STATES) and sii_mixin.py (SII_STATES).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Spain } from "../dist/spain.js";

const MOVE_FIELDS = ["name", "ref", "invoice_date", "partner_id", "amount_total", "amount_untaxed", "amount_tax", "currency_id", "move_type", "state", "company_id",
  "aeat_state", "aeat_send_error", "aeat_send_failed", "verifactu_enabled", "verifactu_csv", "verifactu_qr_url", "verifactu_hash", "verifactu_send_date",
  "verifactu_registration_date", "verifactu_return", "sii_enabled", "sii_csv", "sii_send_date", "sii_return"];

function fakeOdoo(rows) {
  const calls = [];
  const match = (r, d) => {
    // Minimal domain evaluation: ANDed leaves, "|" ignored (only used for partner/name lookups).
    return d.filter(Array.isArray).every(([f, op, v]) => {
      if (f.includes(".")) return true;
      const x = r[f];
      if (op === "=") return (x ?? false) === v;
      if (op === "in") return v.includes(x);
      if (op === ">=" ) return x >= v;
      if (op === "<=" ) return x <= v;
      return true;
    });
  };
  return {
    calls,
    serverVersion: async () => "18.0",
    activeProtocol: async () => "jsonrpc",
    fieldNames: async () => new Set(),
    call: async (model, method, kw) => {
      calls.push([model, method, kw]);
      if (method === "fields_get") return Object.fromEntries(MOVE_FIELDS.map((f) => [f, {}]));
      if (method === "read") return rows.filter((r) => kw.ids.includes(r.id));
      throw new Error(`unexpected ${model}.${method}`);
    },
    searchRead: async (model, domain, fields, opts = {}) => {
      calls.push([model, "search_read", domain]);
      return rows.filter((r) => match(r, domain)).slice(0, opts.limit ?? 1e9);
    },
    searchCount: async (model, domain) => rows.filter((r) => match(r, domain)).length,
  };
}

const base = { move_type: "out_invoice", state: "posted", invoice_date: "2026-10-15", company_id: [1, "Co"], partner_id: [7, "Cliente"], currency_id: [1, "EUR"], amount_total: 121 };
const ROWS = [
  { id: 1, name: "F1", ...base, verifactu_enabled: true, aeat_state: "sent", verifactu_csv: "CSV1" },
  { id: 2, name: "F2", ...base, verifactu_enabled: true, aeat_state: "sent_w_errors", aeat_send_error: "[2000] huella" },
  { id: 3, name: "F3", ...base, verifactu_enabled: true, aeat_state: "incorrect", aeat_send_error: "[4102] esquema" },
  { id: 4, name: "F4", ...base, verifactu_enabled: true, aeat_state: "not_sent", aeat_send_failed: false },
  { id: 5, name: "F5", ...base, verifactu_enabled: true, aeat_state: "not_sent", aeat_send_failed: true, aeat_send_error: "timeout" },
  { id: 6, name: "F6", ...base, verifactu_enabled: true, aeat_state: "cancel_w_errors" },
  { id: 7, name: "F7", ...base, verifactu_enabled: true, aeat_state: "cancel_incorrect", aeat_send_error: "[3000] anulación" },
  { id: 8, name: "S1", ...base, sii_enabled: true, verifactu_enabled: false, aeat_state: "sent_modified", sii_csv: "SII8" },
  { id: 9, name: "S2", ...base, move_type: "in_invoice", sii_enabled: true, verifactu_enabled: false, aeat_state: "not_sent" },
];
const period = { date_from: "2026-10-01", date_to: "2026-12-31" };

test("detects OCA for both Veri*Factu and SII", async () => {
  const det = await new Spain(fakeOdoo(ROWS)).detect();
  assert.equal(det.verifactu, "oca");
  assert.equal(det.sii, "oca");
});

test("Veri*Factu counts map every OCA aeat_state", async () => {
  const counts = await new Spain(fakeOdoo(ROWS)).vfCounts(period);
  assert.deepEqual(counts, { pending: 1, accepted: 1, accepted_with_errors: 1, rejected: 2, invalid: 1, cancelled: 1 });
});

test("Veri*Factu list normalizes states and keeps CSV and error", async () => {
  const res = await new Spain(fakeOdoo(ROWS)).vfInvoices({ period, limit: 50 });
  const by = Object.fromEntries(res.invoices.map((i) => [i.number, i]));
  assert.equal(by.F1.verifactu_state, "accepted");
  assert.equal(by.F1.aeat_csv, "CSV1");
  assert.equal(by.F3.verifactu_state, "rejected");
  assert.equal(by.F3.error, "[4102] esquema");
  assert.equal(by.F5.verifactu_state, "invalid");
  assert.equal(by.F7.verifactu_state, "rejected");
  assert.equal(by.S1, undefined, "SII-only invoices are not Veri*Factu");
});

test("SII list maps modified and pending", async () => {
  const res = await new Spain(fakeOdoo(ROWS)).siiInvoices({ period, limit: 50 });
  const by = Object.fromEntries(res.invoices.map((i) => [i.number, i]));
  assert.equal(by.S1.sii_state, "modified_not_sent");
  assert.equal(by.S1.aeat_csv, "SII8");
  assert.equal(by.S2.sii_state, "pending");
});

test("errors are grouped by message", async () => {
  const res = await new Spain(fakeOdoo(ROWS)).vfErrors(period);
  assert.equal(res.distinct_errors, 4);
  assert.ok(res.errors.some((e) => e.state === "invalid" && e.error === "timeout"));
});
