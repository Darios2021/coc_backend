// config/cookies.js
const prod = process.env.NODE_ENV === 'production'

/**
 * Opciones comunes para setear cookies HttpOnly en cross-site.
 * - sameSite: 'None' es obligatorio cuando el front y el back están en dominios distintos.
 * - secure: true requerido por los navegadores cuando sameSite === 'None'.
 * - path: '/' para que apliquen a todas las rutas del backend.
 */
module.exports = {
  httpOnly: true,
  secure: prod,          // en CapRover es https, así que true
  sameSite: prod ? 'None' : 'Lax',
  path: '/',
  // domain: opcional. No lo seteamos; por defecto queda en el host del backend.
}
