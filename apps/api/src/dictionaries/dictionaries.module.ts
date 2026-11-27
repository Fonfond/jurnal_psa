import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JournalsModule } from '../journals/journals.module';
import { DictionariesController } from './dictionaries.controller';
import { DictionariesService } from './dictionaries.service';

@Module({
  imports: [AuditModule, JournalsModule],
  controllers: [DictionariesController],
  providers: [DictionariesService],
})
export class DictionariesModule {}
