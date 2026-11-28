import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JournalModule } from '../journal/journal.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { ObjectStorageService } from './object-storage.service';

@Module({
  imports: [AuditModule, JournalModule],
  controllers: [AttachmentController],
  providers: [AttachmentService, ObjectStorageService],
  exports: [AttachmentService, ObjectStorageService],
})
export class AttachmentModule {}
