import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const UPLOADS_DIR = path.join(ROOT, 'uploads')

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOADS_DIR, { recursive: true })

const DB_PATH = path.join(DATA_DIR, 'lztech.db')
export const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'acessorios',
    price REAL NOT NULL DEFAULT 0,
    old_price REAL,
    description TEXT DEFAULT '',
    stock INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    featured INTEGER NOT NULL DEFAULT 0,
    badge TEXT DEFAULT '',
    image TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS banners (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    subtitle TEXT DEFAULT '',
    image TEXT DEFAULT '',
    link TEXT DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT 'banner',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    customer TEXT NOT NULL,
    items TEXT NOT NULL,
    subtotal REAL NOT NULL DEFAULT 0,
    shipping REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

export const now = () => new Date().toISOString()
export const newId = (prefix = 'id') => `${prefix}_${crypto.randomUUID().slice(0, 8)}`

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('banners', 'format', "TEXT NOT NULL DEFAULT 'banner'")
ensureColumn('banners', 'focus_x', 'REAL NOT NULL DEFAULT 0.5')
ensureColumn('banners', 'focus_y', 'REAL NOT NULL DEFAULT 0.5')
db.exec("UPDATE banners SET format = 'banner' WHERE format = 'retangular'")

export function mapProduct(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price: row.price,
    oldPrice: row.old_price,
    description: row.description || '',
    stock: row.stock,
    active: !!row.active,
    featured: !!row.featured,
    badge: row.badge || '',
    image: row.image || '',
  }
}

export function mapBanner(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title || '',
    subtitle: row.subtitle || '',
    image: row.image || '',
    link: row.link || '',
    position: row.position,
    format: row.format === 'quadrado' ? 'quadrado' : 'banner',
    focusX: Number.isFinite(Number(row.focus_x)) ? Math.min(1, Math.max(0, Number(row.focus_x))) : 0.5,
    focusY: Number.isFinite(Number(row.focus_y)) ? Math.min(1, Math.max(0, Number(row.focus_y))) : 0.5,
    active: !!row.active,
  }
}

export function mapOrder(row) {
  if (!row) return null
  let customer = {}
  let items = []
  try {
    customer = JSON.parse(row.customer)
  } catch {
    customer = {}
  }
  try {
    items = JSON.parse(row.items)
  } catch {
    items = []
  }
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customer,
    items,
    subtotal: row.subtotal,
    shipping: row.shipping,
    total: row.total,
    date: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------- Settings ----------------
export function getSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('main')
  const defaults = defaultSettings()
  if (row) {
    try {
      return { ...defaults, ...JSON.parse(row.value) }
    } catch {
      /* ignore */
    }
  }
  saveSettings(defaults)
  return defaults
}

export function saveSettings(settings) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('main', JSON.stringify(settings))
  return settings
}

export function publicSettings() {
  const { adminPassword, ...rest } = getSettings()
  return rest
}

function defaultSettings() {
  return {
    storeName: 'LZ Tech',
    tagline: 'Acessórios e peças para o seu celular',
    whatsapp: '5521988550673',
    address: 'Rua Exemplo, 123 - Centro',
    city: 'Sua Cidade - UF',
    instagram: '@lztech_oficial',
    hours: 'Seg a Sex, 9h às 18h • Sáb, 9h às 13h',
    deliveryFee: 12,
    deliveryFreeKm: 5,
    deliveryBaseFee: 5,
    deliveryPerKm: 2,
    adminPassword: 'admin123',
    orderSeq: 1,
  }
}

