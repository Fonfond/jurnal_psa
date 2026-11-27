import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JournalsModule } from '../journals/journals.module';
import { SignatureModule } from '../signature/signature.module';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';

@Module({
  imports: [AuditModule, SignatureModule, JournalsModule],
  controllers: [JournalController],
  providers: [JournalService],
  exports: [JournalService],
})
export class JournalModule {}
