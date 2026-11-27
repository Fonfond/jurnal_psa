import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GroundingsModule } from '../groundings/groundings.module';
import { JournalsModule } from '../journals/journals.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [AuditModule, JournalsModule, ShiftsModule, GroundingsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
