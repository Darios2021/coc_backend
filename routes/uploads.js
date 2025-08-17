// routes/uploads.js
const express = require('express')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { s3 } = require('../s3')

const router = express.Router()

// ---------- Config ----------
const BUCKET = process.env.MINIO_BUCKET
const DISK_UPLOAD_DIR = path.join(__dirname, '..', 'uploads')

// Asegurá carpeta local (por si la usás en otros flujos)
if (!fs.existsSync(DISK_UPLOAD_DIR)) fs.mkdirSync(DISK_UPLOAD_DIR, { recursive: true })

// Subidas directas a MinIO (memoria)
const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (process.env.FILE_MAX_MB ? Number(process.env.FILE_MAX_MB) : 25) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Solo PDFs'), false)
    cb(null, true)
  }
})

// Helper: nombre seguro
function safeName(original) {
  return (original || 'archivo.pdf').replace(/\s+/g, '_').replace(/[^\w.\-]/g, '')
}

// ---------- Rutas ----------

// POST /uploads  -> Sube PDF directo a MinIO (campo form-data: file)
router.post('/', uploadMem.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo' })

    const key = `${Date.now()}_${safeName(req.file.originalname)}`
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }))

    // URL presignada de lectura (15 min)
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: 60 * 15 }
    )

    res.json({ ok: true, key, url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Falló la subida a MinIO' })
  }
})

// POST /uploads/mirror-local
// Sube TODOS los PDFs que ya existen en /uploads (disco) hacia MinIO.
// Útil para “regularizar” lo que subiste directo al server.
router.post('/mirror-local', async (_req, res) => {
  try {
    const files = fs.readdirSync(DISK_UPLOAD_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'))

    const results = []
    for (const fname of files) {
      const abs = path.join(DISK_UPLOAD_DIR, fname)
      const data = fs.readFileSync(abs)
      const key = `mirror_${Date.now()}_${safeName(fname)}`
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: data,
        ContentType: 'application/pdf',
      }))
      results.push({ local: fname, key })
    }
    res.json({ ok: true, count: results.length, results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'No se pudo espejar el contenido local a MinIO' })
  }
})

// GET /uploads/files -> lista objetos en MinIO
router.get('/files', async (_req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }))
    const items = (data.Contents || []).map(o => ({
      key: o.Key, size: o.Size, lastModified: o.LastModified,
    }))
    res.json(items)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'No se pudo listar el bucket' })
  }
})

// GET /uploads/:key -> presigned URL (10 min)
router.get('/:key', async (req, res) => {
  try {
    const key = req.params.key
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: 60 * 10 }
    )
    res.json({ url })
  } catch (err) {
    console.error(err)
    res.status(404).json({ error: 'No encontrado' })
  }
})

// DELETE /uploads/:key -> borra en MinIO
router.delete('/:key', async (req, res) => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: req.params.key }))
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'No se pudo borrar' })
  }
})

module.exports = router