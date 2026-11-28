import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AttachmentModule } from './attachments/attachment.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/response.interceptor';
import { DbModule } from './db/db.module';
import { DevicesModule } from './devices/devices.module';
import { DictionariesModule } from './dictionaries/dictionaries.module';
import { ExportModule } from './export/export.module';
import { GroundingsModule } from './groundings/groundings.module';
import { HealthModule } from './health/health.module';
import { JournalModule } from './journal/journal.module';
import { JournalsModule } from './journals/journals.module';
import { PermitsModule } from './permits/permits.module';
import { ShiftsModule } from './shifts/shifts.module';
import { SignatureModule } from './signature/signature.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    AttachmentModule,
    DevicesModule,
    JournalModule,
    JournalsModule,
    ShiftsModule,
    SignatureModule,
    SyncModule,
    PermitsModule,
    DictionariesModule,
    ExportModule,
    GroundingsModule,
    AuditModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
