import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  Query,
  BadRequestException,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { AdminService, CreateNamespaceDto, UpdateNamespaceDto } from './admin.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminRateLimitGuard } from './admin-rate-limit.guard';

@Controller('api')
@UseGuards(AdminRateLimitGuard, AdminAuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('namespaces')
  getAllNamespaces() {
    return this.adminService.getAllNamespaces();
  }

  @Get('namespaces/:id')
  getNamespace(@Param('id') id: string) {
    return this.adminService.getNamespaceById(id);
  }

  @Post('namespaces')
  createNamespace(@Body() dto: CreateNamespaceDto) {
    return this.adminService.createNamespace(dto);
  }

  @Put('namespaces/:id')
  updateNamespace(@Param('id') id: string, @Body() dto: UpdateNamespaceDto) {
    return this.adminService.updateNamespace(id, dto);
  }

  @Delete('namespaces/:id')
  deleteNamespace(@Param('id') id: string) {
    return this.adminService.deleteNamespace(id);
  }

  @Get('namespaces/:id/documents')
  getDocuments(@Param('id') id: string) {
    return this.adminService.getDocuments(id);
  }

  @Post('namespaces/:id/documents')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file'))
  async addDocument(
    @Param('id') namespaceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('url') url: string | undefined,
    @Query('uploadedBy') uploadedBy = 'admin',
  ) {
    if (file) {
      this.validateUploadFile(file);
      return this.adminService.uploadDocument(
        namespaceId,
        file.buffer,
        file.originalname,
        uploadedBy,
        file.mimetype,
      );
    }

    if (url) {
      try { new URL(url); } catch { throw new BadRequestException('Invalid URL'); }
      return this.adminService.indexUrl(namespaceId, url, uploadedBy);
    }

    throw new BadRequestException('Provide a file or a url field');
  }

  @Post('namespaces/:id/sync-confluence')
  @HttpCode(202)
  syncConfluenceSpace(
    @Param('id') namespaceId: string,
    @Body() body: { spaceKey?: string; baseUrl?: string },
    @Query('uploadedBy') uploadedBy = 'admin',
  ) {
    const spaceKey = body.spaceKey?.trim();
    if (!spaceKey) throw new BadRequestException('spaceKey is required');
    return this.adminService.syncConfluenceSpace(namespaceId, spaceKey, uploadedBy, body.baseUrl?.trim());
  }

  @Post('namespaces/:id/documents/batch')
  @HttpCode(202)
  @UseInterceptors(FilesInterceptor('files', 20))
  async addDocumentsBatch(
    @Param('id') namespaceId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Query('uploadedBy') uploadedBy = 'admin',
  ) {
    if (!files?.length) throw new BadRequestException('Provide at least one file');
    for (const file of files) this.validateUploadFile(file);
    return this.adminService.uploadDocuments(namespaceId, files, uploadedBy);
  }

  private validateUploadFile(file: Express.Multer.File) {
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException(`"${file.originalname}" too large (max 10MB)`);
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (!['.pdf', '.md', '.txt', '.docx'].includes(`.${ext}`))
      throw new BadRequestException(`"${file.originalname}": only .pdf, .docx, .md, .txt allowed`);
  }

  @Delete('namespaces/:namespaceId/documents/:documentId')
  deleteDocument(
    @Param('namespaceId') namespaceId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.adminService.deleteDocument(namespaceId, documentId);
  }

  @Post('namespaces/:namespaceId/documents/batch-delete')
  @HttpCode(200)
  deleteDocumentsBatch(
    @Param('namespaceId') namespaceId: string,
    @Body() body: { ids?: string[] },
  ) {
    if (!body?.ids?.length) throw new BadRequestException('Provide ids array');
    return this.adminService.deleteDocuments(namespaceId, body.ids);
  }

  @Post('namespaces/:namespaceId/documents/:documentId/reindex')
  @HttpCode(202)
  reindexDocument(
    @Param('namespaceId') namespaceId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.adminService.reindexDocument(namespaceId, documentId);
  }

  @Get('namespaces/:id/access')
  getAccessRules(@Param('id') namespaceId: string) {
    return this.adminService.getAccessRules(namespaceId);
  }

  @Post('namespaces/:id/access')
  addAccessRule(
    @Param('id') namespaceId: string,
    @Body() body: { type: string; value: string; label?: string },
  ) {
    return this.adminService.addAccessRule(namespaceId, body as any);
  }

  @Delete('namespaces/:id/access/:ruleId')
  removeAccessRule(@Param('id') namespaceId: string, @Param('ruleId') ruleId: string) {
    return this.adminService.removeAccessRule(namespaceId, ruleId);
  }
}
