const express = require("express");
const multer = require("multer");
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3 } = require("../s3");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (process.env.FILE_MAX_MB ? Number(process.env.FILE_MAX_MB) : 25) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Solo PDF por ahora
    if (file.mimetype !== "application/pdf") return cb(new Error("Solo PDFs"), false);
    cb(null, true);
  },
});

const BUCKET = process.env.MINIO_BUCKET;

// POST /uploads  (campo form-data: file)
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta archivo" });

    const safeName = req.file.originalname.replace(/\s+/g, "_");
    const key = `${Date.now()}_${safeName}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    // URL presignada de lectura (15 min)
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: 60 * 15 }
    );

    res.json({ ok: true, key, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fallo la subida" });
  }
});

// GET /uploads/files -> lista objetos
router.get("/files", async (_req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    const items = (data.Contents || []).map(o => ({
      key: o.Key, size: o.Size, lastModified: o.LastModified,
    }));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo listar" });
  }
});

// GET /uploads/:key -> presigned URL (10 min)
router.get("/:key", async (req, res) => {
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: req.params.key }),
      { expiresIn: 60 * 10 }
    );
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "No encontrado" });
  }
});

// DELETE /uploads/:key
router.delete("/:key", async (req, res) => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: req.params.key }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

module.exports = router;
