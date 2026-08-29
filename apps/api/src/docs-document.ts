import type { OpenAPIObject } from '@nestjs/swagger';

/** The built OpenAPI document, set once at bootstrap and served by DocsController. */
let document: OpenAPIObject | null = null;

export function setOpenApiDocument(doc: OpenAPIObject): void {
  document = doc;
}

export function getOpenApiDocument(): OpenAPIObject {
  if (!document) throw new Error('OpenAPI document has not been built yet');
  return document;
}
