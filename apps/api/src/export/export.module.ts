import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JournalModule } from '../journal/journal.module';
import { JournalsModule } from '../journals/journals.module';
import { SignatureModule } from '../signature/signature.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { RetentionAlertService } from './retention-alert.service';
import { RetentionController } from './retention.controller';
import { RetentionSchedulerService } from './retention-scheduler.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [AuditModule, JournalModule, JournalsModule, SignatureModule],
  controllers: [ExportController, RetentionController],
  providers: [
    ExportService,
    RetentionService,
    RetentionAlertService,
    RetentionSchedulerService,
  ],
  exports: [RetentionService, RetentionAlertService],
})
export class ExportModule {}
