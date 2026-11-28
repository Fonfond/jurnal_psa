import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/current-user.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { Public } from '../common/public.decorator';
import { AttachmentService, type UploadedPdf } from './attachment.service';

function metaOf(request: Request & AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
  };
}

@Controller()
export class AttachmentController {
  constructor(@Inject(AttachmentService) private readonly attachments: AttachmentService) {}

  @Post('entries/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024, files: 1 },
    }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: UploadedPdf | undefined,
    @Body() body: Record<string, unknown>,
    @Req() request: Request & AppRequest,
  ) {
    return this.attachments.upload(
      user,
      id,
      file,
      { pages: body.pages as string | number | undefined, sha256: body.sha256 as string | undefined },
      metaOf(request),
    );
  }

  @Get('entries/:id/attachments')
  async list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attachments.list(user, id);
  }

  @Delete('entries/:id/attachments/:attachmentId')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: Request & AppRequest,
  ) {
    return this.attachments.remove(user, id, attachmentId, metaOf(request));
  }

  @Get('entries/:id/attachments/:attachmentId')
  async signed(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachments.signedUrl(user, id, attachmentId);
  }

  @Public()
  @Get('attachments/download/:id')
  async download(
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const { row, stream } = await this.attachments.download(id, token ?? '');
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `inline; filename="permit-scan-${row.id}.pdf"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    stream.pipe(response);
  }
}
