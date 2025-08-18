// coc_backend/config/cookies.js
const prod = process.env.NODE_ENV === 'production'
const domain = prod ? (process.env.COOKIE_DOMAIN || undefined) : undefined
// Ejemplos de COOKIE_DOMAIN en .env (solo prod):
// COOKIE_DOMAIN=coc-backend.cingulado.org
// o si unificás front+back bajo el mismo dominio: COOKIE_DOMAIN=.md-seguridad.com

module.exports = {
  httpOnly: true,
  secure: true,            // Requerido cuando sameSite === 'None'
  sameSite: 'None',        // Necesario para que viajen en cross-site (front ↔ back)
  path: '/',
  ...(domain ? { domain } : {})  // Solo aplica en prod si seteaste COOKIE_DOMAIN
}
