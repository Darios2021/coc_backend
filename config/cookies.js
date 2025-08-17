// config/cookies.js
const prod = process.env.NODE_ENV === 'production'

module.exports = {
  httpOnly: true,
  secure: prod,                   // en prod SIEMPRE true (ya lo tenés)
  sameSite: prod ? 'None' : 'Lax',// en prod SIEMPRE 'None' (ya lo tenés)
  path: '/',
  // ⬇️ agregá UNO de estos (elegí):
  // 1) si backend está en coc-backend.cingulado.org:
  domain: 'coc-backend.cingulado.org',
  // 2) o si vas a unificar bajo el mismo dominio que el front:
  // domain: '.md-seguridad.com',
}
