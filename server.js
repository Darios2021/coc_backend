// ===== deps =====
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const chokidar = require('chokidar');
const cookieParser = require('cookie-parser');
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3 } = require("./s3");
require('dotenv').config();

// ===== app =====
const app = express();

// === CORS configurado explícitamente ===
const allowedOrigins = [
  'https://coc.md-seguridad.com',
  'http://localhost:5173'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(cookieParser());
app.use(express.json());

// === rutas de autenticación ===
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

// === tu código continúa sin cambios desde acá ===
// 👇👇👇





// ===== db =====
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'coc_user',
  password: process.env.DB_PASSWORD || 'coc_pass_2025',
  database: process.env.DB_NAME || 'coc_docs'
});
const db = pool.promise();

// ===== uploads =====
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, Date.now() + '-' + safe);
  }
});
const upload = multer({ storage });

// ===== helpers =====
async function extractTextByPage(absPath) {
  const dataBuffer = fs.readFileSync(absPath);
  const options = {
    pagerender: (pageData) =>
      pageData.getTextContent().then(tc => tc.items.map(i => i.str).join(' '))
  };
  const parsed = await pdfParse(dataBuffer, options);
  // Simple: devolvemos todo en una "página" (si más adelante querés por página real, se ajusta)
  return [parsed.text || ''];
}

function normalizeText(s) {
  return (s || '')
    .replace(/-\s*\n/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitIntoSectionsFromPages(pages) {
  const headingRx =
    /^(CAP[IÍ]TULO\b.*|Cap[ií]tulo\b.*|Secci[oó]n\b.*|\d+(\.\d+){0,4}\s+[A-ZÁÉÍÓÚÑ].{0,120})$/;

  const sections = [];
  let order = 0;

  pages.forEach((rawPage, idx) => {
    const pageNo = idx + 1;
    const page = normalizeText(rawPage);
    const lines = page.split('\n').map(l => l.trim()).filter(Boolean);

    let current = { heading: `Pág. ${pageNo} · Introducción`, content: '' };

    for (const line of lines) {
      const isAllCapsShort =
        line.length <= 90 && line === line.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(line);
      if (headingRx.test(line) || isAllCapsShort) {
        if (current.content.trim()) {
          sections.push({
            section_path: `Pág. ${pageNo}`,
            heading: current.heading.slice(0, 255),
            content: current.content.trim(),
            order_index: order++,
            page_no: pageNo
          });
        }
        current = { heading: `Pág. ${pageNo} · ${line}`, content: '' };
      } else {
        current.content += (current.content ? '\n' : '') + line;
      }
    }

    if (current.content.trim()) {
      sections.push({
        section_path: `Pág. ${pageNo}`,
        heading: current.heading.slice(0, 255),
        content: current.content.trim(),
        order_index: order++,
        page_no: pageNo
      });
    }
  });

  if (sections.length === 0) {
    const whole = pages.map(normalizeText).join('\n\n');
    sections.push({
      section_path: 'Documento',
      heading: 'Documento',
      content: whole,
      order_index: 0,
      page_no: 1
    });
  }
  return sections;
}

// ===== ingest =====
async function ingestPdfAbs(absPath, meta = {}) {
  const relPath = path.join('uploads', path.basename(absPath));

  // eliminar registros viejos si existe un doc con el mismo archivo
  const [exist] = await db.query('SELECT id FROM documents WHERE source_file = ? LIMIT 1', [relPath]);
  if (exist.length) {
    console.log(`🗑 Eliminando documento previo ID ${exist[0].id}`);
    await db.query('DELETE FROM sections WHERE document_id = ?', [exist[0].id]);
    await db.query('DELETE FROM documents WHERE id = ?', [exist[0].id]);
  }

  const title = meta.title || path.basename(absPath).replace(/\.pdf$/i, '');
  const docType = meta.doc_type || 'otro';
  const version = meta.version || null;

  console.log(`📄 Ingestando PDF: ${absPath}`);
  const [ins] = await db.query(
    'INSERT INTO documents (title, doc_type, version, source_file, created_by) VALUES (?,?,?,?,NULL)',
    [title, docType, version, relPath]
  );
  const documentId = ins.insertId;

  const pages = await extractTextByPage(absPath);
  const secs = splitIntoSectionsFromPages(pages);

  for (const s of secs) {
    await db.query(
      'INSERT INTO sections (document_id, section_path, heading, content, order_index, page_no) VALUES (?,?,?,?,?,?)',
      [documentId, s.section_path, s.heading, s.content, s.order_index, s.page_no || null]
    );
  }

  console.log(`✅ PDF procesado: ${title} (${secs.length} secciones)`);
  return { id: documentId, title, doc_type: docType, sections_created: secs.length, source_file: relPath };
}

// ===== routes =====
app.get('/health', (_req, res) => res.json({ ok: true }));

// listado básico
app.get('/docs', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, title, doc_type, version, created_at FROM documents ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// detalle + secciones (incluye page_no)
app.get('/docs/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [[doc]] = await db.query(
      'SELECT id, title, doc_type, version, source_file, created_at FROM documents WHERE id = ? LIMIT 1',
      [id]
    );
    if (!doc) return res.status(404).json({ error: 'No encontrado' });

    const [secs] = await db.query(
      'SELECT id, section_path, heading, content, order_index, page_no FROM sections WHERE document_id = ? ORDER BY order_index ASC',
      [id]
    );
    res.json({ ...doc, sections: secs });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// servir PDF (no-cache)
app.get('/docs/:id/file', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [[doc]] = await db.query(
      'SELECT source_file FROM documents WHERE id = ? LIMIT 1',
      [id]
    );
    if (!doc || !doc.source_file) return res.status(404).json({ error: 'Archivo no encontrado para este documento' });

    const absPath = path.join(__dirname, doc.source_file);
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'PDF no existe en disco' });

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(absPath);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// subir PDF
// subir PDF (guarda en disco + ingesta + opcional sube a MinIO)
app.post('/docs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo PDF' });

    const meta = {
      title: req.body.title || req.file.originalname.replace(/\.pdf$/i, ''),
      doc_type: req.body.doc_type || 'otro',
      version: req.body.version || null
    };

    const absPath = req.file.path; // ya está en uploads/ por tu multer.diskStorage
    const relName = path.basename(absPath);

    // 1) Ingesta como ya hacías
    const r = await ingestPdfAbs(absPath, meta);

    // 2) (opcional) subir una copia a MinIO
    if (String(process.env.MINIO_ENABLE).toLowerCase() === 'true') {
      try {
        const data = fs.readFileSync(absPath);
        const key = `${Date.now()}_${relName}`;
        await s3.send(new PutObjectCommand({
          Bucket: process.env.MINIO_BUCKET,
          Key: key,
          Body: data,
          ContentType: 'application/pdf',
        }));
        r.minio = { bucket: process.env.MINIO_BUCKET, key };
      } catch (e) {
        console.error('⚠️  Copia a MinIO falló:', e.message || e);
        // no cortamos la respuesta; tu flujo a disco queda OK igual
      }
    }

    res.status(201).json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});


// ===== búsqueda global =====
// (si creás un índice FULLTEXT en sections(content,heading), cambiá el query por MATCH...AGAINST)
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ q, results: [] });

  const like = `%${q}%`;
  try {
    const [rows] = await db.query(
      `SELECT s.document_id, s.id as section_id, d.title, s.heading, s.page_no
       FROM sections s JOIN documents d ON d.id=s.document_id
       WHERE s.content LIKE ? OR s.heading LIKE ?
       ORDER BY d.created_at DESC
       LIMIT 50`,
      [like, like]
    );
    res.json({ q, results: rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== watcher & sync =====
async function findDocByRel(relPath) {
  const [[doc]] = await db.query('SELECT id FROM documents WHERE source_file = ? LIMIT 1', [relPath]);
  return doc || null;
}

async function reingestExistingDoc(absPath, relPath, id) {
  console.log(`♻️  Re-ingest ID ${id} desde ${relPath}`);
  await db.query('DELETE FROM sections WHERE document_id = ?', [id]);
  const pages = await extractTextByPage(absPath);
  const secs  = splitIntoSectionsFromPages(pages);
  let order = 0;
  for (const s of secs) {
    await db.query(
      'INSERT INTO sections (document_id, section_path, heading, content, order_index, page_no) VALUES (?,?,?,?,?,?)',
      [id, s.section_path, s.heading, s.content, order++, s.page_no || null]
    );
  }
  console.log(`✅ Re-ingest OK: ${secs.length} secciones`);
}

async function removeDocByRel(relPath) {
  const doc = await findDocByRel(relPath);
  if (!doc) return;
  console.log(`🗑  Archivo eliminado, borrando doc ID ${doc.id}`);
  await db.query('DELETE FROM sections WHERE document_id = ?', [doc.id]);
  await db.query('DELETE FROM documents WHERE id = ?', [doc.id]);
}

// Debounce por archivo
const pending = new Map();
function debounce(key, ms, fn) {
  clearTimeout(pending.get(key));
  const t = setTimeout(fn, ms);
  pending.set(key, t);
}

async function initialSync() {
  const filesOnDisk = fs.readdirSync(uploadDir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(uploadDir, f));

  // nuevos en disco → ingest
  for (const abs of filesOnDisk) {
    const rel = path.join('uploads', path.basename(abs));
    const doc = await findDocByRel(rel);
    if (!doc) {
      console.log('📥 Sync: nuevo en disco → ingest', rel);
      await ingestPdfAbs(abs);
    }
  }

  // huérfanos en DB → borrar
  const [rows] = await db.query('SELECT id, source_file FROM documents');
  for (const r of rows) {
    const abs = r.source_file ? path.join(__dirname, r.source_file) : null;
    if (!abs || !fs.existsSync(abs)) {
      console.log('🧹 Sync: huérfano en DB → delete', r.id, r.source_file);
      await db.query('DELETE FROM sections WHERE document_id = ?', [r.id]);
      await db.query('DELETE FROM documents WHERE id = ?', [r.id]);
    }
  }
  console.log('🔁 Sync inicial completa');
}

function startRobustWatcher() {
  const watcher = chokidar.watch(path.join(uploadDir, '*.pdf'), {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  });

  watcher.on('add', (absPath) => {
    debounce(`add:${absPath}`, 400, async () => {
      try {
        const rel = path.join('uploads', path.basename(absPath));
        const doc = await findDocByRel(rel);
        if (doc) {
          await reingestExistingDoc(absPath, rel, doc.id);
        } else {
          await ingestPdfAbs(absPath);
        }
      } catch (e) { console.error('add error:', e); }
    });
  });

  watcher.on('change', (absPath) => {
    debounce(`chg:${absPath}`, 400, async () => {
      try {
        const rel = path.join('uploads', path.basename(absPath));
        const doc = await findDocByRel(rel);
        if (doc) {
          await reingestExistingDoc(absPath, rel, doc.id);
        } else {
          await ingestPdfAbs(absPath);
        }
      } catch (e) { console.error('change error:', e); }
    });
  });

  watcher.on('unlink', (absPath) => {
    debounce(`del:${absPath}`, 200, async () => {
      try {
        const rel = path.join('uploads', path.basename(absPath));
        await removeDocByRel(rel);
      } catch (e) { console.error('unlink error:', e); }
    });
  });

  console.log('👀 Watcher robusto activo en', uploadDir);
}

// correr al arranque
initialSync().then(() => startRobustWatcher());

// ===== mantenimiento =====
app.delete('/docs/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [[doc]] = await db.query('SELECT source_file FROM documents WHERE id=? LIMIT 1', [id]);
    if (!doc) return res.status(404).json({ error: 'No encontrado' });

    if (doc.source_file) {
      const abs = path.join(__dirname, doc.source_file);
      if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch {} }
    }
    await db.query('DELETE FROM sections WHERE document_id=?', [id]);
    await db.query('DELETE FROM documents WHERE id=?', [id]);
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/docs/missing', async (_req, res) => {
  try {
    const [rows] = await db.query('SELECT id, title, source_file FROM documents');
    const missing = rows.filter(r => !r.source_file || !fs.existsSync(path.join(__dirname, r.source_file)));
    res.json({ count: missing.length, missing });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/docs/missing/cleanup', async (_req, res) => {
  try {
    const [rows] = await db.query('SELECT id, source_file FROM documents');
    const toDelete = rows.filter(r => !r.source_file || !fs.existsSync(path.join(__dirname, r.source_file)));
    for (const d of toDelete) {
      await db.query('DELETE FROM sections WHERE document_id=?', [d.id]);
      await db.query('DELETE FROM documents WHERE id=?', [d.id]);
    }
    res.json({ ok: true, removed: toDelete.map(d => d.id) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== start =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 API COC en http://localhost:${port}`));
