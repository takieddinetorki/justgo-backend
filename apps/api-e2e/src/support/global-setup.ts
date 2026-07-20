/* eslint-disable */
import { waitForPortOpen } from '@nx/node/utils';

module.exports = async function () {
  // The api server is started by Nx via the e2e target's dependsOn
  // (@justgo-backend/api:serve) — we only wait for it to accept connections.
  const host = process.env.HOST ?? 'localhost';
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await waitForPortOpen(port, { host });
};
