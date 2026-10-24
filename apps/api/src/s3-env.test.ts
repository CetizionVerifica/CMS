import { describe, expect, it } from 'vitest';
import { s3SettingsFromEnv } from './s3-env.js';

const keys = { S3_BUCKET: 'canopy', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' };

describe('s3SettingsFromEnv', () => {
  it('is null until the bucket and both keys are set', () => {
    expect(s3SettingsFromEnv({})).toBeNull();
    expect(s3SettingsFromEnv({ ...keys, S3_BUCKET: '' })).toBeNull();
    expect(s3SettingsFromEnv({ ...keys, S3_ACCESS_KEY_ID: undefined })).toBeNull();
    expect(s3SettingsFromEnv({ ...keys, S3_SECRET_ACCESS_KEY: '' })).toBeNull();
  });

  it('defaults the region to ap-south-1 and leaves the endpoint out for AWS', () => {
    expect(s3SettingsFromEnv(keys)).toEqual({
      bucket: 'canopy',
      region: 'ap-south-1',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
  });

  it('passes a region and an S3-compatible endpoint through', () => {
    expect(
      s3SettingsFromEnv({ ...keys, S3_REGION: 'eu-west-1', S3_ENDPOINT: 'http://localhost:8333' }),
    ).toMatchObject({ region: 'eu-west-1', endpoint: 'http://localhost:8333' });
  });
});
