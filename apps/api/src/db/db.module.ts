import { Global, Module } from '@nestjs/common';
import { createSqlClient } from './client-factory';
import { DB } from './tokens';

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: () => createSqlClient(),
    },
  ],
  exports: [DB],
})
export class DbModule {}
