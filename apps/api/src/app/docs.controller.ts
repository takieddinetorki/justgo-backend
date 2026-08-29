import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { Public } from '@justgo/auth';
import { getOpenApiDocument } from '../docs-document';

// webpack copies the swagger-ui-dist assets to dist/swagger-ui next to the
// bundle (see webpack.config.js). The output dir differs between `node
// dist/main.js`, `nx serve`, and a deploy, so probe the candidates for the
// actual assets rather than trusting a single (possibly webpack-rewritten)
// base path.
function findAssetDir(): string {
  const candidates = [
    join(dirname(process.argv[1] ?? ''), 'swagger-ui'),
    join(process.cwd(), 'apps/api/dist/swagger-ui'),
    join(process.cwd(), 'dist/swagger-ui'),
    join(process.cwd(), 'swagger-ui'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'swagger-ui.css'))) return dir;
  }
  return candidates[0];
}
const DIST = findAssetDir();

const CONTENT_TYPE: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>JustGo API</title>
  <link rel="stylesheet" href="/v1/docs-assets/swagger-ui.css" />
  <link rel="icon" href="/v1/docs-assets/favicon-32x32.png" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/v1/docs-assets/swagger-ui-bundle.js"></script>
  <script src="/v1/docs-assets/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/v1/docs-json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        persistAuthorization: true,
      });
    };
  </script>
</body>
</html>`;

/**
 * Self-hosted OpenAPI docs (§15). swagger-ui-express does not serve its
 * static assets under a prefixed path on Express 5, so we serve the whole
 * thing ourselves as first-class Nest routes: the UI page, the raw document,
 * and the swagger-ui-dist assets. All public — docs need no auth.
 */
@Controller()
export class DocsController {
  @Public()
  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  ui(): string {
    return HTML;
  }

  @Public()
  @Get('docs-json')
  json(): Record<string, unknown> {
    return getOpenApiDocument() as unknown as Record<string, unknown>;
  }

  @Public()
  @Get('docs-assets/*path')
  asset(@Req() req: Request, @Res() res: Response): void {
    const rel = req.path.replace(/^\/?v1\/docs-assets\/?/, '');
    const file = normalize(join(DIST, rel));
    // path-traversal guard: the resolved file must stay inside DIST
    if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found', details: {} } });
      return;
    }
    const ext = file.slice(file.lastIndexOf('.'));
    res.setHeader('content-type', CONTENT_TYPE[ext] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'public, max-age=86400');
    createReadStream(file).pipe(res);
  }
}
