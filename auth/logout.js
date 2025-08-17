const express = require('express')
const crypto = require('crypto')
const pool = require('../db')
const audit = require('../utils/audit')  // Asegurate de tener esta función como en login

const router = express.Router()

router.post('/', async (req, res) => {
  const token = req.cookies?.coc_refresh
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress
  const ua = req.headers['user-agent']

  if (!token) return res.sendStatus(204) // Nada que hacer si no hay token

  const jtiHash = crypto.createHash('sha256').update(token).digest('hex')

  // Eliminar el token
  const [result] = await pool.execute('DELETE FROM refresh_tokens WHERE token_hash = ?', [jtiHash])
  if (result.affectedRows > 0) {
    await audit({ conn: pool, action: 'LOGOUT', meta: { ip, ua } })
  }

  res.clearCookie('coc_access')
  res.clearCookie('coc_refresh')
  return res.sendStatus(204)
})

module.exports = router
