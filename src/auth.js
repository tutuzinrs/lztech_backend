import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './db.js'

const SECRET_FILE = path.join(DATA_DIR, '.secret')

function loadSecret() {
  if (process.env.LZTECH_SECRET) return process.env.LZTECH_SECRET
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    const secret = crypto.randomBytes(32).toString('hex')
    try {
      fs.writeFileSync(SECRET_FILE, secret, 'utf8')
    } catch {
      // Ignora erro se o filesystem for somente leitura (ex: Vercel Functions)
    }
    return secret
  }
}

const SECRET = loadSecret()
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

export function signToken(subject = 'admin') {
  const payload = { sub: subject, exp: Date.now() + MAX_AGE }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const payload = verifyToken(token)
  if (!payload) {
    return res.status(401).json({ error: 'Não autorizado. Faça login novamente.' })
  }
  req.user = payload
  next()
}
