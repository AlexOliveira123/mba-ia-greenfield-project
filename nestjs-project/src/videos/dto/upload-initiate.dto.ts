import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UploadInitiateDto {
  @IsUUID()
  channelId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @IsInt()
  @Min(1)
  @Max(10737418240)
  fileSize: number;

  @IsIn(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'])
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  partCount: number;
}
