import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const spec = parse(read('openapi.yaml'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// HTML-страницы мини-приложения — не API.
const PAGES = new Set(['/', '/app/', '/app/index.html']);

test('openapi.yaml описывает все маршруты сервера и только их', () => {
  const inCode = new Set<string>();
  for (const m of read('src/web/server.ts').matchAll(/\b(api|app)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*')/g)) {
    for (const p of m[3].match(/'[^']*'/g)!.map((s) => s.slice(1, -1))) {
      if (PAGES.has(p)) continue;
      inCode.add(`${m[2].toUpperCase()} ${m[1] === 'api' ? '/api' : ''}${p.replace(/:(\w+)/g, '{$1}')}`);
    }
  }
  const inSpec = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const method of METHODS) if (item[method]) inSpec.add(`${method.toUpperCase()} ${path}`);
  }
  assert.ok(inCode.size > 30, 'маршруты сервера нашлись');
  assert.deepEqual([...inCode].filter((r) => !inSpec.has(r)), [], 'маршруты без описания в openapi.yaml');
  assert.deepEqual([...inSpec].filter((r) => !inCode.has(r)), [], 'в openapi.yaml есть маршруты, которых нет на сервере');
});

test('openapi.yaml: версия как у сервиса, ссылки $ref ведут на существующие компоненты', () => {
  assert.match(spec.openapi, /^3\./);
  assert.equal(spec.info.version, JSON.parse(read('package.json')).version);
  const refs = JSON.stringify(spec).match(/"\$ref":"[^"]+"/g) ?? [];
  assert.ok(refs.length > 50);
  for (const r of refs) {
    const target = r.slice(8, -1).replace(/^#\//, '').split('/').reduce((o: any, k) => o?.[k], spec);
    assert.ok(target, `нет компонента ${r}`);
  }
  // У каждого пути с {параметром} параметр объявлен.
  for (const [path, item] of Object.entries(spec.paths as Record<string, any>)) {
    for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
      for (const method of METHODS.filter((m) => item[m])) {
        const params = [...(item.parameters ?? []), ...(item[method].parameters ?? [])].map((p: any) => (p.$ref ? p.$ref.split('/').reduce((o: any, k: string) => (k === '#' ? spec : o?.[k]), spec) : p));
        assert.ok(params.some((p: any) => p.in === 'path' && p.name === name), `${method.toUpperCase()} ${path}: не объявлен {${name}}`);
      }
    }
  }
});
