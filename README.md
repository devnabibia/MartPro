# Counter: a complete POS + inventory system (Go, React, TypeScript)

Install Go 1.22 or newer, then:

    cd backend
    go run .

Open http://localhost:8080. The React app is built into the program and nothing needs downloading.
All data is saved in backend/pos.json: back this file up.

## What it does
- Register: search or scan barcodes (a scanner types the SKU and presses Enter), discounts, tax,
  cash / card / mobile money, change calculation, printable receipts.
- Inventory: products, stock adjustments, low-stock alerts.
- Sales: history, sale details, voids that return items to stock.
- Reports (manager): totals, tax, discounts, payment breakdown, top products, CSV download.
- Settings (manager): shop name and tax rate.

## PINs and roles
- No PIN set: anyone can use everything.
- `POS_PIN=1234 go run .`: one PIN, full access.
- `POS_ADMIN_PIN=9999 POS_PIN=1234 go run .`: managers use 9999 and see everything; cashiers use
  1234 and only get the Register and Sales tabs (no voids, stock edits, reports or settings).
`PORT=9000` changes the port.

To change the interface: edit frontend/src, run `npm install && npm run build` in frontend
(it writes into backend/web), then `go run .` again.
