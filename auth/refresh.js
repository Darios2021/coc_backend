// coc_backend/auth/refresh.js
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')

const pool = require('../db')
const audit = require('../utils/audit')
const cookieCommon = require('../config/cookies')

module.exports = async function refreshHandler(req, res) {
  const token = req.cookies?.coc_refresh
  if (!token) return res.sendStatus(401)

  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress
  const ua = req.headers['user-agent']

  try {
    const payload = jwt.verify(token, process.env.REFRESH_SECRET)

    // Validar contra DB
    const [rtRows] = await pool.execute('SELECT * FROM refresh_tokens WHERE jti = ? LIMIT 1', [payload.jti])
    const rt = rtRows[0]
    if (!rt || rt.revoked_at) return res.sendStatus(401)
    if (rt.token_hash !== crypto.createHash('sha256').update(token).digest('hex')) return res.sendStatus(401)
    if (new Date(rt.expires_at) < new Date()) return res.sendStatus(401)
    if (rt.user_id !== payload.sub) return res.sendStatus(401)

    // Rotación segura: revocar el usado
    await pool.execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [rt.id])

    // Releer usuario activo
    const [uRows] = await pool.execute(
      'SELECT id, email, role_id FROM users WHERE id = ? AND is_active = 1',
      [payload.sub]
    )
    const u = uRows[0]
    if (!u) return res.sendStatus(401)

    // Emitir nuevos tokens
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

    res.cookie('coc_access', access, {
  ...cookieCommon,
  maxAge: (Number(process.env.ACCESS_TTL_MIN) || 15) * 60 * 1000,
  path: '/'
})

res.cookie('coc_refresh', refresh, {
  ...cookieCommon,
  maxAge: 7 * 864e5,
  path: '/'
})

    await audit({ conn: pool, userId: u.id, action: 'REFRESH_ROTATED', entityId: u.id, meta: {} })
    return res.json({ ok: true })
  } catch (e) {
    return res.sendStatus(401)
  }
}