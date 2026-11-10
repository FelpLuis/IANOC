/**
 * CLI entrypoint: discover and scan every project under PROJECTS_ROOT.
 * Usage: npm run scan
 */

import 'dotenv/config';
import { scanner } from '../services/project-scanner.js';

async function main() {
  console.log(`[scan] Root: ${scanner.rootPath}`);

  const discovered = scanner.discoverProjects();
  if (discovered.length === 0) {
    console.error('[scan] No projects found. Check PROJECTS_ROOT in backend/.env');
    process.exit(1);
  }

  const results = await scanner.scanAllProjects();

  console.log('');
  console.log(`[scan] Done: ${results.length}/${discovered.length} project(s) scanned`);
  for (const result of results) {
    console.log(`  - ${result.projectId}: ${result.stats.totalFiles} files`);
  }
}

main().catch((error) => {
  console.error('[scan] Failed:', error);
  process.exit(1);
});
