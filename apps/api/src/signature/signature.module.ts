import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SignatureController } from './signature.controller';
import { SignatureService } from './signature.service';

@Module({
  imports: [AuditModule],
  controllers: [SignatureController],
  providers: [SignatureService],
  exports: [SignatureService],
})
export class SignatureModule {}
