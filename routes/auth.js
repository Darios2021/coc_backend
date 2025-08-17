const express = require('express');
const router = express.Router();

// Controladores
const login = require('../auth/login');
const logout = require('../auth/logout');
const refresh = require('../auth/refresh');

// Rutas
router.post('/login', login);
router.post('/logout', logout);
router.post('/refresh', refresh);

module.exports = router;