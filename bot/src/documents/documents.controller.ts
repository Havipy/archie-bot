import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  StreamableFile,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as path from 'path';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { AccessService } from '../slack/access.service';
import { SlackService } from '../slack/slack.service';
import { readDocumentFile } from '../storage/storage.util';
import { verifyDocumentLink } from './document-link.util';

@Controller('api/documents')
export class DocumentsController {
  constructor(
    @InjectRepository(NamespaceDocument)
    private readonly namespaceDocumentRepo: Repository<NamespaceDocument>,
    private readonly accessService: AccessService,
    private readonly slackService: SlackService,
  ) {}

  @Get(':id/file')
  async downloadFile(
    @Param('id') id: string,
    @Query('u') userId: string | undefined,
    @Query('sig') sig: string | undefined,
  ): Promise<StreamableFile> {
    if (!userId || !sig || !verifyDocumentLink(id, userId, sig)) {
      throw new UnauthorizedException('Invalid or missing link signature');
    }

    const doc = await this.namespaceDocumentRepo.findOne({ where: { id } });
    if (!doc?.storagePath) throw new NotFoundException('File not found');

    const allowed = await this.accessService.canAccess(
      userId,
      doc.namespaceId,
      this.slackService.app,
    );
    if (!allowed) throw new ForbiddenException('Access denied');

    const data = readDocumentFile(doc.storagePath);
    const filename = path.basename(doc.filename);

    return new StreamableFile(data, {
      type: doc.mimeType ?? 'application/octet-stream',
      disposition: `inline; filename="${filename}"`,
    });
  }
}
