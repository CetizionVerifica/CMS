/** The S3 bucket imports (M8) and exports (M10) share, from the environment (`.env.example`). */
export interface S3Settings {
  readonly bucket: string;
  readonly region: string;
  /** Set for S3-compatible stores (SeaweedFS locally); callers then use path-style URLs. */
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Null when storage is not configured: the bucket or either key is missing. */
export function s3SettingsFromEnv(env: NodeJS.ProcessEnv): S3Settings | null {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return {
    bucket: S3_BUCKET,
    region: S3_REGION || 'ap-south-1',
    ...(S3_ENDPOINT && { endpoint: S3_ENDPOINT }),
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  };
}
