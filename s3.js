// s3.js
const { S3Client } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.MINIO_REGION || "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT,       // p.ej. https://minio-coc-api.cingulado.org
  forcePathStyle: true,                        // requerido por MinIO
  requestTimeout: 30000,                       // 30s por si PDFs grandes
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});

/*
 * Si tu MinIO tiene certificado self-signed y no podés instalar la CA,
 * última opción (no recomendado en prod):
 *   process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
 * Mejor: instalá la CA en la imagen o usá Let's Encrypt.
 */

module.exports = { s3 };
