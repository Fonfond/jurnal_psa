import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JournalsModule } from '../journals/journals.module';
import { SignatureModule } from '../signature/signature.module';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

@Module({
  imports: [AuditModule, JournalsModule, SignatureModule],
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
