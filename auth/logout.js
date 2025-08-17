// coc_backend/auth/logout.js
const crypto = require('crypto')
const pool = require('../db')
const audit = require('../utils/audit')
const cookieCommon = require('../config/cookies')

module.exports = async function logout(req, res) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress
  const ua = req.headers['user-agent']
  const token = req.cookies?.coc_refresh

  if (token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const [result] = await pool.execute('DELETE FROM refresh_tokens WHERE token_hash = ?', [hash])
    if (result.affectedRows > 0) {
      await audit({ conn: pool, action: 'LOGOUT', meta: { ip, ua } })
    }
  }

  // limpiar con mismas flags
  res.clearCookie('coc_access',  { ...cookieCommon })
  res.clearCookie('coc_refresh', { ...cookieCommon })
  return res.sendStatus(204)
}