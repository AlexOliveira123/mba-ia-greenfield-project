import { Test, TestingModule } from '@nestjs/testing';
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';
import {
  STORAGE_CLIENT_INTERNAL,
  STORAGE_CLIENT_PUBLIC,
} from './storage.constants';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

describe('StorageService', () => {
  let service: StorageService;
  let s3Internal: jest.Mocked<Pick<S3Client, 'send'>>;
  let s3Public: jest.Mocked<Pick<S3Client, 'send'>>;

  beforeAll(async () => {
    s3Internal = { send: jest.fn() };
    s3Public = { send: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: STORAGE_CLIENT_INTERNAL, useValue: s3Internal },
        { provide: STORAGE_CLIENT_PUBLIC, useValue: s3Public },
        {
          provide: storageConfig.KEY,
          useValue: {
            endpoint: 'http://minio:9000',
            publicEndpoint: 'http://localhost:9000',
            region: 'us-east-1',
            accessKeyId: 'test',
            secretAccessKey: 'test',
            bucket: 'test-bucket',
          },
        },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ensureBucket', () => {
    it('should return immediately when bucket already exists', async () => {
      (s3Internal.send as jest.Mock).mockResolvedValue({});

      await service.ensureBucket();

      expect(s3Internal.send).toHaveBeenCalledWith(
        expect.any(HeadBucketCommand),
      );
      expect(s3Internal.send).toHaveBeenCalledTimes(1);
    });

    it('should create bucket when HeadBucket returns 404', async () => {
      const notFound = Object.assign(new Error('Not Found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      (s3Internal.send as jest.Mock)
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({});

      await service.ensureBucket();

      expect(s3Internal.send).toHaveBeenNthCalledWith(
        1,
        expect.any(HeadBucketCommand),
      );
      expect(s3Internal.send).toHaveBeenNthCalledWith(
        2,
        expect.any(CreateBucketCommand),
      );
    });

    it('should be idempotent when CreateBucket returns BucketAlreadyOwnedByYou', async () => {
      const notFound = Object.assign(new Error('Not Found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      const alreadyOwned = Object.assign(new Error('Already owned'), {
        name: 'BucketAlreadyOwnedByYou',
      });
      (s3Internal.send as jest.Mock)
        .mockRejectedValueOnce(notFound)
        .mockRejectedValueOnce(alreadyOwned);

      await expect(service.ensureBucket()).resolves.not.toThrow();
    });
  });

  describe('createMultipartUpload', () => {
    it('should send CreateMultipartUploadCommand via INTERNAL client and return uploadId', async () => {
      (s3Internal.send as jest.Mock).mockResolvedValue({
        UploadId: 'upload-abc',
      });

      const result = await service.createMultipartUpload('videos/test.mp4');

      expect(result).toEqual({ uploadId: 'upload-abc' });
      expect(s3Internal.send).toHaveBeenCalledWith(
        expect.any(CreateMultipartUploadCommand),
      );
      expect(s3Public.send).not.toHaveBeenCalled();
    });
  });

  describe('getPresignedPartUrls', () => {
    it('should call getSignedUrl with PUBLIC client and return presigned URLs for each part', async () => {
      mockGetSignedUrl
        .mockResolvedValueOnce(
          'https://localhost:9000/key?X-Amz-Signature=s1&PartNumber=1',
        )
        .mockResolvedValueOnce(
          'https://localhost:9000/key?X-Amz-Signature=s2&PartNumber=2',
        );

      const parts = await service.getPresignedPartUrls(
        'videos/test.mp4',
        'upload-abc',
        2,
      );

      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({
        partNumber: 1,
        presignedUrl:
          'https://localhost:9000/key?X-Amz-Signature=s1&PartNumber=1',
      });
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        s3Public,
        expect.anything(),
        { expiresIn: 3600 },
      );
      expect(s3Internal.send).not.toHaveBeenCalled();
    });
  });

  describe('completeMultipartUpload', () => {
    it('should send CompleteMultipartUploadCommand via INTERNAL client', async () => {
      (s3Internal.send as jest.Mock).mockResolvedValue({});

      await service.completeMultipartUpload('videos/test.mp4', 'upload-abc', [
        { partNumber: 1, eTag: '"etag1"' },
        { partNumber: 2, eTag: '"etag2"' },
      ]);

      expect(s3Internal.send).toHaveBeenCalledWith(
        expect.any(CompleteMultipartUploadCommand),
      );
      expect(s3Public.send).not.toHaveBeenCalled();
    });
  });

  describe('getPresignedGetUrl', () => {
    it('should call getSignedUrl with PUBLIC client and return URL with correct TTL', async () => {
      mockGetSignedUrl.mockResolvedValue(
        'https://localhost:9000/key?X-Amz-Expires=14400&X-Amz-Signature=sig',
      );

      const url = await service.getPresignedGetUrl('videos/test.mp4', 14400);

      expect(url).toContain('X-Amz-Expires=14400');
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        s3Public,
        expect.anything(),
        { expiresIn: 14400 },
      );
      expect(s3Internal.send).not.toHaveBeenCalled();
    });

    it('should pass ResponseContentDisposition when disposition is provided', async () => {
      mockGetSignedUrl.mockResolvedValue(
        'https://localhost:9000/key?response-content-disposition=attachment&X-Amz-Expires=3600',
      );

      await service.getPresignedGetUrl(
        'videos/test.mp4',
        3600,
        'attachment; filename="video.mp4"',
      );

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        s3Public,
        expect.objectContaining({}),
        { expiresIn: 3600 },
      );
    });
  });

  describe('deleteObject', () => {
    it('should send DeleteObjectCommand via INTERNAL client', async () => {
      (s3Internal.send as jest.Mock).mockResolvedValue({});

      await service.deleteObject('videos/test.mp4');

      expect(s3Internal.send).toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
      expect(s3Public.send).not.toHaveBeenCalled();
    });
  });
});
