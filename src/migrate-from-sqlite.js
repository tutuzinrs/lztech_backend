import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { initDb, query, DATA_DIR } from './db.js'

async function migrate() {
  console.log('--- Iniciando migração de SQLite para Neon PostgreSQL ---')

  const sqlitePath = path.join(DATA_DIR, 'lztech.db')
  if (!fs.existsSync(sqlitePath)) {
    console.log(`Banco SQLite não encontrado em ${sqlitePath}. Nada a migrar.`)
    return
  }

  console.log(`Lendo banco SQLite de: ${sqlitePath}`)
  const sqlite = new DatabaseSync(sqlitePath)

  // Inicializa o schema no Neon PostgreSQL
  console.log('Garantindo criação de tabelas no PostgreSQL...')
  await initDb()

  // 1. Migrar configurações (settings)
  try {
    const settingsRows = sqlite.prepare('SELECT * FROM settings').all()
    console.log(`Encontradas ${settingsRows.length} configurações no SQLite.`)
    for (const row of settingsRows) {
      await query(
        `INSERT INTO settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [row.key, row.value]
      )
    }
    console.log('✓ Configurações migradas com sucesso.')
  } catch (err) {
    console.warn('Aviso ao migrar configurações:', err.message)
  }

  // 2. Migrar produtos
  try {
    const productRows = sqlite.prepare('SELECT * FROM products').all()
    console.log(`Encontrados ${productRows.length} produtos no SQLite.`)
    for (const p of productRows) {
      await query(
        `INSERT INTO products (id, name, category, price, old_price, description, stock, active, featured, badge, image, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           price = EXCLUDED.price,
           old_price = EXCLUDED.old_price,
           description = EXCLUDED.description,
           stock = EXCLUDED.stock,
           active = EXCLUDED.active,
           featured = EXCLUDED.featured,
           badge = EXCLUDED.badge,
           image = EXCLUDED.image,
           updated_at = EXCLUDED.updated_at`,
        [
          p.id,
          p.name,
          p.category || 'acessorios',
          Number(p.price) || 0,
          p.old_price != null ? Number(p.old_price) : null,
          p.description || '',
          Number(p.stock) || 0,
          Number(p.active) || 0,
          Number(p.featured) || 0,
          p.badge || '',
          p.image || '',
          p.created_at,
          p.updated_at,
        ]
      )
    }
    console.log('✓ Produtos migrados com sucesso.')
  } catch (err) {
    console.warn('Aviso ao migrar produtos:', err.message)
  }

  // 3. Migrar banners
  try {
    const bannerRows = sqlite.prepare('SELECT * FROM banners').all()
    console.log(`Encontrados ${bannerRows.length} banners no SQLite.`)
    for (const b of bannerRows) {
      await query(
        `INSERT INTO banners (id, title, subtitle, image, link, position, format, focus_x, focus_y, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           image = EXCLUDED.image,
           link = EXCLUDED.link,
           position = EXCLUDED.position,
           format = EXCLUDED.format,
           focus_x = EXCLUDED.focus_x,
           focus_y = EXCLUDED.focus_y,
           active = EXCLUDED.active`,
        [
          b.id,
          b.title || '',
          b.subtitle || '',
          b.image || '',
          b.link || '',
          Number(b.position) || 0,
          b.format || 'banner',
          Number(b.focus_x ?? 0.5),
          Number(b.focus_y ?? 0.5),
          Number(b.active) || 0,
          b.created_at,
        ]
      )
    }
    console.log('✓ Banners migrados com sucesso.')
  } catch (err) {
    console.warn('Aviso ao migrar banners:', err.message)
  }

  // 4. Migrar pedidos
  try {
    const orderRows = sqlite.prepare('SELECT * FROM orders').all()
    console.log(`Encontrados ${orderRows.length} pedidos no SQLite.`)
    for (const o of orderRows) {
      await query(
        `INSERT INTO orders (id, number, status, customer, items, subtotal, shipping, total, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          o.id,
          o.number,
          o.status,
          o.customer,
          o.items,
          Number(o.subtotal) || 0,
          Number(o.shipping) || 0,
          Number(o.total) || 0,
          o.created_at,
          o.updated_at,
        ]
      )
    }
    console.log('✓ Pedidos migrados com sucesso.')
  } catch (err) {
    console.warn('Aviso ao migrar pedidos:', err.message)
  }

  // 5. Migrar imagens locais em uploads/ para o Neon PostgreSQL
  try {
    const uploadsPath = path.resolve(DATA_DIR, '..', 'uploads')
    if (fs.existsSync(uploadsPath)) {
      const files = fs.readdirSync(uploadsPath)
      console.log(`Encontrados ${files.length} arquivos na pasta uploads/ local.`)
      let count = 0
      for (const file of files) {
        const fullPath = path.join(uploadsPath, file)
        const stat = fs.statSync(fullPath)
        if (stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024) {
          const ext = path.extname(file).toLowerCase()
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
          const base64 = fs.readFileSync(fullPath).toString('base64')
          await query(
            `INSERT INTO uploads (id, filename, mime_type, data, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (filename) DO NOTHING`,
            [`upl_${file}`, file, mime, base64, new Date().toISOString()]
          )
          count++
        }
      }
      console.log(`✓ ${count} imagens migradas para a tabela uploads do PostgreSQL.`)
    }
  } catch (err) {
    console.warn('Aviso ao migrar uploads:', err.message)
  }

  console.log('--- Migração concluída com sucesso! ---')
  console.log('O banco SQLite original em data/lztech.db continua intacto.')
}

migrate().catch((err) => {
  console.error('Erro durante a migração:', err)
  process.exit(1)
})
