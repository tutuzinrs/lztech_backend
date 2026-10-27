import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const UPLOADS_DIR = path.join(ROOT, 'uploads')

// Tenta criar diretórios apenas se permitido (em desenvolvimento local)
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
} catch {
  // Ignora erros em ambientes somente leitura como Vercel Functions
}

export const now = () => new Date().toISOString()
export const newId = (prefix = 'id') => `${prefix}_${crypto.randomUUID().slice(0, 8)}`

function getConnectionString() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.NEON_DATABASE_URL ||
    ''
  )
}

let _sql = null
export function getClient() {
  if (_sql) return _sql
  const conn = getConnectionString()
  if (!conn) {
    throw new Error(
      'Nenhuma string de conexão do Neon PostgreSQL encontrada. Configure POSTGRES_URL ou DATABASE_URL.'
    )
  }
  _sql = neon(conn, { fullResults: true })
  return _sql
}

// Converte placeholders do estilo SQLite (?) para PostgreSQL ($1, $2, etc.) se necessário
export function formatSql(text) {
  let index = 1
  return text.replace(/\?/g, () => `$${index++}`)
}

let _isInitialized = false
let _initPromise = null

export async function initDb() {
  if (_isInitialized) return
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    try {
      const client = getClient()

      // Cada instrução é executada individualmente para total compatibilidade
      // com o protocolo de prepared statements do PostgreSQL e driver Neon.
      const statements = [
        // 1. Tabela de produtos
        `CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'acessorios',
          price DOUBLE PRECISION NOT NULL DEFAULT 0,
          old_price DOUBLE PRECISION,
          description TEXT DEFAULT '',
          stock INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          featured INTEGER NOT NULL DEFAULT 0,
          badge TEXT DEFAULT '',
          image TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,

        // 2. Tabela de banners
        `CREATE TABLE IF NOT EXISTS banners (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT '',
          subtitle TEXT DEFAULT '',
          image TEXT DEFAULT '',
          link TEXT DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0,
          format TEXT NOT NULL DEFAULT 'banner',
          focus_x DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          focus_y DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        )`,

        // 3. Tabela de pedidos
        `CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          number TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pendente',
          customer TEXT NOT NULL,
          items TEXT NOT NULL,
          subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
          shipping DOUBLE PRECISION NOT NULL DEFAULT 0,
          total DOUBLE PRECISION NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,

        // 4. Tabela de configurações da loja
        `CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`,

        // 5. Colunas adicionais garantidas (compatibilidade com schemas legados)
        `ALTER TABLE banners ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'banner'`,
        `ALTER TABLE banners ADD COLUMN IF NOT EXISTS focus_x DOUBLE PRECISION NOT NULL DEFAULT 0.5`,
        `ALTER TABLE banners ADD COLUMN IF NOT EXISTS focus_y DOUBLE PRECISION NOT NULL DEFAULT 0.5`,

        // 6. Índices para otimização de consultas comuns
        `CREATE INDEX IF NOT EXISTS idx_products_category ON products (category)`,
        `CREATE INDEX IF NOT EXISTS idx_products_active ON products (active)`,
        `CREATE INDEX IF NOT EXISTS idx_banners_position ON banners (position ASC)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC)`
      ]

      for (const statement of statements) {
        await client.query(statement)
      }

      _isInitialized = true
    } catch (err) {
      _initPromise = null
      throw err
    }
  })()

  return _initPromise
}

export async function query(sqlText, params = []) {
  await initDb()
  const client = getClient()
  const formatted = formatSql(sqlText)
  const result = await client.query(formatted, params, { fullResults: true })
  const rows = result.rows || []
  const count = result.rowCount ?? rows.length
  return {
    rows,
    rowCount: count,
    changes: count,
  }
}

export async function queryOne(sqlText, params = []) {
  const res = await query(sqlText, params)
  return res.rows[0] || null
}

export async function queryAll(sqlText, params = []) {
  const res = await query(sqlText, params)
  return res.rows
}

export function mapProduct(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price: Number(row.price) || 0,
    oldPrice: row.old_price == null ? null : Number(row.old_price),
    description: row.description || '',
    stock: Number(row.stock) || 0,
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
    position: Number(row.position) || 0,
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
    subtotal: Number(row.subtotal) || 0,
    shipping: Number(row.shipping) || 0,
    total: Number(row.total) || 0,
    date: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------- Settings ----------------
export async function getSettings() {
  const row = await queryOne('SELECT value FROM settings WHERE key = $1', ['main'])
  const defaults = defaultSettings()
  if (row?.value) {
    try {
      return { ...defaults, ...JSON.parse(row.value) }
    } catch {
      /* ignore */
    }
  }
  await saveSettings(defaults)
  return defaults
}

export async function saveSettings(settings) {
  await query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['main', JSON.stringify(settings)]
  )
  return settings
}

export async function publicSettings() {
  const { adminPassword, ...rest } = await getSettings()
  return rest
}

function defaultSettings() {
  return {
    storeName: 'LZ Tech',
    tagline: 'Acessórios para o seu celular',
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
