// s3.js (CommonJS)
const { S3Client } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.MINIO_REGION || "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT,       // https://minio-coc-api.cingulado.org
  forcePathStyle: true,                       // necesario para MinIO
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});

module.exports = { s3 };