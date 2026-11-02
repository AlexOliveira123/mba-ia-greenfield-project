import { IsArray, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

class UploadPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  eTag: string;
}

export class UploadCompleteDto {
  @IsUUID()
  videoId: string;

  @IsString()
  uploadId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
