// routes/auth.js
const express = require('express')
const router = express.Router()

const loginLimiter = require('../middleware/loginLimiter')
const login = require('../auth/login')
const logout = require('../auth/logout')
const refresh = require('../auth/refresh')

router.post('/login', loginLimiter, login)
router.post('/logout', logout)
router.post('/refresh', refresh)

module.exports = router