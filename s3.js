// s3.js
const { S3Client } = require("@aws-sdk/client-s3")

const s3 = new S3Client({
  region: process.env.MINIO_REGION || "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT,   // ej: https://minio-coc.cingulado.org
  forcePathStyle: true,                   // requerido por MinIO
  requestTimeout: 30000,                  // 30s por si PDFs grandes
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
})

/*
 * Si tu MinIO usa certificado self-signed y no podés instalar la CA:
 *   process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
 * ⚠️ No recomendado en producción. Mejor: instalar CA o usar Let's Encrypt.
 */

module.exports = { s3 }
