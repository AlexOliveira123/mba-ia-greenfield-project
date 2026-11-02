import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { UploadCompleteDto } from './dto/upload-complete.dto';
import { UploadInitiateDto } from './dto/upload-initiate.dto';
import {
  type CompleteUploadResult,
  type InitiateUploadResult,
  type PresignedUrlResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload/initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate multipart upload',
    description:
      'Creates a draft video and returns presigned URLs for each upload part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        uploadId: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              presignedUrl: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to the authenticated user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  initiateUpload(
    @Body() dto: UploadInitiateDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(dto, user.sub);
  }

  @Post('upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete multipart upload',
    description:
      'Seals the multipart upload and enqueues the video processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing job enqueued',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Parts count does not match the recorded partCount',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  completeUpload(
    @Body() dto: UploadCompleteDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(dto, user.sub);
  }

  @Get(':publicId/stream-url')
  @Public()
  @ApiOperation({
    summary: 'Get stream URL',
    description:
      'Returns a presigned GET URL for video streaming (TTL: 4h). Video must be in ready status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned stream URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getStreamUrl(
    @Param('publicId') publicId: string,
  ): Promise<PresignedUrlResult> {
    return this.videosService.getStreamUrl(publicId);
  }

  @Get(':publicId/download-url')
  @Public()
  @ApiOperation({
    summary: 'Get download URL',
    description:
      'Returns a presigned GET URL for video download with Content-Disposition: attachment (TTL: 1h).',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getDownloadUrl(
    @Param('publicId') publicId: string,
  ): Promise<PresignedUrlResult> {
    return this.videosService.getDownloadUrl(publicId);
  }
}
