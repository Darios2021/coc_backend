app.post('/auth/refresh', async (req,res)=>{
  const token = req.cookies?.coc_refresh
  if (!token) return res.sendStatus(401)
  try {
    const payload = jwt.verify(token, process.env.REFRESH_SECRET)
    const [rtRows] = await pool.execute('SELECT * FROM refresh_tokens WHERE jti = ?', [payload.jti])
    const rt = rtRows[0]
    if (!rt || rt.revoked_at) return res.sendStatus(401)
    if (rt.token_hash !== crypto.createHash('sha256').update(token).digest('hex')) return res.sendStatus(401)
    if (new Date(rt.expires_at) < new Date()) return res.sendStatus(401)

    await pool.execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [rt.id])

    const [uRows] = await pool.execute('SELECT id,email,role_id FROM users WHERE id=? AND is_active=1', [payload.sub])
    const u = uRows[0]; if (!u) return res.sendStatus(401)

    const jti = uuidv4()
    const access = jwt.sign({ sub:u.id, email:u.email, role_id:u.role_id }, process.env.JWT_SECRET, { expiresIn: `${process.env.ACCESS_TTL_MIN||15}m` })
    const refresh = jwt.sign({ sub:u.id, jti }, process.env.REFRESH_SECRET, { expiresIn: `${process.env.REFRESH_TTL_DAYS||7}d` })

    const now = new Date()
    const exp = new Date(now.getTime() + (process.env.REFRESH_TTL_DAYS||7) * 864e5)
    await pool.execute(
      'INSERT INTO refresh_tokens (user_id,jti,token_hash,issued_at,expires_at) VALUES (?,?,?,?,?)',
      [u.id, jti, crypto.createHash('sha256').update(refresh).digest('hex'), now, exp]
    )

    res.cookie('coc_access', access, { ...cookieCommon, maxAge: (process.env.ACCESS_TTL_MIN||15) * 60 * 1000 })
    res.cookie('coc_refresh', refresh, { ...cookieCommon, maxAge: 7 * 864e5 })

    await audit({ conn: pool, userId:u.id, action:'REFRESH_ROTATED', entityId:u.id, meta:{} })
    res.json({ ok:true })
  } catch { return res.sendStatus(401) }
})