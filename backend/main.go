// Counter: a point-of-sale and inventory server. Standard library only, no setup needed.
// Run with: go run .
package main

import (
	"crypto/subtle"
	"embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:web
var webFS embed.FS // the built React app, compiled into the program

const dataFile = "pos.json"

type Product struct {
	ID         int64  `json:"id"`
	SKU        string `json:"sku"`
	Name       string `json:"name"`
	PriceCents int    `json:"priceCents"`
	Stock      int    `json:"stock"`
	LowStock   int    `json:"lowStock"`
}

type Line struct {
	ProductID  int64  `json:"productId"`
	Name       string `json:"name"`
	Qty        int    `json:"qty"`
	PriceCents int    `json:"priceCents"`
}

type Sale struct {
	ID         int64  `json:"id"`
	TotalCents int    `json:"totalCents"`
	Items      int    `json:"items"`
	CreatedAt  string `json:"createdAt"`
	Voided     bool   `json:"voided"`
	Lines      []Line `json:"lines,omitempty"`

	SubtotalCents int    `json:"subtotalCents"`
	DiscountCents int    `json:"discountCents"`
	TaxCents      int    `json:"taxCents"`
	Payment       string `json:"payment"` // cash, card or mobile
	PaidCents     int    `json:"paidCents"`
}

type Settings struct {
	ShopName   string  `json:"shopName"`
	TaxPercent float64 `json:"taxPercent"`
}

type Store struct {
	Products []Product `json:"products"`
	Sales    []Sale    `json:"sales"`
	NextID   int64     `json:"nextId"`
	Settings Settings  `json:"settings"`
}

var (
	mu sync.Mutex
	st Store
)

func load() {
	if b, err := os.ReadFile(dataFile); err == nil {
		if err := json.Unmarshal(b, &st); err != nil {
			log.Fatalf("%s is damaged: %v", dataFile, err)
		}
	}
	if st.NextID == 0 {
		st.NextID = 1
	}
}

// save writes to a temp file then renames it, so a crash never leaves a half-written file.
func save() error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(dataFile+".tmp", b, 0o644); err != nil {
		return err
	}
	return os.Rename(dataFile+".tmp", dataFile)
}

func respond(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if v != nil {
		json.NewEncoder(w).Encode(v)
	}
}

func fail(w http.ResponseWriter, code int, msg string) { respond(w, code, map[string]string{"error": msg}) }

// commit saves and replies; callers hold mu.
func commit(w http.ResponseWriter, code int, v any) {
	if err := save(); err != nil {
		fail(w, 500, "Could not save data: "+err.Error())
		return
	}
	respond(w, code, v)
}

func pid(r *http.Request) int64 { id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64); return id }

func findProduct(id int64) *Product {
	for i := range st.Products {
		if st.Products[i].ID == id {
			return &st.Products[i]
		}
	}
	return nil
}

func listProducts(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	out := append([]Product{}, st.Products...)
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	respond(w, 200, out)
}

func saveProduct(w http.ResponseWriter, r *http.Request) {
	var p Product
	if json.NewDecoder(r.Body).Decode(&p) != nil || strings.TrimSpace(p.Name) == "" || strings.TrimSpace(p.SKU) == "" ||
		p.PriceCents < 0 || p.Stock < 0 || p.LowStock < 0 {
		fail(w, 400, "SKU and name are required; price and stock cannot be negative")
		return
	}
	mu.Lock()
	defer mu.Unlock()
	id := pid(r)
	for _, o := range st.Products {
		if o.ID != id && strings.EqualFold(o.SKU, p.SKU) {
			fail(w, 409, "That SKU is already in use")
			return
		}
	}
	if id == 0 {
		p.ID = st.NextID
		st.NextID++
		st.Products = append(st.Products, p)
	} else if cur := findProduct(id); cur != nil {
		p.ID = id
		*cur = p
	} else {
		fail(w, 404, "Product not found")
		return
	}
	commit(w, 200, map[string]bool{"ok": true})
}

func deleteProduct(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	id, keep := pid(r), st.Products[:0]
	for _, p := range st.Products {
		if p.ID != id {
			keep = append(keep, p)
		}
	}
	st.Products = keep
	commit(w, 204, nil)
}

func adjustStock(w http.ResponseWriter, r *http.Request) {
	var b struct{ Delta int `json:"delta"` }
	json.NewDecoder(r.Body).Decode(&b)
	mu.Lock()
	defer mu.Unlock()
	p := findProduct(pid(r))
	if p == nil || p.Stock+b.Delta < 0 {
		fail(w, 409, "Stock cannot go below zero")
		return
	}
	p.Stock += b.Delta
	commit(w, 200, map[string]bool{"ok": true})
}

func createSale(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Items []struct {
			ProductID int64 `json:"productId"`
			Qty       int   `json:"qty"`
		} `json:"items"`
		DiscountCents int    `json:"discountCents"`
		Payment       string `json:"payment"`
		PaidCents     int    `json:"paidCents"`
	}
	if json.NewDecoder(r.Body).Decode(&b) != nil || len(b.Items) == 0 {
		fail(w, 400, "Add at least one item")
		return
	}
	mu.Lock()
	defer mu.Unlock()
	want, order, subtotal := map[int64]int{}, []int64{}, 0
	for _, it := range b.Items {
		if it.Qty < 1 || findProduct(it.ProductID) == nil {
			fail(w, 400, "Invalid item in cart")
			return
		}
		if want[it.ProductID] == 0 {
			order = append(order, it.ProductID)
		}
		want[it.ProductID] += it.Qty
	}
	for _, id := range order { // check everything first so a sale is all-or-nothing
		p := findProduct(id)
		if p.Stock < want[id] {
			fail(w, 409, "Not enough stock for "+p.Name)
			return
		}
		subtotal += p.PriceCents * want[id] // prices come from the server, not the browser
	}
	if b.Payment == "" {
		b.Payment = "cash"
	}
	if b.Payment != "cash" && b.Payment != "card" && b.Payment != "mobile" {
		fail(w, 400, "Unknown payment method")
		return
	}
	if b.DiscountCents < 0 || b.DiscountCents > subtotal {
		fail(w, 400, "Discount cannot be more than the subtotal")
		return
	}
	tax := int(math.Round(float64(subtotal-b.DiscountCents) * st.Settings.TaxPercent / 100))
	total := subtotal - b.DiscountCents + tax
	if b.Payment == "cash" && b.PaidCents > 0 && b.PaidCents < total {
		fail(w, 400, "Cash received is less than the total")
		return
	}
	if b.Payment != "cash" || b.PaidCents == 0 {
		b.PaidCents = total
	}
	s := Sale{ID: st.NextID, CreatedAt: time.Now().Format("2006-01-02 15:04:05"), SubtotalCents: subtotal,
		DiscountCents: b.DiscountCents, TaxCents: tax, TotalCents: total, Payment: b.Payment, PaidCents: b.PaidCents}
	st.NextID++
	for _, id := range order {
		qty, p := want[id], findProduct(id)
		p.Stock -= qty
		s.Lines = append(s.Lines, Line{id, p.Name, qty, p.PriceCents})
		s.Items += qty
	}
	st.Sales = append(st.Sales, s)
	out := s
	out.Lines = nil
	commit(w, 201, out)
}

func listSales(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	out := []Sale{}
	for i := len(st.Sales) - 1; i >= 0 && len(out) < 100; i-- {
		s := st.Sales[i]
		s.Lines = nil
		out = append(out, s)
	}
	respond(w, 200, out)
}

func findSale(id int64) *Sale {
	for i := range st.Sales {
		if st.Sales[i].ID == id {
			return &st.Sales[i]
		}
	}
	return nil
}

func saleDetail(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	if s := findSale(pid(r)); s != nil {
		respond(w, 200, s)
		return
	}
	fail(w, 404, "Sale not found")
}

// voidSale cancels a sale and returns its items to stock.
func voidSale(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	s := findSale(pid(r))
	if s == nil || s.Voided {
		fail(w, 409, "Sale not found or already voided")
		return
	}
	for _, l := range s.Lines {
		if p := findProduct(l.ProductID); p != nil {
			p.Stock += l.Qty
		}
	}
	s.Voided = true
	commit(w, 200, map[string]bool{"ok": true})
}

// role works out who is calling. With no PINs set everyone is an admin. POS_PIN alone gives full
// access. With POS_ADMIN_PIN also set, POS_PIN becomes the cashier PIN (register and sales only).
func role(r *http.Request) string {
	admin, cashier, pin := os.Getenv("POS_ADMIN_PIN"), os.Getenv("POS_PIN"), []byte(r.Header.Get("X-Pin"))
	eq := func(want string) bool { return want != "" && subtle.ConstantTimeCompare(pin, []byte(want)) == 1 }
	switch {
	case admin == "" && cashier == "":
		return "admin"
	case eq(admin):
		return "admin"
	case eq(cashier):
		if admin == "" {
			return "admin"
		}
		return "cashier"
	}
	return ""
}

func needsAdmin(r *http.Request) bool {
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/api/products"):
		return r.Method != "GET"
	case strings.HasSuffix(p, "/void"), p == "/api/report", p == "/api/export", p == "/api/settings":
		return true
	}
	return false
}

func auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			switch role(r) {
			case "":
				fail(w, 401, "Enter the shop PIN")
				return
			case "cashier":
				if needsAdmin(r) {
					fail(w, 403, "Manager PIN required")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func me(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	name := st.Settings.ShopName
	if name == "" {
		name = "Counter"
	}
	respond(w, 200, map[string]any{"role": role(r), "shopName": name, "taxPercent": st.Settings.TaxPercent})
}

func putSettings(w http.ResponseWriter, r *http.Request) {
	var n Settings
	if json.NewDecoder(r.Body).Decode(&n) != nil || n.TaxPercent < 0 || n.TaxPercent > 100 {
		fail(w, 400, "Tax must be between 0 and 100")
		return
	}
	if strings.TrimSpace(n.ShopName) == "" {
		n.ShopName = "Counter"
	}
	mu.Lock()
	defer mu.Unlock()
	st.Settings = n
	commit(w, 200, n)
}

type TopItem struct {
	Name  string `json:"name"`
	Qty   int    `json:"qty"`
	Cents int    `json:"cents"`
}

type Report struct {
	Sales         int            `json:"sales"`
	SubtotalCents int            `json:"subtotalCents"`
	DiscountCents int            `json:"discountCents"`
	TaxCents      int            `json:"taxCents"`
	TotalCents    int            `json:"totalCents"`
	ByPayment     map[string]int `json:"byPayment"`
	Top           []TopItem      `json:"top"`
}

func inRange(s Sale, from, to string) bool {
	d := s.CreatedAt[:10]
	return (from == "" || d >= from) && (to == "" || d <= to)
}

func report(w http.ResponseWriter, r *http.Request) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	mu.Lock()
	defer mu.Unlock()
	rep, items := Report{ByPayment: map[string]int{}, Top: []TopItem{}}, map[string]*TopItem{}
	for _, s := range st.Sales {
		if s.Voided || !inRange(s, from, to) {
			continue
		}
		sub := s.SubtotalCents
		if sub == 0 { // sales saved by the earlier version had no breakdown
			sub = s.TotalCents
		}
		pay := s.Payment
		if pay == "" {
			pay = "cash"
		}
		rep.Sales++
		rep.SubtotalCents += sub
		rep.DiscountCents += s.DiscountCents
		rep.TaxCents += s.TaxCents
		rep.TotalCents += s.TotalCents
		rep.ByPayment[pay] += s.TotalCents
		for _, l := range s.Lines {
			t := items[l.Name]
			if t == nil {
				t = &TopItem{Name: l.Name}
				items[l.Name] = t
			}
			t.Qty += l.Qty
			t.Cents += l.Qty * l.PriceCents
		}
	}
	for _, t := range items {
		rep.Top = append(rep.Top, *t)
	}
	sort.Slice(rep.Top, func(i, j int) bool { return rep.Top[i].Cents > rep.Top[j].Cents })
	if len(rep.Top) > 5 {
		rep.Top = rep.Top[:5]
	}
	respond(w, 200, rep)
}

func export(w http.ResponseWriter, r *http.Request) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	mu.Lock()
	defer mu.Unlock()
	w.Header().Set("Content-Type", "text/csv")
	c := csv.NewWriter(w)
	c.Write([]string{"id", "time", "payment", "items", "subtotal", "discount", "tax", "total", "status"})
	m := func(v int) string { return fmt.Sprintf("%.2f", float64(v)/100) }
	for _, s := range st.Sales {
		if !inRange(s, from, to) {
			continue
		}
		status := "ok"
		if s.Voided {
			status = "voided"
		}
		c.Write([]string{strconv.FormatInt(s.ID, 10), s.CreatedAt, s.Payment, strconv.Itoa(s.Items),
			m(s.SubtotalCents), m(s.DiscountCents), m(s.TaxCents), m(s.TotalCents), status})
	}
	c.Flush()
}

func main() {
	load()
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/products", listProducts)
	mux.HandleFunc("POST /api/products", saveProduct)
	mux.HandleFunc("PUT /api/products/{id}", saveProduct)
	mux.HandleFunc("DELETE /api/products/{id}", deleteProduct)
	mux.HandleFunc("POST /api/products/{id}/adjust", adjustStock)
	mux.HandleFunc("POST /api/sales", createSale)
	mux.HandleFunc("GET /api/sales", listSales)
	mux.HandleFunc("GET /api/sales/{id}", saleDetail)
	mux.HandleFunc("POST /api/sales/{id}/void", voidSale)
	mux.HandleFunc("GET /api/me", me)
	mux.HandleFunc("PUT /api/settings", putSettings)
	mux.HandleFunc("GET /api/report", report)
	mux.HandleFunc("GET /api/export", export)
	mux.Handle("/", http.FileServer(http.FS(web)))
	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	log.Println("Counter is running. Open http://localhost" + addr)
	log.Fatal(http.ListenAndServe(addr, auth(mux)))
}
