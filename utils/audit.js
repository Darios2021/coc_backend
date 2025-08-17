// utils/audit.js

module.exports = async function audit({ conn, action, meta = {} }) {
  try {
    console.log(`[AUDIT] Acción: ${action}`, meta)

    // Si en algún momento querés guardar en la base de datos, podés usar algo así:
    // await conn.execute(
    //   'INSERT INTO audit_log (action, meta, created_at) VALUES (?, ?, NOW())',
    //   [action, JSON.stringify(meta)]
    // )
  } catch (err) {
    console.error('Error al guardar auditoría:', err)
  }
}
