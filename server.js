// ===== deps =====
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const pdfParse = require('pdf-parse')
const cookieParser = require('cookie-parser')
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { s3 } = require('./s3')
require('dotenv').config()

// ===== app =====
const app = express()
app.set('trust proxy', 1)

// ===== CORS (multi-origen desde FRONT_ORIGIN CSV) =====
const frontCsv = (process.env.FRONT_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({
  origin(origin, cb) {
    if (!origin || frontCsv.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

app.use(cookieParser())
app.use(express.json())

// === rutas de autenticación ===
const authRoutes = require('./routes/auth')
app.use('/auth', authRoutes)

// ===== db =====
const db = require('./db')

// ===== helpers texto PDF =====
function normalizeText(s) {
  return (s || '')
    .replace(/-\s*\n/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitIntoSectionsFromPages(pages) {
  const headingRx = /^(CAP[IÍ]TULO\b.*|Cap[ií]tulo\b.*|Secci[oó]n\b.*|\d+(\.\d+){0,4}\s+[A-ZÁÉÍÓÚÑ].{0,120})$/
  const sections = []
  let order = 0

  pages.forEach((rawPage, idx) => {
    const pageNo = idx + 1
    const page = normalizeText(rawPage)
    const lines = page.split('\n').map(l => l.trim()).filter(Boolean)

    let current = { heading: `Pág. ${pageNo} · Introducción`, content: '' }

    for (const line of lines) {
      const isAllCapsShort = line.length <= 90 && line === line.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(line)
      if (headingRx.test(line) || isAllCapsShort) {
        if (current.content.trim()) {
          sections.push({
            section_path: `Pág. ${pageNo}`,
            heading: current.heading.slice(0, 255),
            content: current.content.trim(),
            order_index: order++,
            page_no: pageNo
          })
        }
        current = { heading: `Pág. ${pageNo} · ${line}`, content: '' }
      } else {
        current.content += (current.content ? '\n' : '') + line
      }
    }

    if (current.content.trim()) {
      sections.push({
        section_path: `Pág. ${pageNo}`,
        heading: current.heading.slice(0, 255),
        content: current.content.trim(),
        order_index: order++,
        page_no: pageNo
      })
    }
  })

  if (sections.length === 0) {
    const whole = pages.map(normalizeText).join('\n\n')
    sections.push({
      section_path: 'Documento',
      heading: 'Documento',
      content: whole,
      order_index: 0,
      page_no: 1
    })
  }
  return sections
}

async function extractTextByPageFromBuffer(buffer) {
  const options = {
    pagerender: (pageData) =>
      pageData.getTextContent().then(tc => tc.items.map(i => i.str).join(' '))
  }
  const parsed = await pdfParse(buffer, options)
  return [parsed.text || '']
}

function safeName(original) {
  return (original || 'archivo.pdf').replace(/\s+/g, '_').replace(/[^\w.\-]/g, '')
}

// ===== Ingesta MINIO-ONLY =====
async function ingestPdfBufferToMinio(buffer, origName, meta = {}) {
  const title = meta.title || origName.replace(/\.pdf$/i, '')
  const docType = meta.doc_type || 'otro'
  const version = meta.version || null
  const key = `${Date.now()}_${safeName(origName)}`

  // 1) Upload a MinIO
  await s3.send(new PutObjectCommand({
    Bucket: process.env.MINIO_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf'
  }))

  // 2) Crear documento con clave de MinIO
  const [ins] = await db.query(
    'INSERT INTO documents (title, doc_type, version, source_minio_key, source_file, created_by) VALUES (?,?,?,?,NULL,NULL)',
    [title, docType, version, key]
  )
  const documentId = ins.insertId

  // 3) Parsear y crear secciones
  const pages = await extractTextByPageFromBuffer(buffer)
  const secs = splitIntoSectionsFromPages(pages)
  let order = 0
  for (const s of secs) {
    await db.query(
      'INSERT INTO sections (document_id, section_path, heading, content, order_index, page_no) VALUES (?,?,?,?,?,?)',
      [documentId, s.section_path, s.heading, s.content, order++, s.page_no || null]
    )
  }

  return { id: documentId, title, doc_type: docType, sections_created: secs.length, source_minio_key: key }
}

// ===== multer (memoria) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (process.env.FILE_MAX_MB ? Number(process.env.FILE_MAX_MB) : 50) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Solo PDFs'), false)
    cb(null, true)
  }
})

// ===== routes =====
app.get('/health', (_req, res) => res.json({ ok: true }))

// listado básico
app.get('/docs', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, title, doc_type, version, created_at FROM documents ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// detalle + secciones
app.get('/docs/:id', async (req, res) => {
  const id = Number(req.params.id)
  try {
    const [[doc]] = await db.query(
      'SELECT id, title, doc_type, version, source_minio_key, source_file, created_at FROM documents WHERE id = ? LIMIT 1',
      [id]
    )
    if (!doc) return res.status(404).json({ error: 'No encontrado' })
    const [secs] = await db.query(
      'SELECT id, section_path, heading, content, order_index, page_no FROM sections WHERE document_id = ? ORDER BY order_index ASC',
      [id]
    )
    res.json({ ...doc, sections: secs })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// servir PDF -> presigned URL de MinIO (fallback a disco si fuera legado)
app.get('/docs/:id/file', async (req, res) => {
  const id = Number(req.params.id)
  try {
    const [[doc]] = await db.query(
      'SELECT source_minio_key, source_file FROM documents WHERE id = ? LIMIT 1',
      [id]
    )
    if (!doc) return res.status(404).json({ error: 'No encontrado' })

    if (doc.source_minio_key) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.MINIO_BUCKET, Key: doc.source_minio_key }),
        { expiresIn: 60 * 10 }
      )
      return res.json({ url })
    }

    // Compatibilidad con viejos en disco
    if (doc.source_file) {
      const absPath = path.join(__dirname, doc.source_file)
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'PDF no existe en disco' })
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      res.setHeader('Content-Type', 'application/pdf')
      return res.sendFile(absPath)
    }

    return res.status(404).json({ error: 'Documento sin fuente' })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// subir PDF -> MINIO ONLY + ingesta
app.post('/docs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo PDF' })

    const meta = {
      title: req.body.title || req.file.originalname.replace(/\.pdf$/i, ''),
      doc_type: req.body.doc_type || 'otro',
      version: req.body.version || null
    }

    const r = await ingestPdfBufferToMinio(req.file.buffer, req.file.originalname, meta)
    res.status(201).json(r)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

// búsqueda global
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.json({ q, results: [] })

  const like = `%${q}%`
  try {
    const [rows] = await db.query(
      `SELECT s.document_id, s.id as section_id, d.title, s.heading, s.page_no
       FROM sections s JOIN documents d ON d.id=s.document_id
       WHERE s.content LIKE ? OR s.heading LIKE ?
       ORDER BY d.created_at DESC
       LIMIT 50`,
      [like, like]
    )
    res.json({ q, results: rows })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// (opcional) migrar legados del disco -> MinIO y limpiar
app.post('/docs/migrate-local-to-minio', async (_req, res) => {
  try {
    const [docs] = await db.query('SELECT id, source_file FROM documents WHERE source_file IS NOT NULL')
    let migrated = 0, missing = 0

    for (const d of docs) {
      const abs = d.source_file ? path.join(__dirname, d.source_file) : null
      if (!abs || !fs.existsSync(abs)) { missing++; continue }

      const data = fs.readFileSync(abs)
      const key = `legacy_${Date.now()}_${safeName(path.basename(abs))}`
      await s3.send(new PutObjectCommand({
        Bucket: process.env.MINIO_BUCKET,
        Key: key,
        Body: data,
        ContentType: 'application/pdf'
      }))
      await db.query('UPDATE documents SET source_minio_key = ?, source_file = NULL WHERE id = ?', [key, d.id])
      try { fs.unlinkSync(abs) } catch {}
      migrated++
    }
    res.json({ ok: true, migrated, missing })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

// eliminar doc (borra objeto en MinIO si aplica)
app.delete('/docs/:id', async (req, res) => {
  const id = Number(req.params.id)
  try {
    const [[doc]] = await db.query('SELECT source_minio_key, source_file FROM documents WHERE id=? LIMIT 1', [id])
    if (!doc) return res.status(404).json({ error: 'No encontrado' })

    if (doc.source_minio_key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.MINIO_BUCKET, Key: doc.source_minio_key }))
      } catch (e) {
        console.warn('MinIO delete warn:', e.message)
      }
    }
    if (doc.source_file) {
      const abs = path.join(__dirname, doc.source_file)
      if (fs.existsSync(abs)) { try { fs.unlinkSync(abs) } catch {} }
    }
    await db.query('DELETE FROM sections WHERE document_id=?', [id])
    await db.query('DELETE FROM documents WHERE id=?', [id])
    res.json({ ok: true, deleted: id })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// ===== start =====
const port = Number(process.env.PORT) || 3001
app.listen(port, () => console.log(`🚀 API COC en http://localhost:${port}`))
