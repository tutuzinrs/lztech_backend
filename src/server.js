import express from 'express'
import cors from 'cors'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  db,
  ROOT,
  UPLOADS_DIR,
  getSettings,
  saveSettings,
  publicSettings,
  mapProduct,
  mapBanner,
  mapOrder,
  newId,
  now,
} from './db.js'
import { signToken, verifyToken, requireAuth } from './auth.js'
import { quote, shippingConfig } from './geo.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

app.use(cors({ origin: true }))
app.use(express.json({ limit: '2mb' }))
app.use('/uploads', express.static(UPLOADS_DIR))

const api = express.Router()

// ---------------- Auth ----------------
api.post('/auth/login', (req, res) => {
  const { password } = req.body || {}
  const settings = getSettings()
  if (!password || password !== settings.adminPassword) {
    return res.status(401).json({ error: 'Senha incorreta.' })
  }
  res.json({ token: signToken('admin') })
})

api.get('/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true })
})

api.post('/auth/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {}
  const settings = getSettings()
  if (current !== settings.adminPassword) {
    return res.status(400).json({ error: 'Senha atual incorreta.' })
  }
  if (!next || String(next).length < 4) {
    return res.status(400).json({ error: 'A nova senha precisa ter ao menos 4 caracteres.' })
  }
  saveSettings({ ...settings, adminPassword: String(next) })
  res.json({ ok: true })
})

// ---------------- Products ----------------
api.get('/products', (req, res) => {
  const { active, category, q, featured } = req.query
  let sql = 'SELECT * FROM products WHERE 1 = 1'
  const params = []
  if (active === 'true') sql += ' AND active = 1'
  if (featured === 'true') sql += ' AND featured = 1'
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }
  if (q) {
    sql += ' AND (name LIKE ? OR description LIKE ?)'
    params.push(`%${q}%`, `%${q}%`)
  }
  sql += ' ORDER BY featured DESC, name ASC'
  const rows = db.prepare(sql).all(...params)
  res.json(rows.map(mapProduct))
})

api.get('/products/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Produto não encontrado.' })
  res.json(mapProduct(row))
})

function productPayload(body) {
  const price = Number(body.price) || 0
  const oldPrice = body.oldPrice === '' || body.oldPrice == null ? null : Number(body.oldPrice)
  return {
    name: String(body.name || '').trim(),
    category: body.category || 'acessorios',
    price,
    oldPrice: oldPrice && oldPrice > 0 ? oldPrice : null,
    description: String(body.description || '').trim(),
    stock: Number(body.stock) || 0,
    active: body.active === false ? 0 : 1,
    featured: body.featured ? 1 : 0,
    badge: String(body.badge || '').trim(),
    image: String(body.image || '').trim(),
  }
}

api.post('/products', requireAuth, (req, res) => {
  const data = productPayload(req.body)
  if (!data.name) return res.status(400).json({ error: 'Informe o nome do produto.' })
  if (data.price <= 0) return res.status(400).json({ error: 'Informe um preço válido.' })
  const id = newId('p')
  const ts = now()
  db.prepare(
    `INSERT INTO products (id, name, category, price, old_price, description, stock, active, featured, badge, image, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, data.name, data.category, data.price, data.oldPrice, data.description,
    data.stock, data.active, data.featured, data.badge, data.image, ts, ts
  )
  res.status(201).json(mapProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)))
})

api.put('/products/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado.' })
  const data = productPayload(req.body)
  if (!data.name) return res.status(400).json({ error: 'Informe o nome do produto.' })
  if (data.price <= 0) return res.status(400).json({ error: 'Informe um preço válido.' })
  db.prepare(
    `UPDATE products SET name=?, category=?, price=?, old_price=?, description=?, stock=?, active=?, featured=?, badge=?, image=?, updated_at=?
     WHERE id=?`
  ).run(
    data.name, data.category, data.price, data.oldPrice, data.description,
    data.stock, data.active, data.featured, data.badge, data.image, now(), req.params.id
  )
  res.json(mapProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)))
})

api.patch('/products/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado.' })
  const fields = []
  const params = []
  if (typeof req.body.active === 'boolean') {
    fields.push('active = ?')
    params.push(req.body.active ? 1 : 0)
  }
  if (typeof req.body.featured === 'boolean') {
    fields.push('featured = ?')
    params.push(req.body.featured ? 1 : 0)
  }
  if (req.body.stock != null) {
    fields.push('stock = ?')
    params.push(Number(req.body.stock) || 0)
  }
  if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' })
  fields.push('updated_at = ?')
  params.push(now(), req.params.id)
  db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  res.json(mapProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)))
})

api.delete('/products/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Produto não encontrado.' })
  res.json({ ok: true })
})

// ---------------- Banners ----------------
api.get('/banners', (req, res) => {
  let sql = 'SELECT * FROM banners'
  if (req.query.active === 'true') sql += ' WHERE active = 1'
  sql += ' ORDER BY position ASC, created_at ASC'
  res.json(db.prepare(sql).all().map(mapBanner))
})

function clampFocus(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

function bannerPayload(body) {
  return {
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    image: String(body.image || '').trim(),
    link: String(body.link || '').trim(),
    position: Number(body.position) || 0,
    format: body.format === 'quadrado' ? 'quadrado' : 'banner',
    focusX: clampFocus(body.focusX),
    focusY: clampFocus(body.focusY),
    active: body.active === false ? 0 : 1,
  }
}

api.post('/banners', requireAuth, (req, res) => {
  const data = bannerPayload(req.body)
  if (!data.title) return res.status(400).json({ error: 'Informe um título para o banner.' })
  const id = newId('ban')
  db.prepare(
    `INSERT INTO banners (id, title, subtitle, image, link, position, format, focus_x, focus_y, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, data.title, data.subtitle, data.image, data.link, data.position, data.format, data.focusX, data.focusY, data.active, now())
  res.status(201).json(mapBanner(db.prepare('SELECT * FROM banners WHERE id = ?').get(id)))
})

api.put('/banners/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM banners WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Banner não encontrado.' })
  const data = bannerPayload(req.body)
  if (!data.title) return res.status(400).json({ error: 'Informe um título para o banner.' })
  db.prepare(
    `UPDATE banners SET title=?, subtitle=?, image=?, link=?, position=?, format=?, focus_x=?, focus_y=?, active=? WHERE id=?`
  ).run(data.title, data.subtitle, data.image, data.link, data.position, data.format, data.focusX, data.focusY, data.active, req.params.id)
  res.json(mapBanner(db.prepare('SELECT * FROM banners WHERE id = ?').get(req.params.id)))
})

api.delete('/banners/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM banners WHERE id = ?').run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Banner não encontrado.' })
  res.json({ ok: true })
})

// ---------------- Frete por raio ----------------
api.get('/geo/quote', async (req, res) => {
  const address = String(req.query.address || '').trim()
  const city = String(req.query.city || '').trim()
  const settings = getSettings()
  if (!String(settings.address || '').trim()) {
    return res.status(400).json({ error: 'A loja ainda não configurou o endereço de origem.' })
  }
  if (!address) {
    return res.status(400).json({ error: 'Informe o endereço para calcular o frete.' })
  }
  try {
    const result = await quote(address, city, settings)
    if (!result.ok) {
      return res.status(422).json({ error: 'Não foi possível localizar o endereço. Confira os dados.' })
    }
    res.json({
      distanceKm: Number(result.distanceKm.toFixed(2)),
      fee: result.fee,
      free: result.fee === 0,
      freeKm: result.config.freeKm,
      baseFee: result.config.baseFee,
      perKm: result.config.perKm,
    })
  } catch {
    res.status(500).json({ error: 'Falha ao calcular o frete.' })
  }
})

// ---------------- Orders ----------------
api.post('/orders', async (req, res) => {
  const { customer = {}, items = [] } = req.body || {}
  if (!customer.name || String(customer.name).trim().length < 2) {
    return res.status(400).json({ error: 'Informe o nome do cliente.' })
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'O carrinho está vazio.' })
  }

  const priced = []
  for (const item of items) {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id)
    if (!row) continue
    const qty = Math.max(1, Number(item.qty) || 1)
    priced.push({ id: row.id, name: row.name, price: row.price, qty })
  }
  if (priced.length === 0) {
    return res.status(400).json({ error: 'Nenhum produto válido no pedido.' })
  }

  const settings = getSettings()
  const subtotal = priced.reduce((s, i) => s + i.price * i.qty, 0)

  let shipping = 0
  let distanceKm = null
  if (customer.delivery === 'entrega') {
    const result = await quote(customer.address, customer.city, settings)
    if (result.ok) {
      shipping = result.fee
      distanceKm = Number(result.distanceKm.toFixed(2))
    } else {
      shipping = shippingConfig(settings).baseFee
    }
  }

  const orderCustomer = distanceKm == null ? customer : { ...customer, distanceKm }
  const seq = settings.orderSeq || 1
  const id = newId('ord')
  const ts = now()

  db.prepare(
    `INSERT INTO orders (id, number, status, customer, items, subtotal, shipping, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `LT-${String(seq).padStart(4, '0')}`,
    'pendente',
    JSON.stringify(orderCustomer),
    JSON.stringify(priced),
    subtotal,
    shipping,
    subtotal + shipping,
    ts,
    ts
  )

  saveSettings({ ...settings, orderSeq: seq + 1 })

  res.status(201).json(mapOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)))
})

api.get('/orders', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all()
  res.json(rows.map(mapOrder))
})

api.patch('/orders/:id', requireAuth, (req, res) => {
  const allowed = ['pendente', 'separacao', 'enviado', 'entregue', 'cancelado']
  const { status } = req.body || {}
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido.' })
  const result = db
    .prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Pedido não encontrado.' })
  res.json(mapOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)))
})

api.delete('/orders/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Pedido não encontrado.' })
  res.json({ ok: true })
})

// ---------------- Settings ----------------
api.get('/settings', (req, res) => {
  res.json(publicSettings())
})

api.get('/settings/full', requireAuth, (req, res) => {
  res.json(getSettings())
})

api.put('/settings', requireAuth, (req, res) => {
  const current = getSettings()
  const body = req.body || {}
  const next = {
    ...current,
    storeName: String(body.storeName ?? current.storeName).trim(),
    tagline: String(body.tagline ?? current.tagline),
    whatsapp: String(body.whatsapp ?? current.whatsapp).replace(/\D/g, ''),
    address: String(body.address ?? current.address),
    city: String(body.city ?? current.city),
    instagram: String(body.instagram ?? current.instagram),
    hours: String(body.hours ?? current.hours),
    deliveryFee: Number(body.deliveryFee ?? current.deliveryFee) || 0,
    deliveryFreeKm: Math.max(0, Number(body.deliveryFreeKm ?? current.deliveryFreeKm ?? 5) || 0),
    deliveryBaseFee: Math.max(0, Number(body.deliveryBaseFee ?? current.deliveryBaseFee ?? 5) || 0),
    deliveryPerKm: Math.max(0, Number(body.deliveryPerKm ?? current.deliveryPerKm ?? 2) || 0),
  }
  if (!next.storeName) return res.status(400).json({ error: 'Informe o nome da loja.' })
  saveSettings(next)
  res.json(publicSettings())
})

// ---------------- Upload ----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase()
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true)
    else cb(new Error('Envie apenas arquivos de imagem.'))
  },
})

api.post('/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' })
    res.status(201).json({ url: `/uploads/${req.file.filename}` })
  })
})

// ---------------- Export / Import ----------------
api.get('/export', requireAuth, (req, res) => {
  res.json({
    settings: getSettings(),
    products: db.prepare('SELECT * FROM products').all().map(mapProduct),
    banners: db.prepare('SELECT * FROM banners').all().map(mapBanner),
    orders: db.prepare('SELECT * FROM orders').all().map(mapOrder),
    exportedAt: now(),
  })
})

api.post('/import', requireAuth, (req, res) => {
  const { products, banners, orders, settings } = req.body || {}
  try {
    if (Array.isArray(products)) {
      db.prepare('DELETE FROM products').run()
      for (const p of products) {
        db.prepare(
          `INSERT INTO products (id, name, category, price, old_price, description, stock, active, featured, badge, image, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id || newId('p'), p.name, p.category || 'acessorios', Number(p.price) || 0,
          p.oldPrice ?? null, p.description || '', Number(p.stock) || 0,
          p.active ? 1 : 0, p.featured ? 1 : 0, p.badge || '', p.image || '', now(), now()
        )
      }
    }
    if (Array.isArray(banners)) {
      db.prepare('DELETE FROM banners').run()
      for (const b of banners) {
        db.prepare(
          `INSERT INTO banners (id, title, subtitle, image, link, position, format, focus_x, focus_y, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          b.id || newId('ban'),
          b.title || '',
          b.subtitle || '',
          b.image || '',
          b.link || '',
          Number(b.position) || 0,
          b.format === 'quadrado' ? 'quadrado' : 'banner',
          clampFocus(b.focusX),
          clampFocus(b.focusY),
          b.active === false ? 0 : 1,
          now()
        )
      }
    }
    if (Array.isArray(orders)) {
      db.prepare('DELETE FROM orders').run()
      for (const o of orders) {
        db.prepare(
          `INSERT INTO orders (id, number, status, customer, items, subtotal, shipping, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          o.id || newId('ord'), o.number || 'LT-0000', o.status || 'pendente',
          JSON.stringify(o.customer || {}), JSON.stringify(o.items || []),
          Number(o.subtotal) || 0, Number(o.shipping) || 0, Number(o.total) || 0,
          o.date || now(), now()
        )
      }
    }
    if (settings) saveSettings({ ...getSettings(), ...settings })
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ error: 'Falha ao importar: ' + error.message })
  }
})

api.get('/health', (req, res) => {
  res.json({ ok: true, service: 'lztech-api', time: now() })
})

api.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }))

app.use('/api', api)

// ---------------- Static (produção) ----------------
const storeDist = path.resolve(ROOT, '..', 'lztech', 'dist')
const adminDist = path.resolve(ROOT, '..', 'lztech_admin', 'dist')

if (fs.existsSync(adminDist)) {
  app.use('/admin', express.static(adminDist))
  app.get(['/admin', '/admin/*'], (req, res) => res.sendFile(path.join(adminDist, 'index.html')))
}

if (fs.existsSync(storeDist)) {
  app.use(express.static(storeDist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next()
    res.sendFile(path.join(storeDist, 'index.html'))
  })
}

app.use((err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).json({ error: err.message || 'Erro interno.' })
})

app.listen(PORT, () => {
  console.log(`LZ Tech API rodando em http://localhost:${PORT}`)
  if (fs.existsSync(storeDist)) console.log(`Loja disponível em http://localhost:${PORT}/`)
  if (fs.existsSync(adminDist)) console.log(`Admin disponível em http://localhost:${PORT}/admin`)
})
