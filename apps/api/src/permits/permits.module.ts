import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermitPdfService } from './permit-pdf.service';
import { PermitsController } from './permits.controller';
import { PermitsService } from './permits.service';

@Module({
  imports: [AuditModule],
  controllers: [PermitsController],
  providers: [PermitsService, PermitPdfService],
})
export class PermitsModule {}
