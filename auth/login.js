// coc_backend/auth/login.js
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')

const pool = require('../db')
const audit = require('../utils/audit')
const cookieCommon = require('../config/cookies')

module.exports = async function login(req, res) {
  const { email = '', password = '', totp = null, remember = false } = req.body

  // IP/UA reales detrás de Nginx (acordate: app.set('trust proxy', 1) en server.js)
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress
  const ua = req.headers['user-agent']

  // 1) buscar usuario activo
  const normEmail = email.toLowerCase().trim()
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE email = ? AND is_active = 1',
    [normEmail]
  )
  const u = rows[0]
  if (!u) {
    await audit({ conn: pool, action: 'LOGIN_FAILED', meta: { email: normEmail, ip, ua, reason: 'INVALID_USER' } })
    return res.status(401).json({ message: 'Credenciales inválidas' })
  }

  // 2) bloqueo temporal por intentos fallidos
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    await audit({ conn: pool, userId: u.id, action: 'LOGIN_LOCKED', entityId: u.id, meta: { email: normEmail, ip, ua } })
    return res.status(401).json({ message: 'Cuenta bloqueada temporalmente' })
  }

  // 3) validar password
  const ok = await bcrypt.compare(password, u.password_hash)
  if (!ok) {
    const failed = (u.failed_count || 0) + 1
    const lock = failed >= 5 ? new Date(Date.now() + 5 * 60 * 1000) : null
    await pool.execute('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?', [failed, lock, u.id])
    await audit({
      conn: pool, userId: u.id, action: 'LOGIN_FAILED', entityId: u.id,
      meta: { email: normEmail, ip, ua, reason: 'INVALID_PASSWORD', failed }
    })
    return res.status(401).json({ message: 'Credenciales inválidas' })
  }

  // 4) (opcional) 2FA TOTP
  if (u.totp_enabled) {
    if (!totp) {
      await audit({ conn: pool, userId: u.id, action: 'TOTP_REQUIRED', entityId: u.id, meta: { email: normEmail, ip, ua } })
      return res.status(401).json({ reason: 'TOTP_REQUIRED', message: 'Se requiere 2FA' })
    }
    // TODO: validar TOTP con speakeasy usando tu u.totp_secret (cifrado)
  }

  // 5) resetear contadores
  await pool.execute('UPDATE users SET failed_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?', [u.id])

  // 6) emitir tokens + persistir refresh (hasheado)
  const jti = uuidv4()
  const access = jwt.sign(
    { sub: u.id, email: u.email, role_id: u.role_id },
    process.env.JWT_SECRET,
    { expiresIn: `${Number(process.env.ACCESS_TTL_MIN) || 15}m` }
  )
  const refresh = jwt.sign(
    { sub: u.id, jti },
    process.env.REFRESH_SECRET,
    { expiresIn: `${Number(process.env.REFRESH_TTL_DAYS) || 7}d` }
  )

  const now = new Date()
  const exp = new Date(now.getTime() + (Number(process.env.REFRESH_TTL_DAYS) || 7) * 864e5)
  await pool.execute(
    'INSERT INTO refresh_tokens (user_id, jti, token_hash, issued_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)',
    [u.id, jti, crypto.createHash('sha256').update(refresh).digest('hex'), now, exp, ip, ua]
  )

  // 7) setear cookies seguras cross-site
res.cookie('jwt', access, { ...cookieCommon, maxAge: (Number(process.env.ACCESS_TTL_MIN) || 15) * 60 * 1000 })


  await audit({ conn: pool, userId: u.id, action: 'LOGIN_SUCCESS', entityId: u.id, meta: { ip, ua } })
  return res.json({ ok: true })
}