import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db, executorKey } from '../src/db/db.ts';

test('миграция: БД первой версии получает новые колонки и таблицы, данные сохраняются', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'vernem-mig-')), 'old.db');
  // Схема первой версии (без подъезда, председателя, актов, фото и уведомлений).
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT, state TEXT NOT NULL DEFAULT 'idle', state_data TEXT NOT NULL DEFAULT '{}',
      house_id INTEGER, fio TEXT, flat TEXT, account TEXT, save_personal INTEGER NOT NULL DEFAULT 0, house_chat_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE houses (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, address_norm TEXT NOT NULL UNIQUE, tz TEXT NOT NULL,
      electricity_variant TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, house_id INTEGER NOT NULL, service_key TEXT NOT NULL,
      reporter_user_id INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, ads_number TEXT, evidence TEXT NOT NULL, variant TEXT,
      demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE participants (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, own_ads_number TEXT, corner INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'tracking',
      bills TEXT NOT NULL DEFAULT '{}', calc TEXT, claim TEXT, refund_amount REAL, last_card_mid TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(incident_id, user_id));
    INSERT INTO users (id, first_name, house_id) VALUES (1, 'Влад', 1);
    INSERT INTO houses (address, address_norm, tz) VALUES ('ул. Примерная, 5', 'примерная5', 'Europe/Moscow');
  `);
  old.close();

  const db = new Db(path);
  const u = db.getUser(1)!;
  assert.equal(u.first_name, 'Влад');
  assert.equal(u.notify_house, 1, 'по умолчанию уведомления включены');
  assert.equal(u.entrance, null);
  const house = db.upsertHouse('Примерная 5', 'Europe/Moscow');
  assert.equal(house.id, 1);
  assert.ok(house.code, 'старому дому выдан код приглашения');
  assert.equal(db.getHouseByCode(house.code!)!.id, 1);
  assert.deepEqual(db.listPhotos(1), []);
  db.close();
});

test('ключ исполнителя: ИНН важнее названия, форма собственности и кавычки не мешают', () => {
  assert.equal(executorKey({ executor: 'ООО "УК Пример"' }), executorKey({ executor: 'УК «Пример»' }));
  assert.equal(executorKey({ executor: 'ООО "УК Пример"', executorInn: '7700000000' }), 'inn:7700000000');
  assert.equal(executorKey({}), null);
});
