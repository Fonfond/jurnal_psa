import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JournalsModule } from '../journals/journals.module';
import { GroundingsController } from './groundings.controller';
import { GroundingsService } from './groundings.service';

@Module({
  imports: [AuditModule, JournalsModule],
  controllers: [GroundingsController],
  providers: [GroundingsService],
  exports: [GroundingsService],
})
export class GroundingsModule {}
