// routes/auth.js
const express = require('express')
const router = express.Router()

// Controladores
const login = require('../auth/login')
const logout = require('../auth/logout')
const refresh = require('../auth/refresh')

// Limiter de login
const loginLimiter = require('../middleware/loginLimiter')

// Rutas
router.post('/login',  loginLimiter, login)
router.post('/logout', logout)
router.post('/refresh', refresh)

module.exports = router