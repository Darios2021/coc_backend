// middleware/loginLimiter.js
const rateLimit = require('express-rate-limit')

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5, // Máximo de 5 intentos por IP
  message: {
    message: 'Demasiados intentos de login desde esta IP, por favor espere un minuto'
  },
  standardHeaders: true,
  legacyHeaders: false
})

module.exports = loginLimiter