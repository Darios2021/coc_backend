// ===== deps =====
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const pdfParse = require('pdf-parse')
const cookieParser = require('cookie-parser')
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
require('dotenv').config()

// ==== MinIO: carga perezosa y a prueba de fallos ====
const hasMinioEnv = Boolean(
  process.env.MINIO_BUCKET &&
  process.env.MINIO_ENDPOINT &&
  process.env.MINIO_ACCESS_KEY &&
  process.env.MINIO_SECRET_KEY
)

let s3Client = null
function getS3Safe() {
  if (!hasMinioEnv) return null
  if (s3Client) return s3Client
  try {
    const { s3 } = require('./s3')    // se carga sólo si hace falta
    s3Client = s3
    return s3Client
  } catch (e) {
    console.error('⚠️ No pude inicializar S3/MinIO:', e.message || e)
    return null
  }
}


// ===== validación de .env =====
// ===== validación de .env =====
const requiredEnv = ['PORT']   // <- NO exigir MinIO para arrancar
for (const v of requiredEnv) {
  if (!process.env[v]) {
    console.error(`❌ Faltante: ${v} en .env`)
    process.exit(1)
  }
}
if (!hasMinioEnv) {
  console.warn('⚠️ MinIO deshabilitado: faltan variables (MINIO_*)')
}


// ===== app =====
const app = express()
app.set('trust proxy', 1)

// ===== CORS (multi-origen desde FRONT_ORIGIN CSV) =====
// FRONT_ORIGIN="https://coc.md-seguridad.com,https://otro.dominio"
const frontCsv = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const corsConfig = {
  origin(origin, cb) {
    if (!origin || frontCsv.includes(origin)) return cb(null, true)
    console.warn(`❌ CORS bloqueado: ${origin}`)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Role'],
  exposedHeaders: ['Content-Disposition'],
  optionsSuccessStatus: 204,     // <- algunos navegadores viejos con 200 se quejan
}
app.use(cors(corsConfig))
app.options('*', cors(corsConfig))


// ===== middlewares comunes =====
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// === rutas de autenticación (opcional) ===
try {
  const authRoutes = require('./routes/auth')
  app.use('/auth', authRoutes)
} catch {
  console.warn('ℹ️ /auth no montado (no existe ./routes/auth). Continúo sin auth…')
}

// === rutas de uploads (MinIO directo) opcional ===
try {
  const uploadRoutes = require('./routes/uploads')
  app.use('/uploads', uploadRoutes)
} catch {
  console.warn('ℹ️ /uploads no montado (no existe ./routes/uploads).')
}

// ===== db (debe exportar un pool con .query) =====
const db = require('./db')

// ===== helpers PDF =====
function normalizeText(s) {
  return (s || '')
    .replace(/-\s*\n/g, '')      // une palabras cortadas por salto
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')   // espacios al final de línea
    .replace(/\n{3,}/g, '\n\n')   // colapsa saltos excesivos
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
      const isAllCapsShort =
        line.length <= 90 && line === line.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(line)

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
  // pdf-parse no expone páginas por defecto; devolvemos todo como “una página”
  const options = {
    pagerender: (pageData) =>
      pageData.getTextContent().then(tc => tc.items.map(i => i.str).join(' '))
  }
  const parsed = await pdfParse(buffer, options)
  return [parsed.text || '']
}

function safeName(original) {
  return (original || 'archivo.pdf')
    .replace(/\s+/g, '_')
    .replace(/[^\w.\-]/g, '')
}

// ===== Ingesta PDF a MinIO =====
// ===== Ingesta PDF a MinIO =====
async function ingestPdfBufferToMinio(buffer, origName, meta = {}) {
  const title   = meta.title   || origName.replace(/\.pdf$/i, '')
  const docType = meta.doc_type || 'otro'
  const version = meta.version || null
  const key     = `${Date.now()}_${safeName(origName)}`

  // Sube a MinIO (a prueba de fallos)
  const s3safe = getS3Safe()             // <- usa la función perezosa
  if (!s3safe) {
    throw new Error('MinIO no disponible para ingestión')
  }
  try {
    await s3safe.send(new PutObjectCommand({
      Bucket: process.env.MINIO_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'application/pdf'
    }))
  } catch (e) {
    console.error('MinIO putObject error:', e)
    throw new Error('Falla al subir PDF a MinIO')
  }

  // Inserta metadata del doc
  const [ins] = await db.query(
    'INSERT INTO documents (title, doc_type, version, source_minio_key, source_file, created_by) VALUES (?,?,?,?,NULL,NULL)',
    [title, docType, version, key]
  )
  const documentId = ins.insertId

  // Extrae y trocea contenido
  const pages = await extractTextByPageFromBuffer(buffer)
  const secs  = splitIntoSectionsFromPages(pages)
  let order = 0
  for (const s of secs) {
    await db.query(
      'INSERT INTO sections (document_id, section_path, heading, content, order_index, page_no) VALUES (?,?,?,?,?,?)',
      [documentId, s.section_path, s.heading, s.content, order++, s.page_no || null]
    )
  }

  return {
    id: documentId,
    title,
    doc_type: docType,
    sections_created: secs.length,
    source_minio_key: key
  }
}


// ===== multer (PDFs) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: (process.env.FILE_MAX_MB ? Number(process.env.FILE_MAX_MB) : 50) * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Solo PDFs'), false)
    cb(null, true)
  }
})

// ===== routes =====
app.get('/health', (_req, res) => res.json({ ok: true }))

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

/**
 * Devuelve { url } (presignada de MinIO) o sirve archivo local si existiera.
 */
app.get('/docs/:id/file', async (req, res) => {
  const id = Number(req.params.id)
  try {
    const [[doc]] = await db.query(
      'SELECT source_minio_key, source_file FROM documents WHERE id = ? LIMIT 1',
      [id]
    )
    if (!doc) return res.status(404).json({ error: 'No encontrado' })

    if (doc.source_minio_key) {
  const s3safe = getS3Safe()
  if (!s3safe) return res.status(503).json({ error: 'MinIO no disponible' })
  try {
    const url = await getSignedUrl(
      s3safe,
      new GetObjectCommand({ Bucket: process.env.MINIO_BUCKET, Key: doc.source_minio_key }),
      { expiresIn: 600 }
    )
    return res.json({ url })
  } catch (e) {
    console.error('MinIO presign error:', e.message || e)
    return res.status(502).json({ error: 'Falla al firmar URL de MinIO' })
  }
}


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

/**
 * Sube un PDF (campo form-data: file) -> MinIO + indexa en DB
 * Opcionales: title, doc_type, version
 */
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

/**
 * Búsqueda simple por LIKE sobre sections (contenido + heading) -> /search?q=texto
 */
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.json({ q, results: [] })

  const like = `%${q}%`
  try {
    const [rows] = await db.query(
      `SELECT s.document_id, s.id as section_id, d.title, s.heading, s.page_no
       FROM sections s
       JOIN documents d ON d.id = s.document_id
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

/**
 * Borra documento + PDF en MinIO (si aplica) + secciones
 */
app.delete('/docs/:id', async (req, res) => {
  const id = Number(req.params.id)
  try {
    const [[doc]] = await db.query(
      'SELECT source_minio_key, source_file FROM documents WHERE id = ? LIMIT 1',
      [id]
    )
    if (!doc) return res.status(404).json({ error: 'No encontrado' })

    if (doc.source_minio_key) {
  const s3safe = getS3Safe()
  if (s3safe) {
    try {
      await s3safe.send(new DeleteObjectCommand({
        Bucket: process.env.MINIO_BUCKET,
        Key: doc.source_minio_key
      }))
    } catch (e) {
      console.warn('MinIO delete warn:', e.message || e)
    }
  } else {
    console.warn('MinIO no disponible para borrar objeto:', doc.source_minio_key)
  }
}


    if (doc.source_file) {
      const abs = path.join(__dirname, doc.source_file)
      if (fs.existsSync(abs)) {
        try { fs.unlinkSync(abs) } catch {}
      }
    }

    await db.query('DELETE FROM sections WHERE document_id = ?', [id])
    await db.query('DELETE FROM documents WHERE id = ?', [id])

    res.json({ ok: true, deleted: id })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// ===== middleware de errores global =====
app.use((err, req, res, _next) => {
  console.error('💥 Error global:', err.stack || err)
  res.status(500).json({ error: 'Error interno del servidor' })
})

// ===== start =====
const port = Number(process.env.PORT) || 3001
app.listen(port, () => console.log(`🚀 API COC escuchando en http://localhost:${port}`))