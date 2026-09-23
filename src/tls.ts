import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tls from 'node:tls';

/**
 * Bot API MAX (platform-api2.max.ru, его использует SDK @maxhub/max-bot-api) работает
 * с сертификатом «Russian Trusted Root CA» Минцифры. Его нет в стандартном списке Node.js,
 * поэтому без этой функции любой запрос к MAX падает с UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
 *
 * Добавляем сертификат к стандартным корневым — только для процесса бота, не для всей системы.
 * Проверку сертификатов не отключаем (NODE_TLS_REJECT_UNAUTHORIZED=0 использовать нельзя).
 * Файл: assets/certs/russian_trusted_root_ca.pem, официальный источник — https://www.gosuslugi.ru/crt.
 */
export function trustRussianRootCa(path = process.env.RUSSIAN_CA_PATH?.trim() || resolve('assets/certs/russian_trusted_root_ca.pem')): string {
  if (!existsSync(path)) return `файл сертификата не найден (${path}) — запросы к MAX могут не пройти`;
  const pem = readFileSync(path, 'utf8').trim();
  const current = tls.getCACertificates('default');
  if (current.some((c) => c.trim() === pem)) return 'Russian Trusted Root CA уже в доверенных';
  tls.setDefaultCACertificates([...current, pem]);
  return 'Russian Trusted Root CA добавлен в доверенные';
}
