// middleware/loginLimiter.js
const rateLimit = require('express-rate-limit')

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  message: 'Demasiados intentos, intentá más tarde'
})

module.exports = loginLimiter