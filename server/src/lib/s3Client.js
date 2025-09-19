// src/lib/s3Client.js
import { S3Client } from '@aws-sdk/client-s3';

export const S3_BUCKET = process.env.S3_BUCKET;
if (!S3_BUCKET) {
  console.warn('[S3] S3_BUCKET env var is not set');
}

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-southeast-2',
  // Credentials auto-resolve: EC2 instance role in prod; env/~/.aws in dev
});
