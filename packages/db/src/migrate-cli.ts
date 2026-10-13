// Migration CLI (CI deploy step only). Kept separate from migrate.ts so bundling the library never runs it.
import { migrate, setRolePasswords } from './migrate.ts';
const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_ADMIN_DATABASE_URL is required');
  process.exit(1);
}
migrate(url)
  .then(async a => {
    console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date');
    await setRolePasswords(url, {
      lg_app: process.env.LG_APP_PASSWORD,
      lg_scanner: process.env.LG_SCANNER_PASSWORD,
      lg_owner: process.env.LG_OWNER_PASSWORD,
    });
  })
  .catch(e => { console.error(e.message); process.exit(1); });
