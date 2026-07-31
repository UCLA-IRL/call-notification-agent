import type { StatsDb } from '@/services/database/stats';
import type { ProjDbConstructor } from '@/services/database/proj_db';

declare global {
  // Global services
  interface OwnlyServices {
    stats: StatsDb;
    ProjDb: ProjDbConstructor;
  }

  // eslint-disable-next-line no-var
  var _o: OwnlyServices;
}
